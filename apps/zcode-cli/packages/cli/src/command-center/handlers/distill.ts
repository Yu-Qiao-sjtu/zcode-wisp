import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import { redactSecrets } from "@zcode/shared";
import type { CommandCenterDeps } from "../types.js";

/** 内置/共享技能目录之外，用户自建技能的根目录（scan.ts 同一约定）。 */
function getUserSkillsRoot(): string {
  return join(homedir(), ".zcode", "skills");
}

function buildDistillPrompt(skillName: string, skillsRoot: string, transcript: string): string {
  return [
    `请把下面的对话沉淀为一个可复用技能，写入 \`${join(skillsRoot, skillName)}\\SKILL.md\`（ POSIX 环境用正斜杠）。`,
    "",
    "硬性要求：",
    `- 目标目录已存在时必须停止并报告，绝不覆盖已有技能。`,
    `- SKILL.md 需包含 YAML frontmatter（name: ${skillName}，description 一句话说明何时使用），正文是该技能的操作指南。`,
    "- 只沉淀可复用的方法论与步骤，不要保留本次对话的临时上下文、路径或个人数据。",
    "- 对话中出现的密钥/令牌一律不得写进技能文件。",
    "- 写完后回显最终文件的绝对路径。",
    "",
    "===== 对话原文（可能已脱敏）=====",
    transcript,
    "===== 结束 =====",
  ].join("\n");
}

const MAX_TRANSCRIPT_CHARS = 48_000;

/**
 * `/distill [skill-name]`：把当前会话蒸馏成可复用技能。
 * 走正常 agent turn（用户可见、可 Stop），文件由 agent 经 Write 工具在权限体系内落盘；
 * 密钥在提交前于客户端先行脱敏。技能名缺省用 distill-<session 前 6 位>。
 */
export async function handleDistillCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const skillName = args.trim() || `distill-${Date.now().toString(36)}`.slice(0, 24);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
    return {
      mode: deps.getMode?.(),
      response:
        "Invalid skill name. Use letters, digits, dot, dash or underscore (e.g. /distill review-pr).",
    };
  }

  const app = await deps.getApp();
  if (!app.loadSessionTranscript) {
    return {
      mode: deps.getMode?.(),
      response: "Distill is not available in this client (no session transcript reader).",
    };
  }

  const transcript = await app.loadSessionTranscript();
  if (transcript.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Nothing to distill yet — the session has no visible messages.",
    };
  }

  const transcriptText = transcript
    .map((message) => {
      const role = message.role === "user" ? "用户" : "助手";
      return `### ${role}\n\n${message.content.trim()}`;
    })
    .join("\n\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);

  const skillsRoot = getUserSkillsRoot();
  const prompt = buildDistillPrompt(skillName, skillsRoot, redactSecrets(transcriptText));
  return app.submitPrompt(prompt);
}
