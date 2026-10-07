import "server-only";

// Tool `list_uploaded_documents` (spec §5): daftar dokumen milik sesi ini.

import { z } from "zod";

import type { Tool } from "@/lib/llm/types";
import { DOCUMENT_COLUMNS, documentWithCountRowSchema, toDocumentDTO } from "@/lib/server/documents";
import { getSupabase } from "@/lib/supabase/client";
import type { ToolCardPayload } from "@/lib/types";

import {
  NO_USAGE,
  toolErrorResult,
  withAbortSignal,
  type ToolContext,
  type ToolExecutionResult,
} from "./shared";

export const listDocumentsTool: Tool = {
  name: "list_uploaded_documents",
  description:
    "Mengembalikan daftar dokumen yang sudah diupload user di sesi ini beserta statusnya " +
    "(processing/ready/failed), ukuran, jumlah potongan, waktu upload, dan id-nya. " +
    "Panggil saat user bertanya dokumen apa saja yang ada atau statusnya, atau saat kamu " +
    "butuh document_id untuk get_document_summary.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

type DocumentsCard = Extract<ToolCardPayload, { kind: "documents" }>;

/**
 * Jalankan tool. `input` sengaja diabaikan: tool ini tanpa parameter, jadi
 * argumen aneh dari model (mis. JSON rusak) tidak perlu membuatnya gagal.
 */
export async function runListDocuments(
  _input: unknown,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const query = getSupabase()
    .from("documents")
    .select(`${DOCUMENT_COLUMNS}, chunks(count)`)
    // WAJIB: service role melewati RLS, jadi filter sesi ada di tangan kita.
    // Tanpa ini model bisa "melihat" dokumen milik pengunjung lain.
    .eq("session_id", ctx.sessionId)
    .order("created_at", { ascending: false });

  const { data, error } = await withAbortSignal(query, ctx.signal);
  if (error) {
    if (!ctx.signal?.aborted) console.error("[tools] list_uploaded_documents gagal:", error.message);
    return toolErrorResult("Gagal membaca daftar dokumen dari database. Coba lagi sebentar lagi.");
  }

  const parsed = z.array(documentWithCountRowSchema).safeParse(data ?? []);
  if (!parsed.success) {
    console.error("[tools] list_uploaded_documents: bentuk data tidak terduga");
    return toolErrorResult("Gagal membaca daftar dokumen (format data tidak terduga).");
  }

  const documents: DocumentsCard["documents"] = parsed.data.map((row) => {
    const dto = toDocumentDTO(row);
    return {
      id: dto.id,
      filename: dto.filename,
      status: dto.status,
      sizeBytes: dto.sizeBytes,
      createdAt: dto.createdAt,
      errorMessage: dto.errorMessage,
      chunkCount: dto.chunkCount,
    };
  });

  // Untuk model: JSON ringkas. Nama file adalah input user (tidak tepercaya);
  // di dalam JSON ia jelas berupa DATA, bukan instruksi.
  const content = JSON.stringify({
    total: documents.length,
    documents: documents.map((doc) => ({
      document_id: doc.id,
      filename: doc.filename,
      status: doc.status,
      size_bytes: doc.sizeBytes,
      chunk_count: doc.chunkCount,
      uploaded_at: doc.createdAt,
      ...(doc.errorMessage ? { error_message: doc.errorMessage } : {}),
    })),
    ...(documents.length === 0 ? { note: "Belum ada dokumen yang diupload di sesi ini." } : {}),
  });

  return { content, payload: { kind: "documents", documents }, usage: NO_USAGE };
}
