// Estimasi token untuk panggilan LLM yang GAGAL / DIBATALKAN di tengah jalan.
// PURE (tanpa server-only / next / env) — dipakai route chat & tool ringkasan.
//
// Kenapa perlu: jumlah token baru dikirim provider di AKHIR stream (event
// `done`). Kalau stream putus — client menutup tab, timeout, server provider
// error — angka itu tidak pernah datang, padahal token yang sudah diproses
// TETAP ditagih. Kalau dicatat 0, bot yang sengaja memutus koneksi setiap
// kali bisa memakai LLM "gratis" tanpa pernah menyentuh daily cap. Jadi kita
// catat estimasi yang sengaja dibulatkan ke atas.

import { ProviderError, type ProviderErrorCode } from "@/lib/llm/types";

/**
 * Rata-rata nyata ±4 karakter/token (Inggris & Indonesia). Pakai 3 supaya
 * estimasi cenderung LEBIH BESAR — untuk menjaga budget, kelebihan hitung
 * lebih aman daripada kekurangan. Tidak pakai tokenizer sungguhan: tiap
 * provider punya tokenizer sendiri, dan ini hanya jalur cadangan.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/** Perkiraan jumlah token dari panjang teks (dibulatkan ke atas). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Error yang terjadi SEBELUM model memproses apa pun: request ditolak di
 * pintu (key tidak ada/salah, request tidak valid, kena rate limit). Provider
 * tidak menagih ini — kalau tetap diestimasi, demo "salahkan API key" (spec
 * §10) yang dicoba berulang kali akan menghabiskan budget harian palsu.
 */
const REJECTED_BEFORE_PROCESSING: ReadonlySet<string> = new Set<ProviderErrorCode>([
  "missing_key",
  "auth",
  "bad_request",
  "rate_limit",
]);

// `instanceof` bisa gagal kalau modul termuat 2x (bundler/test) → cek `name` juga.
function providerErrorCode(err: unknown): string | null {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof Error && err.name === "ProviderError" && "code" in err) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

/**
 * Apakah panggilan LLM yang gagal dengan error ini kemungkinan tetap
 * ditagih. Ragu → anggap ditagih (aman untuk budget).
 */
export function mayHaveBeenBilled(err: unknown): boolean {
  const code = providerErrorCode(err);
  return code === null || !REJECTED_BEFORE_PROCESSING.has(code);
}
