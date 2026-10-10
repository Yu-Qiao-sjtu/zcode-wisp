import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import {
  extractExternalTurn,
  readFirstTimestamp,
} from "#src/session/external-native/externalSessionRecords.js";
import { readExternalJsonLinesFile } from "#src/session/external-native/externalJsonl.js";

export function getGrokSummaryPath(sessionDir: string): string {
  return join(sessionDir, "summary.json");
}

export function getGrokUpdatesPath(sessionDir: string): string {
  return join(sessionDir, "updates.jsonl");
}

async function readGrokSummary(sessionDir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getGrokSummaryPath(sessionDir), "utf-8"));
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface GrokSessionHeadInfo {
  sessionId?: string;
  workspacePath?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Grok 会话目录以 summary.json 为元数据源；updates.jsonl 只在导入时解析。 */
export async function readGrokSessionHeadInfo(sessionDir: string): Promise<GrokSessionHeadInfo> {
  const summary = await readGrokSummary(sessionDir);
  if (!summary) {
    return {};
  }
  return {
    sessionId:
      readTrimmedString(summary.sessionId) ??
      readTrimmedString(summary.session_id) ??
      readTrimmedString(summary.id),
    workspacePath:
      readTrimmedString(summary.cwd) ??
      readTrimmedString(summary.projectDir) ??
      readTrimmedString(summary.workingDirectory),
    title: readTrimmedString(summary.title) ?? readTrimmedString(summary.name),
    createdAt: readFirstTimestamp([summary.createdAt, summary.created_at, summary.startTime]),
    updatedAt: readFirstTimestamp([summary.updatedAt, summary.updated_at, summary.lastActivity]),
  };
}

export async function parseGrokSessionFile(params: {
  sessionDir: string;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ExternalImportedSessionSource> {
  const [summary, updatesStat, records] = await Promise.all([
    readGrokSummary(params.sessionDir),
    stat(getGrokUpdatesPath(params.sessionDir)),
    readExternalJsonLinesFile(getGrokUpdatesPath(params.sessionDir)),
  ]);

  const messages: ExternalImportedSessionSource["messages"] = [];
  let turnIndex = -1;
  let pendingAssistantText: string | undefined;
  let pendingAssistantTimestamp: number | undefined;

  const flushAssistant = () => {
    if (!pendingAssistantText) {
      return;
    }
    messages.push({
      role: "assistant",
      content: pendingAssistantText,
      timestamp: pendingAssistantTimestamp ?? params.fallbackUpdatedAt ?? Date.now(),
      turnIndex,
    });
    pendingAssistantText = undefined;
    pendingAssistantTimestamp = undefined;
  };

  for (const record of records) {
    const turn = extractExternalTurn(record);
    if (!turn) {
      continue;
    }
    const timestamp = readFirstTimestamp([record.timestamp, record.time, record.created_at]);
    if (turn.role === "user") {
      flushAssistant();
      turnIndex += 1;
      messages.push({
        role: "user",
        content: turn.text,
        timestamp: timestamp ?? params.fallbackCreatedAt ?? Date.now(),
        turnIndex,
      });
      continue;
    }
    pendingAssistantText = pendingAssistantText
      ? `${pendingAssistantText}\n\n${turn.text}`
      : turn.text;
    pendingAssistantTimestamp = timestamp ?? pendingAssistantTimestamp;
  }
  flushAssistant();

  if (messages.length === 0) {
    throw new Error(`[external-native] Grok session ${params.sessionId} 没有可导入的可见消息`);
  }

  const timestamps = messages.map((message) => message.timestamp);
  const summaryCwd = summary
    ? (readTrimmedString(summary.cwd) ??
      readTrimmedString(summary.projectDir) ??
      readTrimmedString(summary.workingDirectory))
    : undefined;
  const createdAt =
    (summary ? readFirstTimestamp([summary.createdAt, summary.created_at]) : undefined) ??
    params.fallbackCreatedAt ??
    Math.min(...timestamps);
  const updatedAt =
    (summary ? readFirstTimestamp([summary.updatedAt, summary.updated_at]) : undefined) ??
    params.fallbackUpdatedAt ??
    Math.trunc(updatesStat.mtimeMs) ??
    Math.max(...timestamps);
  const title =
    (summary ? (readTrimmedString(summary.title) ?? readTrimmedString(summary.name)) : undefined) ??
    deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []);

  return {
    provider: "grok",
    sessionId: params.sessionId,
    workspacePath: summaryCwd ?? params.workspacePath,
    // updates.jsonl 所在目录即会话目录，作为 sourcePath 锚点。
    sourcePath: params.sourcePath || dirname(getGrokUpdatesPath(params.sessionDir)),
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    ...(title ? { title } : {}),
    migrationSource: "grokCli",
    messages,
  };
}
