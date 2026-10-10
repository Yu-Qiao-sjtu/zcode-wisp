// ============================================================
// PubMed Tool - NCBI literature search (esearch + efetch)
// ============================================================
// Port of WispTerm's $pubmed research command: query NCBI E-utilities
// anonymously (no API key required for low-rate usage) and return
// structured literature results for biomedical research workflows.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const PubmedInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("PubMed search query, e.g. 'CRISPR screen breast cancer' or a MeSH term"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of articles to return (default 10, max 50)"),
});

export type PubmedInput = z.infer<typeof PubmedInputSchema>;

export const PubmedInputJsonSchema = toToolJsonSchema(PubmedInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface PubmedArticleSummary {
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi?: string;
  abstract?: string;
}

export interface PubmedOutput {
  query: string;
  count: number;
  articles: PubmedArticleSummary[];
  formatted: string;
}

export const PubmedOutputSchema = z
  .object({
    query: z.string(),
    count: z.number().int().nonnegative(),
    articles: z.array(
      z
        .object({
          pmid: z.string(),
          title: z.string(),
          authors: z.string(),
          journal: z.string(),
          year: z.string(),
          doi: z.string().optional(),
          abstract: z.string().optional(),
        })
        .strict(),
    ),
    formatted: z.string(),
  })
  .strict();

export const PubmedOutputJsonSchema = toToolJsonSchema(PubmedOutputSchema);
