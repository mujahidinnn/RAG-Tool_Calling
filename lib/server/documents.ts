// Bentuk baris tabel `documents` + konversi ke DTO untuk client.
// MURNI (tanpa server-only) — dipakai route upload/documents dan tool
// list_uploaded_documents.

import { z } from "zod";

import type { DocumentDTO } from "@/lib/types";

/** Kolom yang dipilih dari tabel documents (tanpa `select *` supaya eksplisit). */
export const DOCUMENT_COLUMNS =
  "id, session_id, filename, storage_path, mime_type, size_bytes, status, error_message, created_at";

// supabase-js tanpa generated types mengembalikan `any` → validasi di sini.
export const documentRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  filename: z.string(),
  storage_path: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  status: z.enum(["processing", "ready", "failed"]),
  error_message: z.string().nullable(),
  created_at: z.string(),
});

export type DocumentRow = z.infer<typeof documentRowSchema>;

/** Baris hasil `select("..., chunks(count)")` — PostgREST mengirim `[{ count: n }]`. */
export const documentWithCountRowSchema = documentRowSchema.extend({
  chunks: z.array(z.object({ count: z.number().int() })).optional(),
});

export type DocumentWithCountRow = z.infer<typeof documentWithCountRowSchema>;

/**
 * Baris → DTO. Sengaja TIDAK menyertakan session_id & storage_path: client
 * tidak butuh, dan makin sedikit detail internal yang bocor makin baik.
 * `chunks` opsional, jadi baris tanpa join count tetap bisa dipakai.
 */
export function toDocumentDTO(
  row: Pick<
    DocumentRow,
    "id" | "filename" | "mime_type" | "size_bytes" | "status" | "error_message" | "created_at"
  > & { chunks?: { count: number }[] },
): DocumentDTO {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    chunkCount: row.chunks?.[0]?.count ?? 0,
  };
}
