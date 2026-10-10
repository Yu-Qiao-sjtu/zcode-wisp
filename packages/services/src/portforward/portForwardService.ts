import { randomUUID } from "node:crypto";
import type {
  PortForwardCredential,
  PortForwardRule,
  PortForwardRuntimeStatus,
} from "@zcode/shared";
import { isPortForwardLoopbackHost, portForwardRuleUpsertSchema } from "@zcode/shared";
import type { PortForwardRuleUpsert } from "@zcode/shared";
import { PortForwardEngine } from "#src/portforward/portForwardEngine.js";
import { PortForwardStore } from "#src/portforward/portForwardStore.js";

/**
 * 端口转发管理服务：规则 CRUD + 运行时生命周期。
 * Host 进程内单例；规则全局生效，不绑定某个 workspace。
 * 密码类凭据只在 start 调用链内存活，不写任何存储。
 */
export class PortForwardService {
  private readonly store = new PortForwardStore();
  private readonly engine = new PortForwardEngine();
  private rulesPromise: Promise<PortForwardRule[]> | null = null;
  private autoStartDone = false;

  readonly onDidChangeStatus = this.engine.onDidChangeStatus;

  private async getRules(): Promise<PortForwardRule[]> {
    this.rulesPromise ??= this.store.loadRules();
    return this.rulesPromise;
  }

  private async persistRules(rules: readonly PortForwardRule[]): Promise<void> {
    await this.store.saveRules(rules);
    this.rulesPromise = Promise.resolve([...rules]);
  }

  async listRules(): Promise<PortForwardRule[]> {
    return this.getRules();
  }

  async getStatuses(): Promise<PortForwardRuntimeStatus[]> {
    return this.engine.getStatuses();
  }

  async saveRule(input: PortForwardRuleUpsert): Promise<PortForwardRule> {
    const validated = portForwardRuleUpsertSchema.parse(input);
    if (
      !isPortForwardLoopbackHost(validated.localHost) ||
      !isPortForwardLoopbackHost(validated.remoteHost)
    ) {
      throw new Error("端口转发只允许 loopback 主机（127.0.0.1 / localhost / ::1）");
    }
    const rules = await this.getRules();
    const now = Date.now();
    const existing = validated.ruleId
      ? rules.find((rule) => rule.ruleId === validated.ruleId)
      : undefined;
    if (validated.ruleId && !existing) {
      throw new Error(`端口转发规则不存在: ${validated.ruleId}`);
    }
    const ruleId = existing?.ruleId ?? randomUUID();
    const next: PortForwardRule = {
      ...validated,
      ruleId,
      enabled: validated.enabled ?? existing?.enabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const nextRules = existing
      ? rules.map((rule) => (rule.ruleId === ruleId ? next : rule))
      : [...rules, next];
    await this.persistRules(nextRules);

    // 规则定义变化时，正在运行的旧实例必须立刻停掉，避免旧配置继续转发。
    if (this.engine.getStatus(ruleId)) {
      await this.engine.stop(ruleId);
    }
    if (next.enabled) {
      void this.engine.start(next).catch(() => {
        // 状态机已把失败写入 error 状态，这里不再抛出阻断保存。
      });
    }
    return next;
  }

  async deleteRule(ruleId: string): Promise<void> {
    const rules = await this.getRules();
    await this.persistRules(rules.filter((rule) => rule.ruleId !== ruleId));
    await this.engine.stop(ruleId);
  }

  async setRuleEnabled(
    ruleId: string,
    enabled: boolean,
    credential?: PortForwardCredential,
  ): Promise<PortForwardRuntimeStatus | undefined> {
    const rules = await this.getRules();
    const rule = rules.find((candidate) => candidate.ruleId === ruleId);
    if (!rule) {
      throw new Error(`端口转发规则不存在: ${ruleId}`);
    }

    if (!enabled) {
      await this.persistRules(
        rules.map((candidate) =>
          candidate.ruleId === ruleId
            ? { ...candidate, enabled: false, updatedAt: Date.now() }
            : candidate,
        ),
      );
      await this.engine.stop(ruleId);
      return this.engine.getStatus(ruleId);
    }

    if (!rule.enabled) {
      await this.persistRules(
        rules.map((candidate) =>
          candidate.ruleId === ruleId
            ? { ...candidate, enabled: true, updatedAt: Date.now() }
            : candidate,
        ),
      );
    }
    const status = await this.engine.start(rule, credential);
    return status;
  }

  /** Host 启动后调用一次：把 enabled+autoStart 的规则拉起来。 */
  async autoStartRules(): Promise<void> {
    if (this.autoStartDone) {
      return;
    }
    this.autoStartDone = true;
    const rules = await this.getRules();
    for (const rule of rules) {
      if (!rule.enabled || !rule.autoStart) {
        continue;
      }
      void this.engine.start(rule).catch(() => {
        // 失败进入 error 状态即可，不阻断其它规则。
      });
    }
  }

  async stopAll(): Promise<void> {
    await this.engine.stopAll();
  }
}

/** Host 进程级单例：desktop host / server 共享同一份规则与运行时。 */
export const portForwardService = new PortForwardService();
