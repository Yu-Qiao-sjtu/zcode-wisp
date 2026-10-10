// ============================================================
// PubMed Tool Handler - NCBI E-utilities literature search
// ============================================================
// Port of WispTerm's `$pubmed` research capability: esearch for PMIDs,
// efetch for structured metadata. Anonymous usage honors NCBI's
// 3 req/s guidance with a small delay between the two calls.

import {
  PubmedInputJsonSchema,
  PubmedInputSchema,
  PubmedOutputJsonSchema,
  PubmedOutputSchema,
  type PubmedArticleSummary,
  type PubmedInput,
  type PubmedOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const PUBMED_TOOL_NAME = "PubMed";
const DEFAULT_LIMIT = 10;
const MAX_ABSTRACT_CHARS = 2500;
const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const REQUEST_TIMEOUT_MS = 30_000;

const PUBMED_TOOL_DESCRIPTION = [
  "Search PubMed (NCBI) for biomedical literature. Returns titles, authors, journal, year, DOI and abstracts.",
  "Use for life-sciences research questions; supports full PubMed query syntax (MeSH terms, field tags like [tiab], boolean operators).",
].join("\n");

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function extractXmlText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "u").exec(xml);
  if (!match) return "";
  return decodeXmlEntities(
    match[0]
      .replace(new RegExp(`^<${tag}>`, "u"), "")
      .replace(new RegExp(`</${tag}>$`, "u"), "")
      .replace(/<[^>]+>/gu, ""),
  ).trim();
}

function parseArticleXml(pmid: string, xml: string): PubmedArticleSummary {
  const abstractText = extractXmlText(xml, "AbstractText")
    ? extractXmlSections(xml)
    : undefined;
  const doiMatch = /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/u.exec(xml);
  const year = extractXmlText(xml, "Year") || extractXmlText(xml, "PubDate");
  return {
    pmid,
    title: extractXmlText(xml, "ArticleTitle") || "(untitled)",
    authors: extractAuthorNames(xml),
    journal: extractXmlText(xml, "Title") || extractXmlText(xml, "ISOAbbreviation"),
    year: year.slice(0, 4),
    ...(doiMatch?.[1] ? { doi: doiMatch[1] } : {}),
    ...(abstractText ? { abstract: abstractText } : {}),
  };
}

/** Abstract 可能由多个 AbstractText 段落（BACKGROUND/OBJECTIVE…）组成，全部拼接。 */
function extractXmlSections(xml: string): string {
  const sections = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gu)].map(
    (match) => decodeXmlEntities(match[1].replace(/<[^>]+>/gu, "")).trim(),
  );
  const joined = sections.filter(Boolean).join(" ");
  return joined.length > MAX_ABSTRACT_CHARS ? `${joined.slice(0, MAX_ABSTRACT_CHARS)}…` : joined;
}

function extractAuthorNames(xml: string): string {
  const names = [...xml.matchAll(/<LastName>([^<]+)<\/LastName>/gu)].map((match) => match[1]);
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} et al.`;
}

async function fetchEutils(path: string): Promise<string> {
  const response = await fetch(`${EUTILS_BASE}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "User-Agent": "zcode-pubmed-tool/1.0" },
  });
  if (!response.ok) {
    throw new Error(`NCBI E-utilities ${path} failed: HTTP ${response.status}`);
  }
  return response.text();
}

function formatArticles(query: string, articles: PubmedArticleSummary[]): string {
  if (articles.length === 0) {
    return `No PubMed results for: ${query}`;
  }
  const blocks = articles.map((article, index) => {
    const lines = [
      `${index + 1}. ${article.title}`,
      `   PMID: ${article.pmid} | ${article.journal} (${article.year})`,
    ];
    if (article.authors) lines.push(`   Authors: ${article.authors}`);
    if (article.doi) lines.push(`   DOI: https://doi.org/${article.doi}`);
    if (article.abstract) lines.push(`   Abstract: ${article.abstract}`);
    return lines.join("\n");
  });
  return `PubMed results for "${query}" (${articles.length}):\n\n${blocks.join("\n\n")}`;
}

const pubmedHandler: ToolHandler = async (input) => {
  const parsed = PubmedInputSchema.parse(input) as PubmedInput;
  const limit = parsed.limit ?? DEFAULT_LIMIT;

  const esearchXml = await fetchEutils(
    `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(parsed.query)}&retmax=${limit}&retmode=xml&sort=relevance`,
  );
  const pmids = [...esearchXml.matchAll(/<Id>(\d+)<\/Id>/gu)].map((match) => match[1]);
  if (pmids.length === 0) {
    const output: PubmedOutput = {
      query: parsed.query,
      count: 0,
      articles: [],
      formatted: `No PubMed results for: ${parsed.query}`,
    };
    return PubmedOutputSchema.parse(output);
  }

  // NCBI 建议合并请求间 ≥1/3 秒间隔，免费档匿名调用遵守该节流。
  await new Promise((resolve) => setTimeout(resolve, 400));
  const efetchXml = await fetchEutils(
    `/efetch.fcgi?db=pubmed&id=${pmids.join(",")}&retmode=xml`,
  );

  const articles: PubmedArticleSummary[] = [];
  const articleBlocks = efetchXml.split(/<PubmedArticle>/u).slice(1);
  for (const [index, block] of articleBlocks.entries()) {
    const pmid = pmids[index] ?? extractXmlText(block, "PMID");
    if (!pmid) continue;
    articles.push(parseArticleXml(pmid, block));
  }

  const output: PubmedOutput = {
    query: parsed.query,
    count: articles.length,
    articles,
    formatted: formatArticles(parsed.query, articles),
  };
  return PubmedOutputSchema.parse(output);
};

export const pubmedToolEntry: ToolEntry = {
  capability: "Search NCBI PubMed for biomedical literature and return structured results",
  metadata: {
    name: PUBMED_TOOL_NAME,
    description: PUBMED_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: pubmedHandler,
  inputSchema: PubmedInputJsonSchema,
  outputSchema: PubmedOutputJsonSchema,
  runtimeInputSchema: PubmedInputSchema,
  runtimeOutputSchema: PubmedOutputSchema,
  permission: {
    permission: "read",
    reason: "PubMed only reads public NCBI search results and has no local side effects",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["network", "input"],
    alwaysAllowPatternSources: ["network", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 20_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxBytes: 20_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: REQUEST_TIMEOUT_MS,
    maxMs: REQUEST_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "PubMed search was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
