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
 * fungsi serverless dihentikan (maxDuration) di tengah pemrosesan. Tanpa ini
 * status-nya "processing" selamanya dan UI terus polling.
 */
const STALE_PROCESSING_MINUTES = 15;

const expiredRowSchema = z.array(z.object({ id: z.string(), storage_path: z.string() }));

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
  } catch (err) {
    console.error("[cleanup] gagal:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

async function markStaleProcessingFailed(now: number): Promise<void> {
  const cutoff = new Date(now - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString();
  const { error } = await getSupabase()
    .from("documents")
    .update({
      status: "failed",
      error_message: "Pemrosesan dokumen terhenti (timeout). Hapus lalu upload ulang.",
    })
    .eq("status", "processing")
    .lt("created_at", cutoff);
  if (error) throw new Error(`gagal menandai dokumen macet: ${error.message}`);
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
