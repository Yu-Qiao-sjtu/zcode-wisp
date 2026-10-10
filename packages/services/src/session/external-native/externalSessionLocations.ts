import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir } from "#src/paths.js";
import type { ExternalImportSourceProvider } from "#src/session/external-native/externalImportedSessionTypes.js";

/**
 * 外部 CLI 历史目录约定（与 WispTerm 对齐）：
 * - Codex CLI:      ~/.codex/sessions
 * - Kimi Code:      ~/.kimi-code/sessions
 * - OpenCode:       ~/.local/share/opencode
 * - Grok CLI:       ~/.grok/sessions
 * 扫描始终针对“服务运行所在的机器”；远程 workspace 下服务跑在远端，天然覆盖远程历史。
 */
export function getExternalSessionRoots(provider: ExternalImportSourceProvider): string[] {
  const homes = new Set<string>();
  homes.add(homedir());

  const envHome = process.env.HOME?.trim();
  if (envHome) {
    homes.add(envHome);
  }

  const dataBaseDir = getDataBaseDir();
  if (dataBaseDir) {
    homes.add(dataBaseDir);
  }

  return [...homes].map((homePath) => join(homePath, EXTERNAL_SESSION_ROOT_SEGMENTS[provider]));
}

const EXTERNAL_SESSION_ROOT_SEGMENTS: Record<ExternalImportSourceProvider, string> = {
  codex: join(".codex", "sessions"),
  kimi: join(".kimi-code", "sessions"),
  opencode: join(".local", "share", "opencode"),
  grok: join(".grok", "sessions"),
} as const;
