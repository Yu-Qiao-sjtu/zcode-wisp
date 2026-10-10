import { z } from "zod";

/** 转发方向：local = 本机访问远端服务（-L）；reverse = 远端回访本机服务（-R）。 */
export type PortForwardDirection = "local" | "reverse";

export type PortForwardRuntimeState = "stopped" | "starting" | "running" | "error";

export function isPortForwardLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export const portForwardRuleSchema = z
  .object({
    ruleId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    /** SSH 连接目标；出于安全边界不含密码/口令，连接期凭据只在内存里。 */
    target: z
      .object({
        host: z.string().trim().min(1),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().trim().min(1),
        privateKeyPath: z.string().trim().optional(),
        sshConfigAlias: z.string().trim().optional(),
      })
      .strict(),
    direction: z.enum(["local", "reverse"]),
    localHost: z.string().trim().toLowerCase(),
    localPort: z.number().int().min(1).max(65535),
    /** reverse 规则的 remote 侧是远端 sshd 监听地址，同样收敛为 loopback。 */
    remoteHost: z.string().trim().toLowerCase(),
    remotePort: z.number().int().min(1).max(65535),
    enabled: z.boolean(),
    autoStart: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type PortForwardRule = z.infer<typeof portForwardRuleSchema>;

export const portForwardRuleInputSchema = portForwardRuleSchema.omit({
  ruleId: true,
  createdAt: true,
  updatedAt: true,
});
export type PortForwardRuleInput = z.infer<typeof portForwardRuleInputSchema>;

/** upsert 语义：带 ruleId 为更新，缺省为新建。 */
export const portForwardRuleUpsertSchema = portForwardRuleInputSchema.extend({
  ruleId: z.string().trim().min(1).optional(),
});
export type PortForwardRuleUpsert = z.infer<typeof portForwardRuleUpsertSchema>;

export interface PortForwardRuntimeStatus {
  ruleId: string;
  state: PortForwardRuntimeState;
  /** starting/running 阶段对 local 规则可能是协商后的真实监听端口。 */
  message?: string;
  since: number;
}

/** 启动时临时注入的连接凭据；只保存在内存，绝不落盘。 */
export interface PortForwardCredential {
  password?: string;
  privateKeyPassphrase?: string;
}

/** 渲染层请求把远端 loopback URL 重写为本机隧道 URL；scope 用于定位已建立的远程连接。 */
export interface RemoteLoopbackUrlResolveRequest {
  /** 远端 workspace 的 key（与侧栏/面板使用的 workspaceKey 一致）。 */
  workspaceKey: string;
  remoteSessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  url: string;
}

export interface RemoteLoopbackUrlResolveResult {
  url: string;
  /** true 表示 url 已重写为经 SSH 隧道的本机地址。 */
  tunneled: boolean;
}
