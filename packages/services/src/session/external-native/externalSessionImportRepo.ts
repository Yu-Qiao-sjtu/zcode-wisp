import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ExternalImportSourceProvider } from "#src/session/external-native/externalImportedSessionTypes.js";
import { getExternalSessionRoots } from "#src/session/external-native/externalSessionLocations.js";
import {
  codexCandidateFromHeadInfo,
  extractCodexSessionHeadInfo,
} from "#src/session/external-native/codexSessionParser.js";
import { readExternalJsonLinesFileHead } from "#src/session/external-native/externalJsonl.js";
import {
  readKimiIndexedWorkspace,
  readKimiSessionStateInfo,
} from "#src/session/external-native/kimiSessionParser.js";
import { readGrokSessionHeadInfo } from "#src/session/external-native/grokSessionParser.js";
import { scanOpenCodeSessionHeads } from "#src/session/external-native/opencodeSessionParser.js";

const logger = createServiceLogger("external-native-import");
const CODEX_HEAD_LINES = 48;

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function collectFilesMatching(
  rootDir: string,
  matches: (fileName: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectFilesMatching(entryPath, matches)));
        continue;
      }
      if (entry.isFile() && matches(entry.name)) {
        files.push(entryPath);
      }
    }
    return files;
  } catch {
    return [];
  }
}

/** 递归找到包含 marker 文件（如 updates.jsonl / state.json）的目录。 */
async function collectDirsContaining(rootDir: string, markerFileName: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const dirs: string[] = [];
    let hasMarker = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name === markerFileName) {
        hasMarker = true;
        continue;
      }
      if (entry.isDirectory()) {
        dirs.push(...(await collectDirsContaining(join(rootDir, entry.name), markerFileName)));
      }
    }
    return hasMarker ? [rootDir, ...dirs] : dirs;
  } catch {
    return [];
  }
}

async function scanCodexCandidates(params: {
  workspacePath?: string;
  modifiedSince?: number;
  limit?: number;
}): Promise<ZCodeImportableSessionCandidate[]> {
  const workspaceKey = params.workspacePath?.trim()
    ? normalizePathForComparison(params.workspacePath.trim())
    : undefined;
  const candidates: ZCodeImportableSessionCandidate[] = [];
  for (const rootDir of getExternalSessionRoots("codex")) {
    for (const filePath of await collectFilesMatching(rootDir, (name) => name.endsWith(".jsonl"))) {
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) {
        continue;
      }
      const updatedAt = Math.trunc(fileStat.mtimeMs);
      if (params.modifiedSince && updatedAt < params.modifiedSince) {
        continue;
      }
      try {
        const headRecords = await readExternalJsonLinesFileHead(filePath, CODEX_HEAD_LINES);
        const headInfo = extractCodexSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        if (workspaceKey && normalizePathForComparison(headInfo.workspacePath) !== workspaceKey) {
          continue;
        }
        candidates.push(codexCandidateFromHeadInfo({ filePath, updatedAt, headInfo }));
      } catch (error) {
        logger.warn(undefined, `扫描 Codex session 失败 path=${filePath}`, error);
      }
    }
  }
  return candidates;
}

async function scanKimiCandidates(params: {
  workspacePath?: string;
  modifiedSince?: number;
}): Promise<ZCodeImportableSessionCandidate[]> {
  const workspaceKey = params.workspacePath?.trim()
    ? normalizePathForComparison(params.workspacePath.trim())
    : undefined;
  const candidates: ZCodeImportableSessionCandidate[] = [];
  for (const rootDir of getExternalSessionRoots("kimi")) {
    const indexPath = join(dirname(rootDir), "session_index.jsonl");
    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sessionDir = join(rootDir, entry.name);
      try {
        const stateInfo = await readKimiSessionStateInfo(sessionDir);
        const workspacePath =
          stateInfo.workspacePath ??
          (await readKimiIndexedWorkspace(indexPath, stateInfo.sessionId ?? entry.name));
        if (!workspacePath) {
          continue;
        }
        if (workspaceKey && normalizePathForComparison(workspacePath) !== workspaceKey) {
          continue;
        }
        const dirStat = await stat(sessionDir);
        const updatedAt = stateInfo.updatedAt ?? Math.trunc(dirStat.mtimeMs);
        if (params.modifiedSince && updatedAt < params.modifiedSince) {
          continue;
        }
        candidates.push({
          provider: "kimi",
          sessionId: stateInfo.sessionId ?? entry.name,
          workspacePath,
          sourcePath: sessionDir,
          updatedAt,
          ...(stateInfo.createdAt ? { createdAt: stateInfo.createdAt } : {}),
          ...(stateInfo.title ? { previewTitle: stateInfo.title } : {}),
        });
      } catch (error) {
        logger.warn(undefined, `扫描 Kimi session 失败 dir=${sessionDir}`, error);
      }
    }
  }
  return candidates;
}

async function scanGrokCandidates(params: {
  workspacePath?: string;
  modifiedSince?: number;
}): Promise<ZCodeImportableSessionCandidate[]> {
  const workspaceKey = params.workspacePath?.trim()
    ? normalizePathForComparison(params.workspacePath.trim())
    : undefined;
  const candidates: ZCodeImportableSessionCandidate[] = [];
  for (const rootDir of getExternalSessionRoots("grok")) {
    for (const sessionDir of await collectDirsContaining(rootDir, "updates.jsonl")) {
      try {
        const headInfo = await readGrokSessionHeadInfo(sessionDir);
        const workspacePath = headInfo.workspacePath;
        if (!workspacePath) {
          continue;
        }
        if (workspaceKey && normalizePathForComparison(workspacePath) !== workspaceKey) {
          continue;
        }
        const updatesStat = await stat(join(sessionDir, "updates.jsonl"));
        const updatedAt = headInfo.updatedAt ?? Math.trunc(updatesStat.mtimeMs);
        if (params.modifiedSince && updatedAt < params.modifiedSince) {
          continue;
        }
        candidates.push({
          provider: "grok",
          sessionId: headInfo.sessionId ?? basename(sessionDir),
          workspacePath,
          sourcePath: sessionDir,
          updatedAt,
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.title ? { previewTitle: headInfo.title } : {}),
        });
      } catch (error) {
        logger.warn(undefined, `扫描 Grok session 失败 dir=${sessionDir}`, error);
      }
    }
  }
  return candidates;
}

async function scanOpenCodeCandidates(params: {
  workspacePath?: string;
}): Promise<ZCodeImportableSessionCandidate[]> {
  const workspaceKey = params.workspacePath?.trim()
    ? normalizePathForComparison(params.workspacePath.trim())
    : undefined;
  const candidates: ZCodeImportableSessionCandidate[] = [];
  for (const rootDir of getExternalSessionRoots("opencode")) {
    for (const head of await scanOpenCodeSessionHeads(rootDir)) {
      if (!head.workspacePath) {
        continue;
      }
      if (workspaceKey && normalizePathForComparison(head.workspacePath) !== workspaceKey) {
        continue;
      }
      candidates.push({
        provider: "opencode",
        sessionId: head.sessionId,
        workspacePath: head.workspacePath,
        sourcePath: join(rootDir, "storage", "message", head.sessionId),
        updatedAt: head.updatedAt ?? head.createdAt ?? 0,
        ...(head.createdAt ? { createdAt: head.createdAt } : {}),
        ...(head.title ? { previewTitle: head.title } : {}),
      });
    }
  }
  return candidates;
}

function sortAndLimit(
  candidates: ZCodeImportableSessionCandidate[],
  limit: number | undefined,
): ZCodeImportableSessionCandidate[] {
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  return typeof limit === "number" && limit > 0 ? candidates.slice(0, limit) : candidates;
}

class ExternalSessionImportRepo {
  async scanImportableSessions(params: {
    provider: ExternalImportSourceProvider;
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const scanned =
      params.provider === "codex"
        ? await scanCodexCandidates(params)
        : params.provider === "kimi"
          ? await scanKimiCandidates(params)
          : params.provider === "grok"
            ? await scanGrokCandidates(params)
            : await scanOpenCodeCandidates(params);
    const result = sortAndLimit(scanned, params.limit);
    logger.info(
      undefined,
      `${params.provider} 原生 session 扫描完成 workspaceFilter=${params.workspacePath ?? "all"} candidateCount=${result.length}`,
    );
    return result;
  }

  async findImportableSession(params: {
    provider: ExternalImportSourceProvider;
    workspacePath?: string;
    sessionId: string;
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const candidates = await this.scanImportableSessions({
      provider: params.provider,
      workspacePath: params.workspacePath,
    });
    const match = candidates.find((candidate) => candidate.sessionId === params.sessionId);
    if (match) {
      return match;
    }
    // workspace 过滤可能让目标会话不可见；全量扫描一次兜底。
    const allCandidates = await this.scanImportableSessions({ provider: params.provider });
    return allCandidates.find((candidate) => candidate.sessionId === params.sessionId) ?? null;
  }
}

export const externalSessionImportRepo = new ExternalSessionImportRepo();
