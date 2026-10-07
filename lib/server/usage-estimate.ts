// Estimasi token untuk panggilan LLM yang GAGAL / DIBATALKAN di tengah jalan.
// PURE (tanpa server-only / next / env) — dipakai route chat & tool ringkasan.
//
// Kenapa perlu: jumlah token baru dikirim provider di AKHIR stream (event
// `done`). Kalau stream putus — client menutup tab, timeout, server provider
// error — angka itu tidak pernah datang, padahal token yang sudah diproses
// TETAP ditagih. Kalau dicatat 0, bot yang sengaja memutus koneksi setiap
// kali bisa memakai LLM "gratis" tanpa pernah menyentuh daily cap. Jadi kita
// catat estimasi yang sengaja dibulatkan ke atas.

import { ProviderError, type ProviderErrorCode, type TokenUsage } from "@/lib/llm/types";

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
function asProviderErrorLike(err: unknown): { code: unknown; status?: unknown; usage?: unknown } | null {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && err.name === "ProviderError" && "code" in err) return err;
  return null;
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const { inputTokens, outputTokens } = value as Record<string, unknown>;
  return (
    typeof inputTokens === "number" &&
    Number.isFinite(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0
  );
}

/**
 * Apakah panggilan LLM yang gagal dengan error ini kemungkinan tetap
 * ditagih. Ragu → anggap ditagih (aman untuk budget).
 */
export function mayHaveBeenBilled(err: unknown): boolean {
  const providerError = asProviderErrorLike(err);
  if (providerError === null) return true;
  if (typeof providerError.code === "string" && REJECTED_BEFORE_PROCESSING.has(providerError.code)) return false;
  // Error yang membawa HTTP status = provider menolak request SEBELUM stream
  // dimulai (mis. 529 overloaded / 500 setelah semua retry SDK). Tidak ada
  // token yang diproses → tidak ditagih. Error di TENGAH stream tidak punya
  // status (SDK membuatnya dari event SSE), jadi tetap diestimasi.
  if (typeof providerError.status === "number") return false;
  return true;
}

/** Token yang sudah dilaporkan provider sebelum error (ProviderError.usage), atau null. */
export function reportedUsage(err: unknown): TokenUsage | null {
  const usage = asProviderErrorLike(err)?.usage;
  return isTokenUsage(usage) ? usage : null;
}

/**
 * Token yang dicatat untuk panggilan LLM yang gagal:
 * 1. angka dari provider kalau sudah sempat dilaporkan (paling akurat);
 * 2. 0 kalau request ditolak sebelum diproses (tidak ditagih);
 * 3. selain itu estimasi dari teks prompt + output yang sudah keluar.
 */
export function usageAfterFailure(err: unknown, promptText: string, outputText: string): TokenUsage {
  const reported = reportedUsage(err);
  if (reported) return reported;
  if (!mayHaveBeenBilled(err)) return { inputTokens: 0, outputTokens: 0 };
  return { inputTokens: estimateTokens(promptText), outputTokens: estimateTokens(outputText) };
}
