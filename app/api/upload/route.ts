// POST /api/upload — upload 1 dokumen (spec §2 & §3).
//
// Body = byte file mentah (BUKAN multipart): server bisa menghitung byte
// SELAGI membaca stream dan berhenti tepat saat melewati 5 MB. Nama file
// dikirim di header `X-Filename` (encodeURIComponent).

import { after } from "next/server";
import { z } from "zod";

import { MAX_FILE_BYTES, MAX_FILES_PER_SESSION, MAX_TOTAL_DOCUMENTS, STORAGE_BUCKET } from "@/lib/config";
import { processDocument } from "@/lib/rag/process";
import { maybeCleanupExpired } from "@/lib/server/cleanup";
import { documentRowSchema, toDocumentDTO } from "@/lib/server/documents";
import { errorFromUnknown, getClientIp, jsonError } from "@/lib/server/http";
import { uploadIpRateLimiter } from "@/lib/server/rateLimit";
import { requireSession } from "@/lib/server/session";
import {
  UNSUPPORTED_TYPE_MESSAGE,
  detectFileType,
  getAllowedExtension,
  readStreamWithLimit,
  sanitizeFilename,
  uniqueFilename,
} from "@/lib/server/upload";
import { DAILY_LIMIT_MESSAGE, isBudgetExhausted } from "@/lib/server/usage";
import { getSupabase } from "@/lib/supabase/client";
import type { DocumentDTO } from "@/lib/types";

// Ekstraksi + embedding berjalan di after() dan ikut batas waktu ini.
export const maxDuration = 60;

const FILE_TOO_LARGE_MESSAGE = "File melebihi 5 MB.";
const TOO_MANY_FILES_MESSAGE = `Maksimal ${MAX_FILES_PER_SESSION} file per sesi. Hapus salah satu dokumen dulu.`;
const SERVER_FULL_MESSAGE =
  "Server demo sedang penuh (terlalu banyak dokumen tersimpan). Coba lagi nanti — dokumen lama terhapus otomatis setelah 24 jam.";

const filenameRowsSchema = z.array(z.object({ filename: z.string() }));
// Fungsi SQL yang `returns documents` dikirim PostgREST sebagai 1 objek;
// terima juga bentuk array 1 elemen supaya tidak rapuh.
const createdRowSchema = z.union([
  documentRowSchema,
  z.array(documentRowSchema).length(1).transform((rows) => rows[0]),
]);

export async function POST(request: Request): Promise<Response> {
  try {
    // Di dalam try: requireSession bisa melempar ConfigError (env belum
    // lengkap) — harus tetap jadi JSON config_error, bukan 500 kosong.
    const auth = await requireSession();
    if (!auth.ok) return auth.response;
    const { sessionId } = auth;
    after(() => maybeCleanupExpired());

    // Batas 5 file berlaku per sesi, dan sesi baru bisa dibuat siapa pun yang
    // tahu passcode → rem tambahan per IP (hanya kalau IP-nya bisa dipercaya).
    const ip = getClientIp(request.headers);
    if (ip !== null) {
      const limit = uploadIpRateLimiter.check(`ip:${ip}`);
      if (!limit.allowed) {
        return jsonError(
          429,
          "rate_limited",
          `Terlalu banyak upload dari jaringan ini. Coba lagi dalam ${limit.retryAfterSec} detik.`,
          { retryable: true, retryAfterSec: limit.retryAfterSec },
        );
      }
    }

    if (await isBudgetExhausted()) {
      return jsonError(429, "daily_limit", DAILY_LIMIT_MESSAGE);
    }

    const supabase = getSupabase();
    // Cek cepat sebelum membaca body. Pengaman sebenarnya (atomic, anti
    // upload paralel — termasuk nama file kembar) ada di RPC create_document.
    const { data: existingData, error: existingError } = await supabase
      .from("documents")
      .select("filename")
      .eq("session_id", sessionId);
    if (existingError) throw new Error(`gagal membaca dokumen sesi: ${existingError.message}`);
    const existingNames = filenameRowsSchema.parse(existingData).map((row) => row.filename);
    if (existingNames.length >= MAX_FILES_PER_SESSION) {
      return jsonError(409, "too_many_files", TOO_MANY_FILES_MESSAGE);
    }

    const filename = uniqueFilename(
      sanitizeFilename(request.headers.get("x-filename") ?? ""),
      existingNames,
    );
    if (!getAllowedExtension(filename)) {
      return jsonError(415, "unsupported_type", UNSUPPORTED_TYPE_MESSAGE);
    }

    // Content-Length hanya dipakai untuk MENOLAK lebih awal (hemat bandwidth),
    // tidak pernah untuk menerima: yang menentukan tetap hitungan byte nyata.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
      return jsonError(413, "file_too_large", FILE_TOO_LARGE_MESSAGE);
    }

    let read: Awaited<ReturnType<typeof readStreamWithLimit>>;
    try {
      read = await readStreamWithLimit(request.body, MAX_FILE_BYTES);
    } catch {
      // Koneksi putus di tengah upload — bukan error server.
      return jsonError(400, "bad_request", "Upload terputus. Coba lagi.", { retryable: true });
    }
    if (!read.ok) {
      return read.reason === "too_large"
        ? jsonError(413, "file_too_large", FILE_TOO_LARGE_MESSAGE)
        : jsonError(400, "empty_file", "File kosong.");
    }

    const fileType = detectFileType(read.bytes, filename);
    if (!fileType.ok) return jsonError(415, "unsupported_type", fileType.message);

    // UUID dibuat DULU di server dan dipakai untuk storage path DAN id baris,
    // jadi file & baris selalu nyambung 1-1. Nama file asli tidak pernah jadi path.
    const id = crypto.randomUUID();
    const storagePath = id;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, read.bytes, { contentType: fileType.mimeType, upsert: false });
    if (uploadError) {
      // Belum ada baris yang dibuat → aman dicoba lagi. Pesan spesifik supaya
      // user tahu file-nya BELUM tersimpan (bukan "error server" umum).
      console.error(`[upload] upload ke Storage gagal (${storagePath}):`, uploadError.message);
      return jsonError(502, "internal", "Gagal menyimpan file ke storage. Coba upload lagi.", { retryable: true });
    }

    const { data: created, error: createError } = await supabase.rpc("create_document", {
      p_id: id,
      p_session_id: sessionId,
      p_filename: filename,
      p_storage_path: storagePath,
      p_mime_type: fileType.mimeType,
      p_size_bytes: read.bytes.byteLength,
      p_max_docs: MAX_FILES_PER_SESSION,
      p_max_total_docs: MAX_TOTAL_DOCUMENTS,
    });
    if (createError) {
      // Baris gagal dibuat → hapus file-nya supaya tidak ada file yatim di Storage.
      const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
      if (removeError) console.error(`[upload] gagal menghapus file yatim ${storagePath}:`, removeError.message);
      // Cek global DULU: "global_document_limit_reached" juga memuat "document_limit_reached".
      if (createError.message.includes("global_document_limit_reached")) {
        return jsonError(409, "too_many_files", SERVER_FULL_MESSAGE, { retryable: true });
      }
      if (createError.message.includes("document_limit_reached")) {
        return jsonError(409, "too_many_files", TOO_MANY_FILES_MESSAGE);
      }
      throw new Error(`create_document gagal: ${createError.message}`);
    }
    const row = createdRowSchema.parse(created);

    // Pemrosesan berat (extract → chunk → embed) setelah respons terkirim.
    const mimeType = fileType.mimeType;
    const bytes = read.bytes;
    after(() => processDocument({ id: row.id, mimeType }, bytes));

    const body: { document: DocumentDTO } = { document: toDocumentDTO(row) };
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorFromUnknown(err);
  }
}
