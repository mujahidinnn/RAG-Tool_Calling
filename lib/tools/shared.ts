// Tipe & helper bersama untuk tool. PURE (tanpa server-only / supabase)
// supaya bisa diimpor unit test dan lib/server/chat-stream.ts.

import type { ChatProvider } from "@/lib/llm/types";
import type { ToolCardPayload } from "@/lib/types";

export type ToolContext = {
  /** Semua query tool WAJIB difilter dengan sesi ini (service role bypass RLS). */
  sessionId: string;
  /** Provider pilihan user — dipakai juga oleh tool yang memanggil LLM (ringkasan). */
  provider: ChatProvider;
  signal?: AbortSignal;
};

export type ToolExecutionResult = {
  /** Hasil untuk MODEL, sebagai string (JSON) — dikirim sebagai pesan `role: "tool"`. */
  content: string;
  /** Data untuk card di UI (tampil beda dari jawaban chat biasa). */
  payload: ToolCardPayload;
  /** Token LLM yang dipakai tool ini (mis. ringkasan) — ikut dihitung ke biaya. */
  usage: { inputTokens: number; outputTokens: number };
};

export const NO_USAGE: ToolExecutionResult["usage"] = { inputTokens: 0, outputTokens: 0 };

/**
 * Hasil tool yang gagal. Tool TIDAK melempar error untuk masalah level tool
 * (id salah, dokumen belum siap, dll): pesannya dikembalikan ke model sebagai
 * hasil tool, sehingga model bisa menjelaskannya ke user atau mencoba lagi
 * dengan input yang benar.
 */
export function toolErrorResult(
  message: string,
  usage: ToolExecutionResult["usage"] = NO_USAGE,
): ToolExecutionResult {
  return {
    content: JSON.stringify({ error: message }),
    payload: { kind: "error", message },
    usage,
  };
}

/**
 * Pilih `count` indeks yang tersebar merata dari 0..total-1, SELALU termasuk
 * indeks pertama & terakhir, urut naik tanpa duplikat. Dipakai untuk
 * ringkasan dokumen panjang: sampel dari awal, tengah, DAN akhir dokumen,
 * bukan hanya N potongan pertama.
 */
export function pickEvenlySpaced(total: number, count: number): number[] {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(count) || count <= 0) return [];
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [0];
  // total > count → jarak antar indeks > 1, jadi pembulatan tidak bisa
  // menghasilkan indeks kembar.
  const step = (total - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

/**
 * Pasang AbortSignal ke query supabase-js (kalau ada), supaya query ikut
 * dibatalkan saat client menutup koneksi. Harus dipanggil SEBELUM
 * `.single()` / `.maybeSingle()` (builder hasil keduanya tidak punya abortSignal).
 */
export function withAbortSignal<Q extends { abortSignal(signal: AbortSignal): Q }>(
  query: Q,
  signal: AbortSignal | undefined,
): Q {
  return signal ? query.abortSignal(signal) : query;
}
