import type { IRemoteBackend } from "@zcode/server/remote";
import type {
  RemoteLoopbackUrlResolveRequest,
  RemoteLoopbackUrlResolveResult,
} from "@zcode/shared";

/** 隧道空闲超过该时长后由后台扫描关闭，避免浏览器一次性访问后长期占用本机端口。 */
const TUNNEL_IDLE_TTL_MS = 10 * 60 * 1000;
/** 建好隧道后对远端服务的就绪探测上限；Jupyter 首次启动可能较慢。 */
const READINESS_PROBE_TIMEOUT_MS = 8000;
/** 先探测本机是否已能直达（WSL2 localhost 转发 / 用户自建转发），避免多余隧道。 */
const DIRECT_PROBE_TIMEOUT_MS = 1200;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface ActiveTunnel {
  backend: Pick<IRemoteBackend, "openLoopbackForward" | "closeLoopbackForward">;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  lastUsedAt: number;
}

export interface RemoteLoopbackResolverDeps {
  resolveBackend(scope: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Pick<IRemoteBackend, "openLoopbackForward" | "closeLoopbackForward"> | undefined;
  resolveTargetKind(remoteSessionId: string): string | undefined;
  logInfo?(message: string, details?: Record<string, unknown>): void;
  logWarn?(message: string, details?: unknown): void;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function probeHttpOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 任意 HTTP 状态（含 401/302/404）都证明端口上有活着的 HTTP 服务。
    void response;
    return true;
  } catch {
    return false;
  }
}

/**
 * 远端 loopback URL → 本机隧道 URL 解析器。
 * 只处理 http(s) + loopback + SSH workspace 的组合；WSL2 依赖宿主 localhost 转发，
 * Docker 场景 v1 保持原样。隧道按 (remoteSessionId, remotePort) 复用，空闲 TTL 回收。
 */
export function createRemoteLoopbackUrlResolver(deps: RemoteLoopbackResolverDeps) {
  const activeTunnels = new Map<string, ActiveTunnel>();
  const sweeping = setInterval(() => {
    const now = Date.now();
    for (const [key, tunnel] of activeTunnels) {
      if (now - tunnel.lastUsedAt < TUNNEL_IDLE_TTL_MS) {
        continue;
      }
      activeTunnels.delete(key);
      void tunnel.backend
        .closeLoopbackForward?.({ remoteHost: tunnel.remoteHost, remotePort: tunnel.remotePort })
        .catch((error: unknown) => {
          deps.logWarn?.("[remote-loopback] 关闭空闲隧道失败", error);
        });
    }
  }, SWEEP_INTERVAL_MS);
  // Host 进程退出不需要等这个 timer。
  (sweeping as unknown as { unref?: () => void }).unref?.();

  async function resolve(
    params: RemoteLoopbackUrlResolveRequest,
  ): Promise<RemoteLoopbackUrlResolveResult> {
    let parsed: URL;
    try {
      parsed = new URL(params.url);
    } catch {
      return { url: params.url, tunneled: false };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url: params.url, tunneled: false };
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      return { url: params.url, tunneled: false };
    }
    const remotePort = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isFinite(remotePort) || remotePort <= 0) {
      return { url: params.url, tunneled: false };
    }
    if (!params.remoteSessionId || !params.workspacePath || !params.workspaceIdentity) {
      // scope 不完整时无法定位连接；保持原 URL 让浏览器自行失败，不在 Host 侧猜。
      return { url: params.url, tunneled: false };
    }

    const targetKind = deps.resolveTargetKind(params.remoteSessionId);
    if (targetKind && targetKind !== "ssh") {
      // WSL2 的 localhost 转发 / Docker 端口映射通常已把服务暴露到本机。
      return { url: params.url, tunneled: false };
    }

    // 服务已经在本机可达（直连或既有转发）时不再建隧道。
    const directUrl = `${parsed.protocol}//127.0.0.1:${remotePort}${parsed.pathname}`;
    if (await probeHttpOk(directUrl, DIRECT_PROBE_TIMEOUT_MS)) {
      return { url: params.url, tunneled: false };
    }

    const backend = deps.resolveBackend({
      remoteSessionId: params.remoteSessionId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    if (!backend?.openLoopbackForward) {
      return { url: params.url, tunneled: false };
    }

    const tunnelKey = `${params.remoteSessionId}:${remotePort}`;
    try {
      let tunnel = activeTunnels.get(tunnelKey);
      if (!tunnel) {
        const opened = await backend.openLoopbackForward({
          remoteHost: "127.0.0.1",
          remotePort,
          preferredLocalPort: remotePort,
        });
        tunnel = {
          backend,
          remoteHost: "127.0.0.1",
          remotePort,
          localPort: opened.localPort,
          lastUsedAt: Date.now(),
        };
        activeTunnels.set(tunnelKey, tunnel);
        deps.logInfo?.("[remote-loopback] 已建立 SSH 回环隧道", {
          remoteSessionId: params.remoteSessionId,
          remotePort,
          localPort: opened.localPort,
        });
      }
      tunnel.lastUsedAt = Date.now();

      const tunneledUrl = `${parsed.protocol}//127.0.0.1:${tunnel.localPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
      // 就绪探测失败不阻断打开：部分服务首次访问才初始化。
      void probeHttpOk(
        `${parsed.protocol}//127.0.0.1:${tunnel.localPort}${parsed.pathname}`,
        READINESS_PROBE_TIMEOUT_MS,
      );
      return { url: tunneledUrl, tunneled: true };
    } catch (error) {
      deps.logWarn?.("[remote-loopback] 建立隧道失败，回退原始 URL", error);
      return { url: params.url, tunneled: false };
    }
  }

  return resolve;
}
