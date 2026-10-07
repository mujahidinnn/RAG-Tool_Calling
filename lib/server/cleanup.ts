import "server-only";

// Auto-hapus dokumen > DOCUMENT_TTL_HOURS (spec §2, privasi demo publik).
// Tidak pakai scheduler terpisah: route memanggil `after(() => maybeCleanupExpired())`
// sehingga cleanup jalan SETELAH respons terkirim (user tidak menunggu), dan
// di-throttle supaya tidak membebani database di setiap request.

import { z } from "zod";
import { DOCUMENT_TTL_HOURS, STORAGE_BUCKET } from "@/lib/config";
import { getSupabase } from "@/lib/supabase/client";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // maks 1x per 10 menit per instance
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 10; // batasi kerja 1 putaran (maks 1.000 dokumen)
/**
 * Dokumen yang masih "processing" selama ini dianggap macet — biasanya karena
 * fungsi serverless dihentikan (maxDuration 60 dtk) di tengah pemrosesan.
 * Tanpa ini status-nya "processing" selamanya dan UI terus polling.
 * created_at diisi SETELAH body terupload, dan dokumen dibatasi
 * MAX_DOCUMENT_TOKENS, jadi pemrosesan normal selesai jauh di bawah ini
 * (sisa ruang untuk retry embedding di server self-host tanpa maxDuration).
 */
const STALE_PROCESSING_MINUTES = 5;
/** Maks objek Storage yang diperiksa per putaran sweep file yatim. */
const ORPHAN_SCAN_LIMIT = 100;

const expiredRowSchema = z.array(z.object({ id: z.string(), storage_path: z.string() }));
const idRowsSchema = z.array(z.object({ id: z.string() }));
const storagePathRowsSchema = z.array(z.object({ storage_path: z.string() }));

let lastRunAt = 0;
let running = false;

/** Jalankan cleanup kalau sudah waktunya. Tidak pernah throw (aman di after()). */
export async function maybeCleanupExpired(): Promise<void> {
  const now = Date.now();
  if (running || now - lastRunAt < CLEANUP_INTERVAL_MS) return;
  // Tandai di awal supaya request paralel tidak ikut menjalankan cleanup.
  running = true;
  lastRunAt = now;
  try {
    await markStaleProcessingFailed(now);
    const deleted = await deleteExpiredDocuments(now);
    if (deleted > 0) console.info(`[cleanup] ${deleted} dokumen kadaluarsa dihapus`);
    const orphans = await deleteOrphanFiles(now);
    if (orphans > 0) console.info(`[cleanup] ${orphans} file yatim di Storage dihapus`);
  } catch (err) {
    console.error("[cleanup] gagal:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

async function markStaleProcessingFailed(now: number): Promise<void> {
  const supabase = getSupabase();
  const cutoff = new Date(now - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("documents")
    .update({
      status: "failed",
      error_message: "Pemrosesan dokumen terhenti (timeout). Hapus lalu upload ulang.",
    })
    .eq("status", "processing")
    .lt("created_at", cutoff)
    .select("id");
  if (error) throw new Error(`gagal menandai dokumen macet: ${error.message}`);

  // Chunk yang sempat masuk sebelum fungsi dimatikan tidak akan pernah dipakai
  // (dokumen tidak akan "ready") — jangan biarkan memenuhi database 24 jam.
  const ids = idRowsSchema.parse(data ?? []).map((row) => row.id);
  if (ids.length === 0) return;
  const { error: chunkError } = await supabase.from("chunks").delete().in("document_id", ids);
  if (chunkError) throw new Error(`gagal menghapus chunk dokumen macet: ${chunkError.message}`);
}

async function deleteExpiredDocuments(now: number): Promise<number> {
  const supabase = getSupabase();
  const cutoff = new Date(now - DOCUMENT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  let total = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, storage_path")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (error) throw new Error(`gagal mencari dokumen kadaluarsa: ${error.message}`);

    const rows = expiredRowSchema.parse(data);
    if (rows.length === 0) break;

    // Urutan penting: hapus file di Storage DULU, baru baris database.
    // Kalau Storage gagal, baris tetap ada → dicoba lagi di putaran berikutnya.
    // Kebalikannya (hapus baris dulu) bisa meninggalkan file yatim selamanya.
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(rows.map((row) => row.storage_path));
    if (storageError) throw new Error(`gagal menghapus file Storage: ${storageError.message}`);

    // Chunk ikut terhapus lewat ON DELETE CASCADE.
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .in(
        "id",
        rows.map((row) => row.id),
      );
    if (deleteError) throw new Error(`gagal menghapus baris dokumen: ${deleteError.message}`);

    total += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

/**
 * File di Storage TANPA baris `documents`. Upload menyimpan file DULU baru
 * membuat baris (spec §2); kalau fungsi mati di antara keduanya, file itu
 * tidak terlihat oleh deleteExpiredDocuments (yang berangkat dari baris).
 * Hanya file yang lebih tua dari DOCUMENT_TTL_HOURS yang diperiksa: upload
 * yang sedang berjalan pasti jauh lebih muda, dan baris normal seumur itu
 * sudah dihapus beserta file-nya.
 */
async function deleteOrphanFiles(now: number): Promise<number> {
  const supabase = getSupabase();
  const cutoff = now - DOCUMENT_TTL_HOURS * 60 * 60 * 1000;

  const { data: files, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list("", { limit: ORPHAN_SCAN_LIMIT, sortBy: { column: "created_at", order: "asc" } });
  if (error) throw new Error(`gagal membaca daftar file Storage: ${error.message}`);

  const candidates = files
    .filter((file) => file.id !== null && file.created_at !== null && Date.parse(file.created_at) < cutoff)
    .map((file) => file.name);
  if (candidates.length === 0) return 0;

  const { data: rows, error: rowsError } = await supabase
    .from("documents")
    .select("storage_path")
    .in("storage_path", candidates);
  if (rowsError) throw new Error(`gagal mencocokkan file Storage: ${rowsError.message}`);
  const referenced = new Set(storagePathRowsSchema.parse(rows ?? []).map((row) => row.storage_path));

  const orphans = candidates.filter((name) => !referenced.has(name));
  if (orphans.length === 0) return 0;
  const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove(orphans);
  if (removeError) throw new Error(`gagal menghapus file yatim: ${removeError.message}`);
  return orphans.length;
}
