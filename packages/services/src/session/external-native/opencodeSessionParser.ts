import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { ExternalImportedSessionSource } from "#src/session/external-native/externalImportedSessionTypes.js";
import { extractExternalTurn } from "#src/session/external-native/externalSessionRecords.js";

/** OpenCode 存储：storage/session、storage/message、storage/part 三层 JSON。 */
const MESSAGE_DIR_SEGMENT = join("storage", "message");
const SESSION_DIR_SEGMENT = join("storage", "session");

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function listJsonFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listJsonFiles(entryPath)));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(entryPath);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function readSessionTime(session: Record<string, unknown>): {
  createdAt?: number;
  updatedAt?: number;
} {
  const time = isObjectRecord(session.time) ? session.time : {};
  const readMs = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    return undefined;
  };
  return {
    createdAt: readMs(time.create) ?? readMs(time.created) ?? readMs(time.createdAt),
    updatedAt: readMs(time.update) ?? readMs(time.updated) ?? readMs(time.updatedAt),
  };
}

export interface OpenCodeSessionHeadInfo {
  sessionId: string;
  workspacePath?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** 扫描 storage/session 下所有会话 JSON；每份都很小，可以全量读取。 */
export async function scanOpenCodeSessionHeads(
  opencodeRoot: string,
): Promise<OpenCodeSessionHeadInfo[]> {
  const heads: OpenCodeSessionHeadInfo[] = [];
  for (const filePath of await listJsonFiles(join(opencodeRoot, SESSION_DIR_SEGMENT))) {
    const session = await readJsonFile(filePath);
    if (!session) {
      continue;
    }
    const sessionId = readTrimmedString(session.id) ?? basename(filePath, ".json");
    const time = readSessionTime(session);
    heads.push({
      sessionId,
      workspacePath:
        readTrimmedString(session.directory) ?? readTrimmedString(session.workspacePath),
      title: readTrimmedString(session.title),
      ...(time.createdAt !== undefined ? { createdAt: time.createdAt } : {}),
      ...(time.updatedAt !== undefined ? { updatedAt: time.updatedAt } : {}),
    });
  }
  return heads;
}

async function collectSessionTextParts(messageId: string, opencodeRoot: string): Promise<string[]> {
  // 新版本把 parts 内联在 message JSON；旧版本落在 storage/part/<messageId>/。
  const partRoot = join(opencodeRoot, "storage", "part", messageId);
  const partFiles = await listJsonFiles(partRoot);
  const texts: string[] = [];
  for (const partFile of partFiles) {
    const part = await readJsonFile(partFile);
    if (!part || readTrimmedString(part.type) !== "text") {
      continue;
    }
    const text = readTrimmedString(part.text);
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

async function parseSessionFromStorage(params: {
  opencodeRoot: string;
  sessionId: string;
  workspacePath: string;
  head: OpenCodeSessionHeadInfo;
}): Promise<ExternalImportedSessionSource> {
  const messageRoot = join(params.opencodeRoot, MESSAGE_DIR_SEGMENT, params.sessionId);
  const messageFiles = await listJsonFiles(messageRoot);
  if (messageFiles.length === 0) {
    throw new Error(`[external-native] OpenCode session ${params.sessionId} 没有可导入的消息`);
  }

  const loaded: Array<{ order: number; role: "user" | "assistant"; text: string }> = [];
  for (const messageFile of messageFiles) {
    const message = await readJsonFile(messageFile);
    if (!message) {
      continue;
    }
    const role = readTrimmedString(message.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const time = isObjectRecord(message.time) ? message.time : {};
    const order =
      typeof time.create === "number" && Number.isFinite(time.create)
        ? time.create
        : Number.parseInt(basename(messageFile, ".json").replace(/\D/g, ""), 10) || 0;

    const inlineTexts: string[] = [];
    const parts = message.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (isObjectRecord(part) && readTrimmedString(part.type) === "text") {
          const text = readTrimmedString(part.text);
          if (text) {
            inlineTexts.push(text);
          }
        }
      }
    }
    const texts =
      inlineTexts.length > 0
        ? inlineTexts
        : await collectSessionTextParts(
            readTrimmedString(message.id) ?? basename(messageFile, ".json"),
            params.opencodeRoot,
          );
    const text = texts.join("\n\n").trim();
    if (text) {
      loaded.push({ order, role, text });
    }
  }

  if (loaded.length === 0) {
    throw new Error(`[external-native] OpenCode session ${params.sessionId} 没有可见文本消息`);
  }
  loaded.sort((left, right) => left.order - right.order);

  const rawMessages = loaded.map((item, index) => ({
    role: item.role,
    content: item.text,
    timestamp: item.order > 0 ? item.order : (params.head.createdAt ?? Date.now()) + index,
  }));
  // turnIndex 按用户轮次重排，与其它 provider 的导入语义一致。
  const messages: ExternalImportedSessionSource["messages"] = [];
  let turnIndex = -1;
  for (const message of rawMessages) {
    if (message.role === "user") {
      turnIndex += 1;
    }
    messages.push({ ...message, turnIndex });
  }

  const timestamps = messages.map((message) => message.timestamp);
  const createdAt = params.head.createdAt ?? Math.min(...timestamps);
  const updatedAt = params.head.updatedAt ?? Math.max(...timestamps);

  return {
    provider: "opencode",
    sessionId: params.sessionId,
    workspacePath: params.head.workspacePath ?? params.workspacePath,
    sourcePath: join(params.opencodeRoot, MESSAGE_DIR_SEGMENT, params.sessionId),
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    ...(params.head.title ? { title: params.head.title } : {}),
    migrationSource: "openCode",
    messages,
  };
}

/**
 * 旧版本 OpenCode 用 SQLite 存储，官方 CLI 提供 list/export 视图；
 * storage 目录缺失时按 WispTerm 的方式走 CLI，导出格式解析失败就显式报错。
 */
function runOpenCodeCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "opencode",
      args,
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function parseSessionFromCli(params: {
  sessionId: string;
  head: OpenCodeSessionHeadInfo;
}): Promise<ExternalImportedSessionSource> {
  const exported = await runOpenCodeCommand(["export", params.sessionId]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(exported);
  } catch {
    throw new Error("[external-native] OpenCode CLI export 输出不是 JSON，无法导入");
  }
  const records = Array.isArray(parsed)
    ? parsed
    : isObjectRecord(parsed) && Array.isArray(parsed.messages)
      ? parsed.messages
      : null;
  if (!records) {
    throw new Error("[external-native] OpenCode CLI export 结构无法识别");
  }

  const messages: ExternalImportedSessionSource["messages"] = [];
  let turnIndex = -1;
  for (const record of records) {
    if (!isObjectRecord(record)) {
      continue;
    }
    const turn = extractExternalTurn(record);
    if (!turn) {
      continue;
    }
    if (turn.role === "user") {
      turnIndex += 1;
    }
    messages.push({
      role: turn.role,
      content: turn.text,
      timestamp: Date.now(),
      turnIndex,
    });
  }
  if (messages.length === 0) {
    throw new Error(`[external-native] OpenCode session ${params.sessionId} 没有可导入的可见消息`);
  }

  const createdAt = params.head.createdAt ?? Date.now();
  return {
    provider: "opencode",
    sessionId: params.sessionId,
    workspacePath: params.head.workspacePath ?? "",
    sourcePath: `opencode://export/${params.sessionId}`,
    createdAt,
    updatedAt: params.head.updatedAt ?? createdAt,
    ...(params.head.title ? { title: params.head.title } : {}),
    migrationSource: "openCode",
    messages,
  };
}

export async function parseOpenCodeSessionFile(params: {
  opencodeRoot: string;
  sessionId: string;
  workspacePath: string;
  head: OpenCodeSessionHeadInfo;
}): Promise<ExternalImportedSessionSource> {
  const sessionExists = await stat(join(params.opencodeRoot, MESSAGE_DIR_SEGMENT, params.sessionId))
    .then(() => true)
    .catch(() => false);
  if (sessionExists) {
    return parseSessionFromStorage({ ...params });
  }
  return parseSessionFromCli({
    sessionId: params.sessionId,
    head: params.head,
  });
}
