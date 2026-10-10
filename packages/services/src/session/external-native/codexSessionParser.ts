import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import { toExternalTimestampMs } from "#src/session/external-native/externalSessionRecords.js";
import { readExternalJsonLinesFile } from "#src/session/external-native/externalJsonl.js";

/** Codex CLI 注入的上下文块不是用户可见提问，导入时必须剔除。 */
const CODEX_INJECTED_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<turn_context>",
  "<recommended_plugins>",
  "<permissions",
  "<agents",
];

function isInjectedCodexUserText(text: string): boolean {
  const lowered = text.trimStart().toLowerCase();
  return CODEX_INJECTED_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function readCodexPayload(record: JsonLineRecord): JsonLineRecord | undefined {
  return isObjectRecord(record.payload) ? record.payload : undefined;
}

function extractCodexMessageText(payload: JsonLineRecord): string | null {
  const content = payload.content;
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!isObjectRecord(item)) {
        return "";
      }
      if (item.type !== "input_text" && item.type !== "output_text" && item.type !== "text") {
        return "";
      }
      return readTrimmedString(item.text) ?? "";
    })
    .filter((part) => part.length > 0);
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
}

type CodexTurn = { role: "user" | "assistant"; text: string; timestamp?: number };

/**
 * 优先用 response_item.message 还原对话；部分旧版本 rollout 只写 event_msg，
 * 只有在完全没有 response_item 消息时才回退 event_msg，避免同一条内容重复导入。
 */
function collectCodexTurns(records: readonly JsonLineRecord[]): CodexTurn[] {
  const fromResponseItems = collectCodexTurnsFromRecords(records, "response_item");
  if (fromResponseItems.length > 0) {
    return fromResponseItems;
  }
  return collectCodexTurnsFromRecords(records, "event_msg");
}

function collectCodexTurnsFromRecords(
  records: readonly JsonLineRecord[],
  recordType: "response_item" | "event_msg",
): CodexTurn[] {
  const turns: CodexTurn[] = [];
  for (const record of records) {
    if (record.type !== recordType) {
      continue;
    }
    const payload = readCodexPayload(record);
    if (!payload) {
      continue;
    }
    const role = readTrimmedString(payload.role);
    const payloadType = readTrimmedString(payload.type);
    const isMessage =
      (recordType === "response_item" && payloadType === "message") ||
      (recordType === "event_msg" &&
        (payloadType === "user_message" || payloadType === "agent_message"));
    if (!isMessage) {
      continue;
    }
    const resolvedRole: "user" | "assistant" | null =
      role === "user" || role === "assistant"
        ? role
        : payloadType === "user_message"
          ? "user"
          : payloadType === "agent_message"
            ? "assistant"
            : null;
    if (!resolvedRole) {
      continue;
    }
    const text = extractCodexMessageText(payload);
    if (!text || (resolvedRole === "user" && isInjectedCodexUserText(text))) {
      continue;
    }
    turns.push({
      role: resolvedRole,
      text,
      timestamp: toExternalTimestampMs(record.timestamp),
    });
  }
  return turns;
}

function readCodexSessionMeta(records: readonly JsonLineRecord[]): {
  sessionId?: string;
  workspacePath?: string;
  createdAt?: number;
} {
  for (const record of records) {
    if (record.type !== "session_meta") {
      continue;
    }
    const payload = readCodexPayload(record);
    if (!payload) {
      continue;
    }
    return {
      sessionId: readTrimmedString(payload.id),
      workspacePath: readTrimmedString(payload.cwd),
      createdAt:
        toExternalTimestampMs(payload.timestamp) ?? toExternalTimestampMs(record.timestamp),
    };
  }
  return {};
}

export function extractCodexSessionIdFromFileName(fileName: string): string | undefined {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(fileName);
  return match?.[1];
}

/** 扫描阶段只读头部：拿 cwd/首条提问/时间，避免为列表项解析整个 rollout。 */
export function extractCodexSessionHeadInfo(records: readonly JsonLineRecord[]): {
  sessionId?: string;
  workspacePath?: string;
  createdAt?: number;
  previewTitle?: string;
} {
  const meta = readCodexSessionMeta(records);
  for (const record of records) {
    if (record.type !== "response_item" && record.type !== "event_msg") {
      continue;
    }
    const payload = readCodexPayload(record);
    if (!payload) {
      continue;
    }
    const role = readTrimmedString(payload.role);
    const payloadType = readTrimmedString(payload.type);
    if ((role === "user" && payloadType === "message") || payloadType === "user_message") {
      const text = extractCodexMessageText(payload);
      if (text && !isInjectedCodexUserText(text)) {
        return {
          ...meta,
          previewTitle: deriveSessionTitle(text, []),
        };
      }
    }
  }
  return meta;
}

export async function parseCodexSessionFile(params: {
  filePath: string;
  fallbackSessionId: string;
  workspacePath: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ExternalImportedSessionSource> {
  const [records, sourceStat] = await Promise.all([
    readExternalJsonLinesFile(params.filePath),
    stat(params.filePath),
  ]);

  const meta = readCodexSessionMeta(records);
  const turns = collectCodexTurns(records);
  if (turns.length === 0) {
    throw new Error(
      `[external-native] Codex session ${params.fallbackSessionId} 没有可导入的可见消息`,
    );
  }

  const sessionId = meta.sessionId ?? params.fallbackSessionId;
  const messages: ExternalImportedSessionSource["messages"] = [];
  let turnIndex = -1;
  let pendingAssistant: CodexTurn | undefined;

  const flushAssistant = () => {
    if (!pendingAssistant) {
      return;
    }
    messages.push({
      role: "assistant",
      content: pendingAssistant.text,
      timestamp: pendingAssistant.timestamp ?? params.fallbackUpdatedAt ?? Date.now(),
      turnIndex,
    });
    pendingAssistant = undefined;
  };

  for (const turn of turns) {
    if (turn.role === "user") {
      flushAssistant();
      turnIndex += 1;
      messages.push({
        role: "user",
        content: turn.text,
        timestamp: turn.timestamp ?? params.fallbackCreatedAt ?? Date.now(),
        turnIndex,
      });
      continue;
    }
    // Codex 会把一轮回答拆成多条 assistant message；同一轮内聚合成一条。
    if (pendingAssistant) {
      pendingAssistant.text = `${pendingAssistant.text}\n\n${turn.text}`;
      pendingAssistant.timestamp = turn.timestamp ?? pendingAssistant.timestamp;
    } else {
      pendingAssistant = { ...turn };
    }
  }
  flushAssistant();

  const timestamps = messages.map((message) => message.timestamp);
  const createdAt = meta.createdAt ?? params.fallbackCreatedAt ?? Math.min(...timestamps);
  const updatedAt =
    params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs) ?? Math.max(...timestamps);

  return {
    provider: "codex",
    sessionId,
    workspacePath: meta.workspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
    migrationSource: "codexCli",
    messages,
  };
}

export function codexCandidateFromHeadInfo(params: {
  filePath: string;
  updatedAt: number;
  headInfo: ReturnType<typeof extractCodexSessionHeadInfo>;
}): ZCodeImportableSessionCandidate {
  const sessionId =
    params.headInfo.sessionId ??
    extractCodexSessionIdFromFileName(basename(params.filePath)) ??
    basename(params.filePath);
  return {
    provider: "codex",
    sessionId,
    // Codex rollout 的 cwd 是扫描阶段唯一可信的 workspace 归属；缺失时留给导入阶段兜底。
    workspacePath: params.headInfo.workspacePath ?? "",
    sourcePath: params.filePath,
    updatedAt: params.updatedAt,
    ...(params.headInfo.createdAt ? { createdAt: params.headInfo.createdAt } : {}),
    ...(params.headInfo.previewTitle ? { previewTitle: params.headInfo.previewTitle } : {}),
  };
}
