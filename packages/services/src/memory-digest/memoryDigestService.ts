import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { redactSecrets } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir } from "#src/paths.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { externalSessionImportRepo } from "#src/session/external-native/externalSessionImportRepo.js";
import type { ExternalImportSourceProvider } from "#src/session/external-native/externalImportedSessionTypes.js";
import { EXTERNAL_IMPORT_SOURCE_PROVIDERS } from "#src/session/external-native/externalImportedSessionTypes.js";

const logger = createServiceLogger("memory-digest");

export interface MemoryDigestEntry {
  provider: string;
  sessionId: string;
  workspacePath: string;
  title: string;
  updatedAt: number;
}

export interface MemoryDigestResult {
  date: string;
  outputPath: string;
  entryCount: number;
  markdown: string;
}

const DIGEST_SOURCE_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  kimi: "Kimi Code",
  opencode: "OpenCode",
  grok: "Grok CLI",
};

function resolveDigestDate(date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return date;
  }
  return new Date().toISOString().slice(0, 10);
}

function isSameLocalDay(timestamp: number, date: string): boolean {
  // 本地时区口径：用户感知的“今天”，而不是 UTC 切日。
  const day = new Date(timestamp);
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${dayOfMonth}` === date;
}

function getDigestFilePath(date: string): string {
  return join(getAppConfigDir(), "memory-digest", `${date}.md`);
}

async function collectProviderCandidates(
  provider: ExternalImportSourceProvider | "claude",
  date: string,
): Promise<MemoryDigestEntry[]> {
  const scanned: ZCodeImportableSessionCandidate[] =
    provider === "claude"
      ? await claudeNativeSessionImportRepo.scanImportableSessions({})
      : await externalSessionImportRepo.scanImportableSessions({ provider });
  return scanned
    .filter((candidate) => isSameLocalDay(candidate.updatedAt, date))
    .map((candidate) => ({
      provider,
      sessionId: candidate.sessionId,
      workspacePath: candidate.workspacePath,
      title: redactSecrets(candidate.previewTitle?.trim() || candidate.sessionId),
      updatedAt: candidate.updatedAt,
    }));
}

function groupByWorkspace(entries: readonly MemoryDigestEntry[]): Map<string, MemoryDigestEntry[]> {
  const grouped = new Map<string, MemoryDigestEntry[]>();
  for (const entry of entries) {
    const key = entry.workspacePath || "(unknown workspace)";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }
  return grouped;
}

function buildDigestMarkdown(date: string, entries: readonly MemoryDigestEntry[]): string {
  const lines: string[] = [
    `# 开发日志 · ${date}`,
    "",
    `> 由 Memory Digest 自动汇总（${entries.length} 个会话；标题已做密钥脱敏）。`,
    "> 如需 AI 精炼摘要，可把本文件交给一次定时 automation（cron）任务处理。",
    "",
  ];
  if (entries.length === 0) {
    lines.push("今天没有发现活跃会话。", "");
    return lines.join("\n");
  }

  const grouped = groupByWorkspace(entries);
  for (const [workspacePath, workspaceEntries] of grouped) {
    lines.push(`## ${workspacePath}`, "");
    for (const entry of workspaceEntries.sort((left, right) => right.updatedAt - left.updatedAt)) {
      const time = new Date(entry.updatedAt).toTimeString().slice(0, 5);
      const providerLabel = DIGEST_SOURCE_LABELS[entry.provider] ?? entry.provider;
      lines.push(`- ${time} 【${providerLabel}】${entry.title} \`(session: ${entry.sessionId})\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function writeDigestFile(date: string, markdown: string): Promise<string> {
  const filePath = getDigestFilePath(date);
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, markdown, "utf-8");
  await rename(tempPath, filePath);
  return filePath;
}

/**
 * Memory Digest（WispTerm 移植，精简核心）：
 * 扫描本机 Claude/Codex/Kimi/OpenCode/Grok 的原生历史，按本地日汇总为
 * “按项目分组的开发日志”并落盘 <configDir>/memory-digest/<date>.md。
 * 采集为增量可重跑（同日重跑覆盖同文件）；LLM 精炼摘要交由既有 automation（cron）
 * 任务消费本文件完成，保持 digest 引擎零模型依赖。
 */
export async function generateMemoryDigest(params: { date?: string }): Promise<MemoryDigestResult> {
  const date = resolveDigestDate(params.date);
  const providers: Array<ExternalImportSourceProvider | "claude"> = [
    "claude",
    ...EXTERNAL_IMPORT_SOURCE_PROVIDERS,
  ];

  const collected = await Promise.allSettled(
    providers.map((provider) => collectProviderCandidates(provider, date)),
  );
  const entries: MemoryDigestEntry[] = [];
  for (const result of collected) {
    if (result.status === "fulfilled") {
      entries.push(...result.value);
    } else {
      logger.warn(undefined, "memory digest provider scan failed", result.reason);
    }
  }

  const markdown = buildDigestMarkdown(date, entries);
  const outputPath = await writeDigestFile(date, markdown);
  logger.info(undefined, `memory digest generated date=${date} entries=${entries.length}`);
  return { date, outputPath, entryCount: entries.length, markdown };
}

/** 读取已落盘的某日 digest；不存在返回 null。 */
export async function readMemoryDigest(date: string): Promise<string | null> {
  try {
    return await readFile(getDigestFilePath(resolveDigestDate(date)), "utf-8");
  } catch {
    return null;
  }
}
