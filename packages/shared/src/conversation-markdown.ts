import type { ZCodePersistedMessage, ZCodePersistedToolCall } from "./zcode-task-types-core.js";

/**
 * WispTerm 式对话 Markdown 导出：
 * - clean：只保留用户输入与最终 AI 回答，适合发布/分享。
 * - full：附带思考过程、工具调用明细与用量元数据，适合留档复盘。
 * 纯函数、双端复用（桌面/Web 从快照导出，TUI 从 session store 导出）。
 */
export type ConversationMarkdownMode = "clean" | "full";

export interface ConversationMarkdownMeta {
  title?: string;
  workspacePath?: string;
  model?: string;
  taskId?: string;
  exportedAt?: number;
}

const TOOL_OUTPUT_MAX_CHARS = 2000;

function formatTimestamp(timestamp: number | undefined): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

function fence(text: string, language = ""): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  // 正文里出现 ``` 时升级围栏，保证导出的 Markdown 块结构不被内容打断。
  const longestRun = /`{3,}/u.exec(normalized)?.[0].length ?? 2;
  const fenceToken = "`".repeat(longestRun + 1);
  return `${fenceToken}${language}\n${normalized}\n${fenceToken}`;
}

function formatToolCall(tool: ZCodePersistedToolCall, index: number): string {
  const name = tool.toolName?.trim() || tool.title?.trim() || `tool-${index + 1}`;
  const status = tool.status ? ` (${tool.status})` : "";
  const lines: string[] = [`#### ${index + 1}. ${name}${status}`];

  const inputText = tool.input === undefined ? "" : JSON.stringify(tool.input, null, 2);
  if (inputText && inputText !== "undefined") {
    lines.push(fence(inputText.slice(0, TOOL_OUTPUT_MAX_CHARS), "json"));
  }
  if (typeof tool.error === "string" && tool.error.trim()) {
    lines.push(`- error: ${tool.error.trim()}`);
  }
  const outputText =
    tool.output === undefined
      ? ""
      : typeof tool.output === "string"
        ? tool.output
        : JSON.stringify(tool.output, null, 2);
  if (outputText.trim()) {
    lines.push(fence(outputText.slice(0, TOOL_OUTPUT_MAX_CHARS).trim(), "text"));
  }
  return lines.join("\n\n");
}

function formatAssistantMessage(
  message: ZCodePersistedMessage,
  mode: ConversationMarkdownMode,
): string {
  const parts: string[] = [];
  if (mode === "full" && message.thought?.trim()) {
    parts.push(
      `> [!NOTE] 思考过程\n>\n${message.thought
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`,
    );
  }
  if (message.content.trim()) {
    parts.push(message.content.trim());
  }
  if (mode === "full" && message.tools && message.tools.length > 0) {
    const rendered = message.tools.map((tool, index) => formatToolCall(tool, index)).join("\n\n");
    parts.push(
      `<details>\n<summary>工具调用（${message.tools.length}）</summary>\n\n${rendered}\n\n</details>`,
    );
  }
  const metaBits: string[] = [];
  const time = formatTimestamp(message.timestamp);
  if (mode === "full") {
    if (time) metaBits.push(time);
    if (message.model) metaBits.push(message.model);
    const usage = message.tools?.length;
    if (usage) metaBits.push(`${usage} tool calls`);
  } else if (time) {
    metaBits.push(time);
  }
  const header = metaBits.length > 0 ? ` _(${metaBits.join(" · ")})_` : "";
  return parts.length > 0 ? `${parts.join("\n\n")}${header}` : `_(空回复)_${header}`;
}

export function buildConversationMarkdown(
  messages: readonly ZCodePersistedMessage[],
  mode: ConversationMarkdownMode,
  meta: ConversationMarkdownMeta = {},
): string {
  const headerLines: string[] = ["# " + (meta.title?.trim() || "ZCode 对话导出")];
  const headerMeta: string[] = [];
  if (meta.workspacePath) headerMeta.push(`- workspace: \`${meta.workspacePath}\``);
  if (meta.model) headerMeta.push(`- model: ${meta.model}`);
  if (meta.taskId) headerMeta.push(`- task: \`${meta.taskId}\``);
  headerMeta.push(`- exported at: ${formatTimestamp(meta.exportedAt ?? Date.now())} UTC`);
  headerMeta.push(`- mode: ${mode}`);
  const body = messages
    .map((message) => {
      if (message.role === "user") {
        const time = formatTimestamp(message.timestamp);
        const header = time && mode === "full" ? ` _(${time})_` : "";
        return `## 🧑 用户${header}\n\n${message.content.trim() || "_(空)_"}`;
      }
      return `## 🤖 助手\n\n${formatAssistantMessage(message, mode)}`;
    })
    .join("\n\n---\n\n");
  return `${headerLines[0]}\n\n${headerMeta.join("\n")}\n\n${body}\n`;
}
