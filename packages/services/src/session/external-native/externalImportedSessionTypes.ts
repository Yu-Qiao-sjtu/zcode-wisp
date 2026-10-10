import type {
  ZCodeImportSessionSourceProvider,
  ZCodePersistedMessage,
  ZCodeTaskMigrationSource,
} from "@zcode/shared";

/** 除 Claude Code 之外的外部 CLI 导入来源；导入管线与 claude-native 同构。 */
export type ExternalImportSourceProvider = Exclude<ZCodeImportSessionSourceProvider, "claude">;

export const EXTERNAL_IMPORT_SOURCE_PROVIDERS = [
  "codex",
  "kimi",
  "opencode",
  "grok",
] as const satisfies readonly ExternalImportSourceProvider[];

/** provider → ZCodeTaskMigrationSource；命名与 settings-sync 的 agent 标识保持一致。 */
export const EXTERNAL_MIGRATION_SOURCES: Record<
  ExternalImportSourceProvider,
  ZCodeTaskMigrationSource
> = {
  codex: "codexCli",
  kimi: "kimiCode",
  opencode: "openCode",
  grok: "grokCli",
};

export function isExternalImportSourceProvider(
  value: string,
): value is ExternalImportSourceProvider {
  return (EXTERNAL_IMPORT_SOURCE_PROVIDERS as readonly string[]).includes(value);
}

export interface ExternalImportedSessionSource {
  provider: ExternalImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  migrationSource: ZCodeTaskMigrationSource;
  messages: ZCodePersistedMessage[];
}
