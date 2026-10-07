import "server-only";

// Orkestrasi ingestion (spec §3.1–3.3): extract → chunk → embed → simpan.
// Dipanggil lewat `after()` dari route upload: user langsung dapat respons
// (status "processing") dan UI polling sampai status jadi "ready"/"failed".

import { MIN_EXTRACTED_CHARS, type AllowedMimeType } from "@/lib/config";
import { ConfigError } from "@/lib/env";
import { ProviderError } from "@/lib/llm/types";
import { DAILY_LIMIT_MESSAGE, isBudgetExhausted, recordUsage } from "@/lib/server/usage";
import { getSupabase } from "@/lib/supabase/client";

import { chunkText } from "./chunk";
import { embedTexts, toPgVector } from "./embed";
import { ExtractionError, extractText } from "./extract";
import { hasEnoughReadableText } from "./normalize";

export const NO_TEXT_MESSAGE = "Tidak ada teks terbaca di file ini (mungkin PDF hasil scan/gambar).";
const TOO_LITTLE_TEXT_MESSAGE = `Isi file terlalu sedikit untuk diproses (minimal ${MIN_EXTRACTED_CHARS} huruf/angka).`;
const GENERIC_FAILURE_MESSAGE =
  "Terjadi kesalahan saat memproses dokumen. Hapus dokumen ini lalu coba upload ulang.";

/**
 * Baris per insert. 1 baris membawa vector 1536 angka (±20 KB sebagai teks),
 * jadi 100 baris ≈ 2 MB per request — aman untuk batas body PostgREST.
 */
const INSERT_BATCH_SIZE = 100;

/**
 * Proses 1 dokumen sampai status akhir. TIDAK PERNAH throw: berjalan di
 * after(), di mana error yang lolos hanya jadi log dan dokumen akan
 * "processing" selamanya. Semua kegagalan → status "failed" + pesan untuk user.
 */
export async function processDocument(
  doc: { id: string; mimeType: AllowedMimeType },
  bytes: Uint8Array,
): Promise<void> {
  try {
    const text = await extractText(bytes, doc.mimeType);
    // PDF hasil scan (tanpa text layer) → jangan lanjut chunking teks kosong.
    const chunks = hasEnoughReadableText(text, MIN_EXTRACTED_CHARS) ? chunkText(text) : [];
    if (chunks.length === 0) {
      await markFailed(doc.id, doc.mimeType === "application/pdf" ? NO_TEXT_MESSAGE : TOO_LITTLE_TEXT_MESSAGE);
      return;
    }

    // Embedding juga memakan budget harian (global, semua sesi).
    if (await isBudgetExhausted()) {
      await markFailed(doc.id, DAILY_LIMIT_MESSAGE);
      return;
    }

    // Trim hanya untuk tampilan (panel sitasi); overlap antar chunk tetap ada.
    const contents = chunks.map((chunk) => chunk.content.trim());
    const { embeddings, tokens, costUsd } = await embedTexts(contents);
    // Catat SEGERA setelah embed: biayanya sudah terjadi walau insert nanti gagal.
    await recordUsage({ tokens, costUsd });

    const supabase = getSupabase();
    for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
      const rows = chunks.slice(i, i + INSERT_BATCH_SIZE).map((chunk, j) => ({
        document_id: doc.id,
        chunk_index: chunk.index,
        content: contents[i + j],
        embedding: toPgVector(embeddings[i + j]),
      }));
      const { error } = await supabase.from("chunks").insert(rows);
      // Dokumen dihapus user di tengah proses → FK gagal → jatuh ke catch (aman).
      if (error) throw new Error(`insert chunks gagal: ${error.message}`);
    }

    // Status "ready" baru diset setelah SEMUA chunk tersimpan, jadi match_chunks
    // (yang hanya mencari dokumen ready) tidak pernah melihat dokumen setengah jadi.
    const { error } = await supabase
      .from("documents")
      .update({ status: "ready", error_message: null })
      .eq("id", doc.id);
    if (error) throw new Error(`update status ready gagal: ${error.message}`);
  } catch (err) {
    // Log tanpa isi dokumen — cukup jenis & pesan error.
    console.error(`[process] dokumen ${doc.id} gagal:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
    await markFailed(doc.id, toUserMessage(err));
  }
}

/** Pesan yang aman & berguna untuk user (tanpa stack trace / detail SQL). */
function toUserMessage(err: unknown): string {
  if (err instanceof ExtractionError) return err.message;
  if (err instanceof ProviderError) return err.message;
  if (err instanceof ConfigError) return err.message;
  return GENERIC_FAILURE_MESSAGE;
}

/** Set status failed + hapus chunk yang sempat tersimpan. Tidak pernah throw. */
async function markFailed(documentId: string, message: string): Promise<void> {
  try {
    const supabase = getSupabase();
    // Chunk dari batch yang sempat masuk tidak berguna (dokumen tidak akan "ready").
    const { error: deleteError } = await supabase.from("chunks").delete().eq("document_id", documentId);
    if (deleteError) console.error(`[process] hapus chunk ${documentId} gagal:`, deleteError.message);

    const { error } = await supabase
      .from("documents")
      .update({ status: "failed", error_message: message })
      .eq("id", documentId);
    if (error) console.error(`[process] set failed ${documentId} gagal:`, error.message);
  } catch (err) {
    console.error(`[process] markFailed ${documentId} gagal:`, err instanceof Error ? err.message : err);
  }
}
