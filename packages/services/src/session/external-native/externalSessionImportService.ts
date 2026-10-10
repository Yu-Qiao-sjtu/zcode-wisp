import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { sep } from "node:path";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import { EXTERNAL_MIGRATION_SOURCES } from "#src/session/external-native/externalImportedSessionTypes.js";
import { externalSessionImportRepo } from "#src/session/external-native/externalSessionImportRepo.js";
import { buildImportedExternalTaskFile } from "#src/session/external-native/buildImportedExternalTaskFile.js";
import { parseCodexSessionFile } from "#src/session/external-native/codexSessionParser.js";
import { parseKimiSessionFile } from "#src/session/external-native/kimiSessionParser.js";
import { parseGrokSessionFile } from "#src/session/external-native/grokSessionParser.js";
import { parseOpenCodeSessionFile } from "#src/session/external-native/opencodeSessionParser.js";
import {
  buildSearchableTextFromMessages,
  persistImportedClaudeTask,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";

const logger = createServiceLogger("external-native-import");

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function dirnameForOpenCodeRoot(sourcePath: string): string {
  // opencode 候选的 sourcePath 是 <root>/storage/message/<sessionId>，取 marker 前缀回到 root。
  const marker = `${sep}storage`;
  const markerIndex = sourcePath.lastIndexOf(marker);
  if (markerIndex < 0) {
    return sourcePath;
  }
  return sourcePath.slice(0, markerIndex);
}

async function parseExternalSource(params: {
  provider: ExternalImportedSessionSource["provider"];
  candidate: ZCodeImportableSessionCandidate;
  targetWorkspacePath: string;
}): Promise<ExternalImportedSessionSource> {
  const { candidate } = params;
  if (params.provider === "codex") {
    return parseCodexSessionFile({
      filePath: candidate.sourcePath,
      fallbackSessionId: candidate.sessionId,
      workspacePath: params.targetWorkspacePath,
      sourcePath: candidate.sourcePath,
      fallbackCreatedAt: candidate.createdAt,
      fallbackUpdatedAt: candidate.updatedAt,
    });
  }
  if (params.provider === "kimi") {
    return parseKimiSessionFile({
      sessionDir: candidate.sourcePath,
      sessionId: candidate.sessionId,
      workspacePath: params.targetWorkspacePath,
      sourcePath: candidate.sourcePath,
      fallbackCreatedAt: candidate.createdAt,
      fallbackUpdatedAt: candidate.updatedAt,
    });
  }
  if (params.provider === "grok") {
    return parseGrokSessionFile({
      sessionDir: candidate.sourcePath,
      sessionId: candidate.sessionId,
      workspacePath: params.targetWorkspacePath,
      sourcePath: candidate.sourcePath,
      fallbackCreatedAt: candidate.createdAt,
      fallbackUpdatedAt: candidate.updatedAt,
    });
  }
  return parseOpenCodeSessionFile({
    opencodeRoot: dirnameForOpenCodeRoot(candidate.sourcePath),
    sessionId: candidate.sessionId,
    workspacePath: params.targetWorkspacePath,
    head: {
      sessionId: candidate.sessionId,
      workspacePath: candidate.workspacePath,
      title: candidate.previewTitle,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    },
  });
}

export async function importExternalSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  provider: ExternalImportedSessionSource["provider"];
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession?: (source: ExternalImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}): Promise<ZCodeImportSessionsResult> {
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
  const migrationSource = EXTERNAL_MIGRATION_SOURCES[params.provider];
  const result: ZCodeImportSessionsResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入 ${params.provider} 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  for (const sessionId of normalizedSessionIds) {
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = await externalSessionImportRepo.findImportableSession({
        provider: params.provider,
        workspacePath: params.workspacePath,
        sessionId,
      });
      if (!candidate) {
        result.skipped.push({
          provider: params.provider,
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath || params.workspacePath;
      if (!importedWorkspacePath) {
        result.skipped.push({
          provider: params.provider,
          sessionId,
          reason: "workspace_path_unknown",
        });
        continue;
      }
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: params.provider,
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const importedSource = await parseExternalSource({
        provider: params.provider,
        candidate,
        targetWorkspacePath: importedWorkspacePath,
      });
      importedWorkspacePath = importedSource.workspacePath;

      let meta: ZCodeTaskMeta;
      if (params.createImportedSession) {
        meta = await params.createImportedSession(importedSource);
        meta = await params.taskIndexRepo.syncTaskMeta({
          meta: {
            ...meta,
            migrationSource,
            workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
          },
          searchableText: buildSearchableTextFromMessages(importedSource.messages),
          // 重导入要能从删除/归档状态恢复到列表，语义与 claude-native 一致。
          archived: false,
          deleted: false,
        });
      } else {
        const sessionFile = buildImportedExternalTaskFile(importedSource);
        meta = await persistImportedClaudeTask({
          taskIndexRepo: params.taskIndexRepo,
          sessionFile,
          workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
        });
      }
      params.onTaskImported(meta);

      result.imported.push({
        provider: params.provider,
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 ${params.provider} session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: params.provider,
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `${params.provider} session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
