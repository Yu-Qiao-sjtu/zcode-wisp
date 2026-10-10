import { readFile, stat } from "node:fs/promises";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { join } from "node:path";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import {
  extractExternalTurn,
  readFirstString,
  readFirstTimestamp,
} from "#src/session/external-native/externalSessionRecords.js";
import { readExternalJsonLinesFile } from "#src/session/external-native/externalJsonl.js";

const WIRE_RELATIVE_PATH = join("agents", "main", "wire.jsonl");

export function getKimiSessionStatePath(sessionDir: string): string {
  return join(sessionDir, "state.json");
}

export function getKimiSessionWirePath(sessionDir: string): string {
  return join(sessionDir, WIRE_RELATIVE_PATH);
}

async function readJsonObjectFile(filePath: string): Promise<JsonLineRecord | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** session_index.jsonl 里按会话记录原始项目目录；缺 cwd 时兜底。 */
export async function readKimiIndexedWorkspace(
  indexPath: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(indexPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObjectRecord(parsed)) {
        continue;
      }
      const lineSessionId =
        readTrimmedString(parsed.sessionId) ??
        readTrimmedString(parsed.session_id) ??
        readTrimmedString(parsed.id);
      if (lineSessionId !== sessionId) {
        continue;
      }
      const cwd =
        readTrimmedString(parsed.cwd) ??
        readTrimmedString(parsed.projectDirectory) ??
        readTrimmedString(parsed.projectDir) ??
        readTrimmedString(parsed.directory);
      if (cwd) {
        return cwd;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface KimiSessionStateInfo {
  sessionId?: string;
  workspacePath?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

export async function readKimiSessionStateInfo(sessionDir: string): Promise<KimiSessionStateInfo> {
  const state = await readJsonObjectFile(getKimiSessionStatePath(sessionDir));
  if (!state) {
    return {};
  }
  return {
    sessionId:
      readTrimmedString(state.sessionId) ??
      readTrimmedString(state.session_id) ??
      readTrimmedString(state.id),
    workspacePath:
      readTrimmedString(state.cwd) ??
      readTrimmedString(state.projectDir) ??
      readTrimmedString(state.projectDirectory) ??
      readTrimmedString(state.directory),
    title: readTrimmedString(state.title) ?? readTrimmedString(state.name),
    createdAt: readFirstTimestamp([state.createdAt, state.created_at, state.time]),
    updatedAt: readFirstTimestamp([state.updatedAt, state.updated_at]),
  };
}

async function parseKimiWireTurns(
  wirePath: string,
): Promise<Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>> {
  const records = await readExternalJsonLinesFile(wirePath);
  const turns: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }> = [];
  for (const record of records) {
    const turn = extractExternalTurn(record);
    if (!turn) {
      continue;
    }
    turns.push({
      role: turn.role,
      text: turn.text,
      timestamp: readFirstTimestamp([record.timestamp, record.time, record.created_at]),
    });
  }
  return turns;
}

export async function parseKimiSessionFile(params: {
  sessionDir: string;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ExternalImportedSessionSource> {
  const [stateInfo, wireStat, turns] = await Promise.all([
    readKimiSessionStateInfo(params.sessionDir),
    stat(getKimiSessionWirePath(params.sessionDir)),
    parseKimiWireTurns(getKimiSessionWirePath(params.sessionDir)),
  ]);

  if (turns.length === 0) {
    throw new Error(`[external-native] Kimi session ${params.sessionId} 没有可导入的可见消息`);
  }

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
    pendingAssistantText = pendingAssistantText
      ? `${pendingAssistantText}\n\n${turn.text}`
      : turn.text;
    pendingAssistantTimestamp = turn.timestamp ?? pendingAssistantTimestamp;
  }
  flushAssistant();

  const timestamps = messages.map((message) => message.timestamp);
  const createdAt = stateInfo.createdAt ?? params.fallbackCreatedAt ?? Math.min(...timestamps);
  const updatedAt =
    stateInfo.updatedAt ??
    params.fallbackUpdatedAt ??
    Math.trunc(wireStat.mtimeMs) ??
    Math.max(...timestamps);
  const title =
    stateInfo.title ??
    deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []);

  return {
    provider: "kimi",
    sessionId: stateInfo.sessionId ?? params.sessionId,
    workspacePath: stateInfo.workspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    ...(title ? { title } : {}),
    migrationSource: "kimiCode",
    messages,
  };
}

export function readKimiStateFirstString(
  state: JsonLineRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readFirstString([state[key]]);
    if (value) {
      return value;
    }
  }
  return undefined;
}
