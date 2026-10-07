import "server-only";

// Orkestrasi ingestion (spec §3.1–3.3): extract → chunk → embed → simpan.
// Dipanggil lewat `after()` dari route upload: user langsung dapat respons
// (status "processing") dan UI polling sampai status jadi "ready"/"failed".

import { MAX_DOCUMENT_TOKENS, MIN_EXTRACTED_CHARS, type AllowedMimeType } from "@/lib/config";
import { ConfigError, getServerEnv } from "@/lib/env";
import { embeddingCostUsd } from "@/lib/llm/pricing";
import { ProviderError } from "@/lib/llm/types";
import { DAILY_LIMIT_MESSAGE, reserveBudget, settleUsage } from "@/lib/server/usage";
import { getSupabase } from "@/lib/supabase/client";

import { DocumentTooLongError, chunkText, type TextChunk } from "./chunk";
import { embedTexts, toPgVector } from "./embed";
import { DOCUMENT_TOO_LONG_MESSAGE, ExtractionError, extractText } from "./extract";
import { hasEnoughReadablePdfText, hasEnoughReadableText } from "./normalize";

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
    const { text, pageCount } = await extractText(bytes, doc.mimeType);
    // PDF hasil scan (tanpa text layer, atau cuma watermark/nomor halaman) →
    // jangan lanjut chunking teks yang tidak bisa ditanya.
    const readable =
      pageCount === null
        ? hasEnoughReadableText(text, MIN_EXTRACTED_CHARS)
        : hasEnoughReadablePdfText(text, pageCount, MIN_EXTRACTED_CHARS);
    // Batas token dicek SELAGI tokenisasi (DocumentTooLongError): dokumen
    // raksasa ditolak sebelum ada biaya embedding / baris database.
    const chunks = readable ? chunkText(text, { maxTokens: MAX_DOCUMENT_TOKENS }) : [];
    if (chunks.length === 0) {
      await markFailed(doc.id, doc.mimeType === "application/pdf" ? NO_TEXT_MESSAGE : TOO_LITTLE_TEXT_MESSAGE);
      return;
    }

    // Trim hanya untuk tampilan (panel sitasi); overlap antar chunk tetap ada.
    const contents = chunks.map((chunk) => chunk.content.trim());
    const embeddings = await embedWithReservation(doc.id, chunks, contents);
    if (embeddings === null) return; // budget habis — status sudah "failed"

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
    // Hanya dari "processing": kalau cleanup sudah menandainya macet/failed
    // (lib/server/cleanup.ts), jangan dihidupkan lagi dengan chunk yang mungkin
    // sudah dihapus sebagian.
    const { data: updated, error } = await supabase
      .from("documents")
      .update({ status: "ready", error_message: null })
      .eq("id", doc.id)
      .eq("status", "processing")
      .select("id");
    if (error) throw new Error(`update status ready gagal: ${error.message}`);
    if (!updated || updated.length === 0) {
      console.warn(`[process] dokumen ${doc.id} sudah tidak "processing" (dihapus / ditandai macet) — chunk dibuang.`);
      await deleteChunks(doc.id);
    }
  } catch (err) {
    // Log tanpa isi dokumen — cukup jenis & pesan error.
    console.error(`[process] dokumen ${doc.id} gagal:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
    await markFailed(doc.id, toUserMessage(err));
  }
}

/**
 * Embedding dengan reservasi budget harian yang ATOMIC (spec §2). Jumlah
 * token sudah diketahui SEBELUM memanggil API — tokenizer chunk (cl100k) sama
 * dengan milik model embedding — jadi biaya maksimalnya dipesan dulu:
 * upload paralel tidak bisa bersama-sama lolos cek "budget belum habis".
 * Token batch yang selesai dicatat walau batch berikutnya gagal; kalau fungsi
 * dimatikan platform di tengah jalan, reservasi tetap terpesan penuh (aman).
 * Mengembalikan null kalau budget habis (dokumen sudah ditandai failed).
 */
async function embedWithReservation(
  documentId: string,
  chunks: TextChunk[],
  contents: string[],
): Promise<number[][] | null> {
  const model = getServerEnv().embeddingModel;
  const maxTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
  const reserved = await reserveBudget(embeddingCostUsd(model, maxTokens));
  if (!reserved.ok) {
    await markFailed(documentId, DAILY_LIMIT_MESSAGE);
    return null;
  }

  let embeddedTokens = 0;
  try {
    const { embeddings } = await embedTexts(contents, undefined, (tokens) => {
      embeddedTokens += tokens;
    });
    return embeddings;
  } finally {
    await settleUsage(reserved.reservation, {
      tokens: embeddedTokens,
      costUsd: embeddingCostUsd(model, embeddedTokens),
    });
  }
}

/** Pesan yang aman & berguna untuk user (tanpa stack trace / detail SQL). */
function toUserMessage(err: unknown): string {
  if (err instanceof DocumentTooLongError) return DOCUMENT_TOO_LONG_MESSAGE;
  if (err instanceof ExtractionError) return err.message;
  if (err instanceof ProviderError) return err.message;
  if (err instanceof ConfigError) return err.message;
  return GENERIC_FAILURE_MESSAGE;
}

/** Hapus chunk 1 dokumen (dokumen tidak akan "ready"). Tidak pernah throw. */
async function deleteChunks(documentId: string): Promise<void> {
  try {
    const { error } = await getSupabase().from("chunks").delete().eq("document_id", documentId);
    if (error) console.error(`[process] hapus chunk ${documentId} gagal:`, error.message);
  } catch (err) {
    console.error(`[process] hapus chunk ${documentId} gagal:`, err instanceof Error ? err.message : err);
  }
}

/** Set status failed + hapus chunk yang sempat tersimpan. Tidak pernah throw. */
async function markFailed(documentId: string, message: string): Promise<void> {
  try {
    const supabase = getSupabase();
    // Chunk dari batch yang sempat masuk tidak berguna (dokumen tidak akan "ready").
    await deleteChunks(documentId);

    const { error } = await supabase
      .from("documents")
      .update({ status: "failed", error_message: message })
      .eq("id", documentId);
    if (error) console.error(`[process] set failed ${documentId} gagal:`, error.message);
  } catch (err) {
    console.error(`[process] markFailed ${documentId} gagal:`, err instanceof Error ? err.message : err);
  }
}
