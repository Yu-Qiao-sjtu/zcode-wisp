import { readFile } from "node:fs/promises";
import net from "node:net";
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { Emitter } from "@zcode/rpc";
import type {
  PortForwardCredential,
  PortForwardRule,
  PortForwardRuntimeState,
  PortForwardRuntimeStatus,
} from "@zcode/shared";
import { isPortForwardLoopbackHost, portForwardRuleSchema } from "@zcode/shared";

/** 与 server/sshAuth 一致的握手/保活口径：弱网不误判超时，NAT 静默断连可感知。 */
const SSH_READY_TIMEOUT_MS = 30_000;
const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

export function isLoopbackHost(host: string): boolean {
  return isPortForwardLoopbackHost(host);
}

export function assertPortForwardRuleLoopbackSafety(rule: PortForwardRule): void {
  if (!isLoopbackHost(rule.localHost)) {
    throw new Error(`端口转发只允许 loopback 本机地址，收到 ${rule.localHost}`);
  }
  if (!isLoopbackHost(rule.remoteHost)) {
    throw new Error(`端口转发只允许 loopback 远端地址，收到 ${rule.remoteHost}`);
  }
  const parsed = portForwardRuleSchema.safeParse(rule);
  if (!parsed.success) {
    throw new Error(`端口转发规则非法：${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
}

interface PortForwardRuntime {
  rule: PortForwardRule;
  status: PortForwardRuntimeStatus;
  client?: SSHClient;
  localServer?: net.Server;
  credential?: PortForwardCredential;
}

async function readPrivateKey(rule: PortForwardRule): Promise<string | undefined> {
  if (!rule.target.privateKeyPath) {
    return undefined;
  }
  return readFile(rule.target.privateKeyPath, "utf-8");
}

function buildConnectConfig(
  rule: PortForwardRule,
  credential: PortForwardCredential | undefined,
  privateKey: string | undefined,
): ConnectConfig {
  const password = credential?.password;
  const passphrase = credential?.privateKeyPassphrase;
  const hasPassword = typeof password === "string" && password.length > 0;
  return {
    host: rule.target.host,
    port: rule.target.port ?? 22,
    username: rule.target.username,
    // 有密码时禁用隐式 agent：避免 MaxAuthTries 小的主机在公钥阶段耗尽认证次数。
    agent: hasPassword ? undefined : process.env["SSH_AUTH_SOCK"],
    privateKey,
    passphrase,
    password: hasPassword ? password : undefined,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    tryKeyboard: hasPassword,
  };
}

function connectSSHClient(
  config: ConnectConfig,
  onUnexpectedClose: () => void,
): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const password = typeof config.password === "string" ? config.password : undefined;
    const client = new SSHClient();
    let settled = false;
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      const normalized =
        error instanceof Error ? error : new Error(String(error ?? "SSH 连接失败"));
      const withLevel = normalized as Error & { level?: string };
      if (withLevel.level === "client-authentication") {
        reject(new Error("SSH 认证失败：请检查用户名、密码或私钥配置"));
        return;
      }
      if (withLevel.level === "client-timeout") {
        reject(new Error(`SSH 连接超时：${ruleHostOf(config)}`));
        return;
      }
      reject(normalized);
    };
    client.on("error", fail);
    client.on("close", () => {
      if (!settled) {
        fail(new Error("SSH 连接在握手完成前关闭"));
        return;
      }
      onUnexpectedClose();
    });
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(password && prompts.length > 0 ? prompts.map(() => password) : []);
    });
    client.connect(config);
  });
}

function ruleHostOf(config: ConnectConfig): string {
  return `${config.username}@${config.host}:${config.port ?? 22}`;
}

/**
 * 每条规则独占一个 SSH 连接，互不影响生命周期；
 * 状态只在 starting/running/error/stopped 间迁移，并通过 onDidChangeStatus 广播。
 */
export class PortForwardEngine {
  private readonly runtimes = new Map<string, PortForwardRuntime>();
  private readonly statusEmitter = new Emitter<PortForwardRuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  getStatuses(): PortForwardRuntimeStatus[] {
    return [...this.runtimes.values()].map((runtime) => ({ ...runtime.status }));
  }

  getStatus(ruleId: string): PortForwardRuntimeStatus | undefined {
    const runtime = this.runtimes.get(ruleId);
    return runtime ? { ...runtime.status } : undefined;
  }

  private setStatus(ruleId: string, state: PortForwardRuntimeState, message?: string): void {
    const runtime = this.runtimes.get(ruleId);
    if (!runtime) {
      return;
    }
    runtime.status = {
      ruleId,
      state,
      ...(message !== undefined ? { message } : {}),
      since: Date.now(),
    };
    this.statusEmitter.fire({ ...runtime.status });
  }

  async start(
    rule: PortForwardRule,
    credential?: PortForwardCredential,
  ): Promise<PortForwardRuntimeStatus> {
    if (this.runtimes.has(rule.ruleId)) {
      await this.stop(rule.ruleId);
    }
    assertPortForwardRuleLoopbackSafety(rule);

    const runtime: PortForwardRuntime = {
      rule,
      status: { ruleId: rule.ruleId, state: "starting", since: Date.now() },
      ...(credential ? { credential } : {}),
    };
    this.runtimes.set(rule.ruleId, runtime);
    this.statusEmitter.fire({ ...runtime.status });

    try {
      const privateKey = await readPrivateKey(rule);
      const client = await connectSSHClient(
        buildConnectConfig(rule, credential, privateKey),
        () => {
          // 底层连接意外断开：清理本地监听并标记 error，等待用户或 autostart 重新拉起。
          void this.handleConnectionLost(rule.ruleId);
        },
      );
      runtime.client = client;

      if (rule.direction === "local") {
        await this.startLocalForward(runtime, client);
      } else {
        this.startReverseForward(runtime, client);
      }
      this.setStatus(rule.ruleId, "running");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.teardownRuntime(runtime);
      this.setStatus(rule.ruleId, "error", message);
    }
    return { ...this.runtimes.get(rule.ruleId)!.status };
  }

  private async startLocalForward(runtime: PortForwardRuntime, client: SSHClient): Promise<void> {
    const { rule } = runtime;
    const server = net.createServer((socket) => {
      socket.pause();
      client.forwardOut(
        socket.remoteAddress ?? "127.0.0.1",
        socket.remotePort ?? 0,
        rule.remoteHost,
        rule.remotePort,
        (error, channel) => {
          if (error || !channel) {
            socket.destroy();
            return;
          }
          socket.resume();
          socket.pipe(channel).pipe(socket);
          const closeBoth = (): void => {
            socket.destroy();
            channel.close();
          };
          socket.on("error", closeBoth);
          channel.on("error", closeBoth);
          socket.on("close", () => channel.end());
          channel.on("close", () => socket.destroy());
        },
      );
    });
    runtime.localServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once("error", onError);
      server.listen(rule.localPort, rule.localHost, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  private startReverseForward(runtime: PortForwardRuntime, client: SSHClient): void {
    const { rule } = runtime;
    // 监听回调必须先于 forwardIn 注册：远端建连可能在 bind 确认返回前就进来。
    client.on("tcp connection", (info, accept, reject) => {
      if (info.destPort !== rule.remotePort) {
        reject();
        return;
      }
      const channel = accept();
      const local = net.connect({
        host: rule.localHost,
        port: rule.localPort,
      });
      channel.pipe(local).pipe(channel);
      const closeBoth = (): void => {
        local.destroy();
        channel.close();
      };
      local.on("error", closeBoth);
      channel.on("error", closeBoth);
      channel.on("close", () => local.destroy());
      local.on("close", () => channel.close());
    });
    client.forwardIn(rule.remoteHost, rule.remotePort, (error) => {
      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.teardownRuntime(runtime);
        this.setStatus(rule.ruleId, "error", `远端监听失败：${message}`);
      }
    });
  }

  private async handleConnectionLost(ruleId: string): Promise<void> {
    const runtime = this.runtimes.get(ruleId);
    if (!runtime) {
      return;
    }
    const wasRunning = runtime.status.state === "running" || runtime.status.state === "starting";
    this.teardownRuntime(runtime);
    if (wasRunning) {
      this.setStatus(ruleId, "error", "SSH 连接已断开");
    }
  }

  private teardownRuntime(runtime: PortForwardRuntime): void {
    const { rule } = runtime;
    if (runtime.localServer) {
      try {
        runtime.localServer.close();
      } catch {
        // 监听可能尚未启动，忽略。
      }
      runtime.localServer = undefined;
    }
    if (runtime.client) {
      const client = runtime.client;
      runtime.client = undefined;
      try {
        if (rule.direction === "reverse") {
          client.unforwardIn(rule.remoteHost, rule.remotePort, () => {
            client.end();
          });
          return;
        }
        client.end();
      } catch {
        try {
          client.end();
        } catch {
          // 连接可能已经死亡。
        }
      }
    }
  }

  async stop(ruleId: string): Promise<void> {
    const runtime = this.runtimes.get(ruleId);
    if (!runtime) {
      return;
    }
    this.teardownRuntime(runtime);
    this.runtimes.delete(ruleId);
  }

  async stopAll(): Promise<void> {
    // Map 迭代中删除当前 key 是安全的；stop() 只删除自己这条。
    for (const ruleId of this.runtimes.keys()) {
      await this.stop(ruleId);
    }
  }
}
