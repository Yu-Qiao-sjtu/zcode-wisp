import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { ZCodePersistedMessage, ZCodePersistedToolCall } from "@zcode/shared";
import { buildConversationMarkdown } from "@zcode/shared";
import type { CommandCenterDeps } from "../types.js";

type TranscriptPart = NonNullable<
  NonNullable<TuiSubmitPromptResult["restoredMessages"]>[number]["parts"]
>[number];

const TOOL_OUTPUT_MAX_CHARS = 4000;

function mapParts(message: {
  content: string;
  parts?: TranscriptPart[];
}): ZCodePersistedMessage {
  const texts: string[] = [];
  let thought: string | undefined;
  const tools: ZCodePersistedToolCall[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === "text") {
      if (part.text.trim()) texts.push(part.text);
      continue;
    }
    if (part.type === "thought") {
      thought = thought ? `${thought}\n\n${part.text}` : part.text;
      continue;
    }
    if (part.type === "tool") {
      tools.push({
        toolName: part.toolName,
        title: part.title,
        status: part.status === "pending" || part.status === "running" ? "completed" : part.status,
        input: part.input,
        ...(part.output !== undefined ? { output: part.output.slice(0, TOOL_OUTPUT_MAX_CHARS) } : {}),
        ...(part.error ? { error: part.error } : {}),
      });
    }
  }
  const content = (texts.length > 0 ? texts.join("\n\n") : message.content).trim();
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...(thought ? { thought } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * `/export [full]`：把当前会话导出为 Markdown。
 * 缺省为 clean（用户输入 + 最终回答），`full` 附带思考、工具调用与元数据。
 * 文件写入当前工作目录，绝对路径在 TUI 回显，便于直接分享或归档。
 */
export async function handleExportCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const mode = args.trim().toLowerCase().includes("full") ? "full" : "clean";
  const app = await deps.getApp();
  if (!app.loadSessionTranscript) {
    return {
      mode: deps.getMode?.(),
      response: "Export is not available in this client (no session transcript reader).",
    };
  }

  const transcript = await app.loadSessionTranscript();
  const messages = transcript
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "user") {
        return {
          role: "user" as const,
          content: message.content.trim(),
          timestamp: Date.now(),
        };
      }
      return mapParts(message);
    });

  if (messages.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Nothing to export yet — the session has no visible messages.",
    };
  }

  const markdown = buildConversationMarkdown(messages, mode, {
    taskId: app.sessionId,
    ...(app.getModel?.() ? { model: app.getModel?.() } : {}),
  });
  const fileName = `zcode-export-${app.sessionId.slice(0, 8)}-${mode}.md`;
  const outPath = resolve(process.cwd(), fileName);
  await writeFile(outPath, markdown, "utf-8");

  return {
    mode: deps.getMode?.(),
    response: `Exported ${mode} Markdown (${messages.length} messages) → ${outPath}`,
  };
}
