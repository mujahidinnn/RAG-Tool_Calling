// GET    /api/documents          — daftar dokumen milik sesi ini (terbaru dulu)
// DELETE /api/documents?id=<uuid> — hapus 1 dokumen (Storage + baris; chunk ikut cascade)

import { after } from "next/server";
import { z } from "zod";

import { STORAGE_BUCKET } from "@/lib/config";
import { maybeCleanupExpired } from "@/lib/server/cleanup";
import { DOCUMENT_COLUMNS, documentWithCountRowSchema, toDocumentDTO } from "@/lib/server/documents";
import { errorFromUnknown, jsonError } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { isValidUuid } from "@/lib/server/uuid";
import { getSupabase } from "@/lib/supabase/client";
import type { DocumentsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  try {
    // Di dalam try: requireSession bisa melempar ConfigError (env belum
    // lengkap) — harus tetap jadi JSON config_error, bukan 500 kosong.
    const auth = await requireSession();
    if (!auth.ok) return auth.response;
    after(() => maybeCleanupExpired());

    const { data, error } = await getSupabase()
      .from("documents")
      // `chunks(count)` = jumlah chunk per dokumen dalam 1 query (lewat foreign key).
      .select(`${DOCUMENT_COLUMNS}, chunks(count)`)
      .eq("session_id", auth.sessionId) // WAJIB: dokumen sesi lain tidak boleh terlihat
      .order("created_at", { ascending: false });
    if (error) throw new Error(`gagal membaca daftar dokumen: ${error.message}`);

    const rows = z.array(documentWithCountRowSchema).parse(data ?? []);
    const body: DocumentsResponse = { documents: rows.map(toDocumentDTO) };
    // Status berubah terus selama processing (UI polling) → jangan di-cache.
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}

const storagePathSchema = z.object({ storage_path: z.string() });

export async function DELETE(request: Request): Promise<Response> {
  try {
    const auth = await requireSession();
    if (!auth.ok) return auth.response;

    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!isValidUuid(id)) return jsonError(400, "bad_request", "ID dokumen tidak valid.");

    const supabase = getSupabase();
    // Cari dengan id DAN session_id: dokumen sesi lain diperlakukan "tidak ada"
    // (404, bukan 403) supaya tidak membocorkan bahwa id itu eksis.
    const { data, error } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", id)
      .eq("session_id", auth.sessionId)
      .maybeSingle();
    if (error) throw new Error(`gagal mencari dokumen: ${error.message}`);
    if (!data) return jsonError(404, "not_found", "Dokumen tidak ditemukan.");
    const { storage_path: storagePath } = storagePathSchema.parse(data);

    // Urutan: file Storage DULU, baru baris. Kalau Storage gagal, baris tetap
    // ada sehingga user bisa mencoba lagi — kebalikannya meninggalkan file
    // yatim yang tidak bisa dihapus dari UI.
    const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    if (removeError && removeError.status !== 404) {
      console.error(`[documents] gagal menghapus file ${storagePath}:`, removeError.message);
      return jsonError(500, "internal", "Gagal menghapus file dokumen. Coba lagi.", { retryable: true });
    }

    // ON DELETE CASCADE di tabel chunks ikut menghapus semua chunk dokumen ini.
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", id)
      .eq("session_id", auth.sessionId);
    if (deleteError) throw new Error(`gagal menghapus dokumen: ${deleteError.message}`);

    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}
