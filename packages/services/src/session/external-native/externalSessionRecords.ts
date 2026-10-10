import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";

/**
 * Kimi/Grok/OpenCode 本地历史没有公开稳定的 schema 约定，
 * 这里集中提供“多候选字段 + 宽松类型”的容错提取；解析不出可见文本时静默跳过，
 * 宁可少导入一条，也不能把协议噪音写成用户消息。
 */
export function toExternalTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toExternalTimestampMs(numericValue);
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readFirstTimestamp(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (isObjectRecord(value)) {
      const nested = readFirstTimestamp(Object.values(value));
      if (nested !== undefined) {
        return nested;
      }
      continue;
    }
    const timestamp = toExternalTimestampMs(value);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }
  return undefined;
}

export function readFirstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      continue;
    }
    if (isObjectRecord(value)) {
      const nested = readFirstString(Object.values(value));
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

type ExternalTurn = { role: "user" | "assistant"; text: string };

function extractContentText(content: unknown): string | null {
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
      // Anthropic/OpenAI content part：{type:"text"|"input_text"|"output_text", text}
      if (item.type === "tool_result" || item.type === "tool_use" || item.type === "image") {
        return "";
      }
      return readTrimmedString(item.text) ?? "";
    })
    .filter((part) => part.length > 0);

  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * 从一条宽泛形态的记录里提取 user/assistant 可见文本。
 * 命中顺序：record 本身 → record.message → record.payload（Codex/事件包裹形态）。
 */
export function extractExternalTurn(record: JsonLineRecord): ExternalTurn | null {
  const candidates = [record, record.message, record.payload];
  for (const candidate of candidates) {
    if (!isObjectRecord(candidate)) {
      continue;
    }
    const role = readTrimmedString(candidate.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractContentText(candidate.content);
    if (text) {
      return { role, text };
    }
  }
  return null;
}
