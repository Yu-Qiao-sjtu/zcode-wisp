import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PortForwardRule } from "@zcode/shared";
import { portForwardRuleSchema } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";

const STORE_VERSION = 1;

interface PortForwardStoreFile {
  version: number;
  rules: PortForwardRule[];
}

function getStoreFilePath(): string {
  return join(getAppConfigDir(), "port-forward-rules.json");
}

/**
 * 规则持久化到 <configDir>/port-forward-rules.json；
 * 写入统一走临时文件 + rename 原子替换，避免半写状态被下次启动读到。
 */
export class PortForwardStore {
  async loadRules(): Promise<PortForwardRule[]> {
    let raw: string;
    try {
      raw = await readFile(getStoreFilePath(), "utf-8");
    } catch {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PortForwardStoreFile>;
      if (!Array.isArray(parsed.rules)) {
        return [];
      }
      const rules: PortForwardRule[] = [];
      for (const candidate of parsed.rules) {
        const validated = portForwardRuleSchema.safeParse(candidate);
        // 单条非法不拖垮整库：跳过并让下次保存自然剔除。
        if (validated.success) {
          rules.push(validated.data);
        }
      }
      return rules;
    } catch {
      return [];
    }
  }

  async saveRules(rules: readonly PortForwardRule[]): Promise<void> {
    const filePath = getStoreFilePath();
    const payload: PortForwardStoreFile = {
      version: STORE_VERSION,
      rules: [...rules],
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, serialized, "utf-8");
    await rename(tempPath, filePath);
  }
}
