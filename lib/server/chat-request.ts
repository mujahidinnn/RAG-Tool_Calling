// Validasi body POST /api/chat. PURE (diuji di tests/chat-request.test.ts).
//
// Semua isi body dikontrol klien → divalidasi dengan zod sebelum dipakai.
// Pesan error dalam Bahasa Indonesia karena langsung ditampilkan di UI.

import { z } from "zod";

import {
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_QUESTION_CHARS,
} from "@/lib/config";
import type { ChatHistoryMessage, ChatRequestBody } from "@/lib/types";

/**
 * Batas jumlah pesan riwayat yang DITERIMA (bukan yang dikirim ke LLM — itu
 * MAX_HISTORY_MESSAGES). Sengaja longgar: UI cukup mengirim riwayatnya apa
 * adanya dan server yang memotong, jadi percakapan panjang tidak tiba-tiba
 * gagal 400. Ukuran body tetap dibatasi di route (readJsonBody).
 */
export const MAX_HISTORY_ITEMS_ACCEPTED = 200;

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"], {
    error: 'Role pesan riwayat harus "user" atau "assistant".',
  }),
  // Dipotong, BUKAN ditolak: jawaban asisten sendiri bisa jauh lebih panjang
  // dari batas ini (MAX_OUTPUT_TOKENS ≈ belasan ribu karakter). Menolaknya
  // berarti pertanyaan berikutnya selalu gagal setelah 1 jawaban panjang.
  content: z
    .string({ error: "Isi pesan riwayat harus berupa teks." })
    .transform((content) => truncate(content, MAX_HISTORY_MESSAGE_CHARS)),
});

const chatRequestSchema = z.object(
  {
    provider: z.enum(["anthropic", "openai"], {
      error: 'Provider harus "anthropic" atau "openai".',
    }),
    question: z
      .string({ error: "Pertanyaan wajib diisi." })
      .trim()
      .min(1, "Pertanyaan tidak boleh kosong.")
      .max(MAX_QUESTION_CHARS, `Pertanyaan maksimal ${MAX_QUESTION_CHARS} karakter.`),
    history: z
      .array(historyMessageSchema, { error: "Riwayat percakapan harus berupa array." })
      .max(
        MAX_HISTORY_ITEMS_ACCEPTED,
        `Riwayat percakapan terlalu panjang (maks ${MAX_HISTORY_ITEMS_ACCEPTED} pesan).`,
      )
      .default([]),
  },
  { error: "Body request harus berupa objek JSON." },
);

export type ParseChatRequestResult =
  | { ok: true; value: ChatRequestBody }
  | { ok: false; message: string };

/** Validasi body JSON dari klien. Gagal → pesan error pertama yang siap tampil. */
export function parseChatRequest(json: unknown): ParseChatRequestResult {
  const result = chatRequestSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const message = result.error.issues[0]?.message ?? "Body request tidak valid.";
  return { ok: false, message };
}

/**
 * Riwayat yang benar-benar dikirim ke LLM: `max` pesan terakhir saja.
 *
 * Kenapa dipotong: tiap pesan riwayat ikut ditagih sebagai token input di
 * SETIAP panggilan LLM (rewrite + tiap ronde tool) — riwayat panjang =
 * biaya naik terus. Pesan kosong dibuang (API provider menolak teks kosong)
 * dan riwayat dimulai dari pesan user, karena giliran pertama yang berupa
 * assistant tidak punya konteks pertanyaannya.
 */
export function trimHistory(
  history: ChatHistoryMessage[],
  max: number = MAX_HISTORY_MESSAGES,
): ChatHistoryMessage[] {
  if (max <= 0) return [];
  const recent = history.filter((message) => message.content.trim() !== "").slice(-max);
  const firstUser = recent.findIndex((message) => message.role === "user");
  return firstUser === -1 ? [] : recent.slice(firstUser);
}
