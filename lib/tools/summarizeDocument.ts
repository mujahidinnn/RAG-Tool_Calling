import "server-only";

// Tool `get_document_summary` (spec §5): ringkasan SATU dokumen dari
// keseluruhan isinya — bukan dari 1 chunk hasil retrieval saja.

import { z } from "zod";

import { CHUNK_TOKENS, SUMMARY_MAX_INPUT_TOKENS } from "@/lib/config";
import { collectStream } from "@/lib/llm";
import type { Tool } from "@/lib/llm/types";
import { SUMMARY_SYSTEM_PROMPT, formatContext } from "@/lib/rag/prompt";
import { DOCUMENT_COLUMNS, documentRowSchema } from "@/lib/server/documents";
import { estimateTokens, mayHaveBeenBilled } from "@/lib/server/usage-estimate";
import { isValidUuid } from "@/lib/server/uuid";
import { getSupabase } from "@/lib/supabase/client";
import type { Source } from "@/lib/types";

import {
  NO_USAGE,
  pickEvenlySpaced,
  toolErrorResult,
  withAbortSignal,
  type ToolContext,
  type ToolExecutionResult,
} from "./shared";

export const summarizeDocumentTool: Tool = {
  name: "get_document_summary",
  description:
    "Membuat ringkasan singkat SATU dokumen dari keseluruhan isinya (awal, tengah, sampai akhir), " +
    "bukan dari satu potongan saja. Panggil saat user meminta ringkasan/ikhtisar sebuah dokumen. " +
    "Butuh document_id (UUID): kalau belum tahu, panggil list_uploaded_documents dulu untuk " +
    "mendapatkannya — jangan menebak id.",
  input_schema: {
    type: "object",
    properties: {
      document_id: {
        type: "string",
        description: "ID dokumen (UUID) dari hasil list_uploaded_documents.",
      },
    },
    required: ["document_id"],
    additionalProperties: false,
  },
};

/**
 * Maks potongan yang dikirim ke LLM. Tiap chunk paling banyak CHUNK_TOKENS
 * token (lihat lib/rag/chunk.ts), jadi N chunk ≤ SUMMARY_MAX_INPUT_TOKENS.
 * Dengan angka ini kita tahu chunk mana yang perlu SEBELUM mengambil isinya
 * — dokumen 5 MB bisa berisi ribuan chunk; mengambil semuanya hanya untuk
 * membuang sebagian besar = boros memori & kena batas 1.000 baris PostgREST.
 */
const MAX_SUMMARY_CHUNKS = Math.max(1, Math.floor(SUMMARY_MAX_INPUT_TOKENS / CHUNK_TOKENS));
/** Ringkasan ±200 kata, plus ruang untuk token reasoning/thinking model. */
const SUMMARY_MAX_OUTPUT_TOKENS = 1500;

const INVALID_ID_MESSAGE =
  "document_id tidak valid. Panggil list_uploaded_documents dulu untuk mendapatkan document_id (UUID) yang benar.";

// Input dari model tidak tepercaya (dan dengan eager_input_streaming bisa
// berupa JSON rusak) → validasi ketat sebelum menyentuh database.
const inputSchema = z.object({
  document_id: z.string().trim().refine(isValidUuid),
});

const chunkRowsSchema = z.array(z.object({ chunk_index: z.number().int(), content: z.string() }));

export async function runSummarizeDocument(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = inputSchema.safeParse(input);
  if (!parsedInput.success) return toolErrorResult(INVALID_ID_MESSAGE);
  const documentId = parsedInput.data.document_id.toLowerCase();
  const supabase = getSupabase();

  // 1. Dokumen harus milik sesi ini. Dokumen sesi lain diperlakukan "tidak
  //    ada" — model tidak boleh bisa meringkas dokumen orang lain walau
  //    menebak/mendapat id-nya dari isi dokumen yang di-inject.
  const docQuery = supabase
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("id", documentId)
    .eq("session_id", ctx.sessionId);
  const { data: docData, error: docError } = await withAbortSignal(docQuery, ctx.signal).maybeSingle();
  if (docError) return dbFailure("membaca dokumen", docError.message, ctx.signal);
  if (!docData) {
    return toolErrorResult(
      "Dokumen dengan id itu tidak ditemukan di sesi ini. Panggil list_uploaded_documents untuk melihat id yang tersedia.",
    );
  }
  const docParsed = documentRowSchema.safeParse(docData);
  if (!docParsed.success) return dbFailure("membaca dokumen", "bentuk data tidak terduga", ctx.signal);
  const doc = docParsed.data;

  if (doc.status === "processing") {
    return toolErrorResult(`Dokumen "${doc.filename}" masih diproses. Coba lagi setelah statusnya ready.`);
  }
  if (doc.status === "failed") {
    const reason = doc.error_message ? ` (${doc.error_message})` : "";
    return toolErrorResult(`Dokumen "${doc.filename}" gagal diproses${reason}, jadi tidak bisa diringkas.`);
  }

  // 2. Hitung chunk dulu (murah, tanpa isi), lalu tentukan chunk mana yang
  //    diambil. Kepemilikan dokumen sudah dicek di langkah 1, jadi filter
  //    document_id saja cukup di sini.
  const countQuery = supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId);
  const { count, error: countError } = await withAbortSignal(countQuery, ctx.signal);
  if (countError) return dbFailure("menghitung potongan dokumen", countError.message, ctx.signal);
  const totalChunks = count ?? 0;
  if (totalChunks === 0) {
    return toolErrorResult(`Dokumen "${doc.filename}" tidak punya potongan teks untuk diringkas.`);
  }

  // Dokumen pendek → semua chunk. Dokumen panjang → sampel merata dari awal
  // sampai akhir, supaya ringkasan tidak hanya menceritakan bab pertama.
  // Asumsi: chunk_index berurutan 0..n-1 (begitulah lib/rag/process.ts menyimpannya).
  const indices = pickEvenlySpaced(totalChunks, MAX_SUMMARY_CHUNKS);
  const sampled = indices.length < totalChunks;
  let chunkQuery = supabase.from("chunks").select("chunk_index, content").eq("document_id", documentId);
  if (sampled) chunkQuery = chunkQuery.in("chunk_index", indices);
  chunkQuery = chunkQuery.order("chunk_index", { ascending: true }).limit(MAX_SUMMARY_CHUNKS);

  const { data: chunkData, error: chunkError } = await withAbortSignal(chunkQuery, ctx.signal);
  if (chunkError) return dbFailure("membaca potongan dokumen", chunkError.message, ctx.signal);
  const chunksParsed = chunkRowsSchema.safeParse(chunkData ?? []);
  if (!chunksParsed.success) return dbFailure("membaca potongan dokumen", "bentuk data tidak terduga", ctx.signal);
  const chunks = chunksParsed.data;
  if (chunks.length === 0) {
    return toolErrorResult(`Dokumen "${doc.filename}" tidak punya potongan teks untuk diringkas.`);
  }

  // 3. Ringkas dengan provider pilihan user. formatContext dipakai ulang
  //    supaya escaping tag pembungkus (mitigasi prompt injection) sama persis
  //    dengan context chat biasa.
  const sources: Source[] = chunks.map((chunk) => ({
    id: `${documentId}:${chunk.chunk_index}`,
    documentId,
    filename: doc.filename,
    chunkIndex: chunk.chunk_index,
    content: chunk.content,
    similarity: 1,
  }));
  const coverage = sampled
    ? `${chunks.length} dari ${totalChunks} potongan (sampel merata dari awal sampai akhir dokumen)`
    : `semua ${totalChunks} potongan`;
  const prompt = [
    `Dokumen: ${JSON.stringify(doc.filename)}`,
    `Potongan yang diberikan: ${coverage}.`,
    "",
    formatContext(sources),
    "",
    "Buat ringkasan dokumen ini.",
  ].join("\n");

  let result: Awaited<ReturnType<typeof collectStream>>;
  try {
    result = await collectStream(
      ctx.provider.streamChat([{ role: "user", content: prompt }], "", undefined, {
        system: SUMMARY_SYSTEM_PROMPT,
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        signal: ctx.signal,
      }),
    );
  } catch (err) {
    // Angka token tidak pernah datang kalau stream gagal → catat estimasi
    // input (lihat lib/server/usage-estimate.ts) supaya daily cap tetap jujur.
    const usage = mayHaveBeenBilled(err)
      ? { inputTokens: estimateTokens(SUMMARY_SYSTEM_PROMPT + prompt), outputTokens: 0 }
      : NO_USAGE;
    const isProviderError = err instanceof Error && err.name === "ProviderError";
    if (!isProviderError) console.error("[tools] get_document_summary gagal:", err);
    // Pesan ProviderError memang dibuat untuk ditampilkan (menyebut provider & sebabnya).
    const reason = isProviderError ? err.message : "terjadi kesalahan saat memanggil model.";
    return toolErrorResult(`Gagal membuat ringkasan "${doc.filename}": ${reason}`, usage);
  }

  const usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  const summary = result.text.trim();
  if (summary === "") {
    return toolErrorResult(`Model tidak menghasilkan ringkasan untuk "${doc.filename}". Coba lagi.`, usage);
  }

  return {
    content: JSON.stringify({
      document_id: documentId,
      filename: doc.filename,
      chunks_used: chunks.length,
      total_chunks: totalChunks,
      sampled,
      summary,
    }),
    payload: {
      kind: "summary",
      documentId,
      filename: doc.filename,
      summary,
      chunksUsed: chunks.length,
      totalChunks,
    },
    usage,
  };
}

function dbFailure(action: string, detail: string, signal: AbortSignal | undefined): ToolExecutionResult {
  // Query yang gagal karena client sudah pergi tidak perlu mengotori log.
  if (!signal?.aborted) console.error(`[tools] get_document_summary gagal ${action}:`, detail);
  return toolErrorResult(`Gagal ${action} dari database. Coba lagi sebentar lagi.`);
}
