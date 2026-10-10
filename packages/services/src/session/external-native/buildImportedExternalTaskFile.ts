import { createHash } from "node:crypto";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { generateTraceId } from "@zcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import { EXTERNAL_MIGRATION_SOURCES } from "#src/session/external-native/externalImportedSessionTypes.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  filterImportedClaudeTaskFilePaths,
} from "#src/session/claude-native/importedClaudeTaskFileFilter.js";

export function buildImportedExternalTaskId(
  provider: ExternalImportedSessionSource["provider"],
  workspacePath: string,
  sessionId: string,
): string {
  const digest = createHash("sha256")
    .update(`${provider}:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `${provider}-import-${digest}`;
}

export function buildImportedExternalTaskFile(
  source: ExternalImportedSessionSource,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
  if (source.messages.length === 0) {
    throw new Error(`[external-native] external session ${source.sessionId} 没有可导入的可见消息`);
  }

  const taskId =
    taskIdOverride ??
    buildImportedExternalTaskId(source.provider, source.workspacePath, source.sessionId);
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : source.updatedAt;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;

  const explicitTitle = source.title?.trim();
  const title =
    explicitTitle ||
    deriveSessionTitle(
      source.messages.find((message) => message.role === "user" && message.content.trim())
        ?.content ?? "",
      [],
    ) ||
    "Imported session";

  const meta: ZCodeTaskMeta = {
    taskId,
    traceId: generateTraceId(taskId),
    title,
    workspacePath: source.workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    mode: "build",
    migrationSource: EXTERNAL_MIGRATION_SOURCES[source.provider],
    status: "completed",
    ...(source.model ? { model: source.model } : {}),
  };

  const taskFile: LegacyTaskSessionFile = {
    meta,
    messages: [...source.messages],
  };

  // 与 claude-native 同一清洗边界：来源端运行态 model/mode/provider 不写入 ZCode snapshot。
  return filterImportedClaudeTaskFilePaths(taskFile, DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS);
}
