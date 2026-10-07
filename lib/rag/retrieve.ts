import "server-only";

// Langkah 5 pipeline RAG (spec §3.5): ambil top-k chunk paling mirip dengan
// query, HANYA dari dokumen milik sesi ini (filter ada di SQL match_chunks).

import { z } from "zod";

import { TOP_K } from "@/lib/config";
import { getSupabase } from "@/lib/supabase/client";
import type { Source } from "@/lib/types";

import { embedQuery, toPgVector } from "./embed";

// Hasil RPC dari supabase-js bertipe `any` (tanpa generated types) → validasi
// bentuknya di sini supaya kode setelahnya benar-benar type-safe.
const matchRowsSchema = z.array(
  z.object({
    id: z.string(),
    document_id: z.string(),
    filename: z.string(),
    chunk_index: z.number().int(),
    content: z.string(),
    similarity: z.number(),
  }),
);

export type RetrieveResult = {
  sources: Source[];
  /** Token & biaya embedding query — ikut dihitung ke usage per pesan. */
  embeddingTokens: number;
  embeddingCostUsd: number;
};

/**
 * Embed query lalu cari chunk termirip (cosine) di dokumen sesi ini.
 * k=5 (TOP_K): trade-off biaya token vs recall — lihat README.
 */
export async function retrieveChunks(
  sessionId: string,
  query: string,
  opts: { k?: number; signal?: AbortSignal } = {},
): Promise<RetrieveResult> {
  const { embedding, tokens, costUsd } = await embedQuery(query, opts.signal);

  let request = getSupabase().rpc("match_chunks", {
    query_embedding: toPgVector(embedding),
    match_count: opts.k ?? TOP_K,
    p_session_id: sessionId,
  });
  if (opts.signal) request = request.abortSignal(opts.signal);

  const { data, error } = await request;
  if (error) throw new Error(`match_chunks gagal: ${error.message}`);

  const sources: Source[] = matchRowsSchema.parse(data ?? []).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    filename: row.filename,
    chunkIndex: row.chunk_index,
    content: row.content,
    similarity: row.similarity,
  }));
  return { sources, embeddingTokens: tokens, embeddingCostUsd: costUsd };
}
