// Ukuran reservasi budget harian untuk chat. PURE (tanpa server-only / next /
// env) — dipakai route chat, lib/server/chat-stream.ts, tool ringkasan, dan
// lib/env.ts, serta diuji di tests/budget.test.ts.
//
// Model reservasi ("pesan dulu, koreksi belakangan"; SQL atomic di
// lib/server/usage.ts):
// * Sebelum streaming, route memesan biaya MAKSIMAL panggilan yang PASTI
//   terjadi: rewrite (kalau ada riwayat) + ronde LLM pertama.
// * Setiap panggilan LLM TAMBAHAN — ronde tool berikutnya, tiap ringkasan
//   dokumen — memesan biaya maksimalnya sendiri tepat sebelum dipanggil.
//   Ditolak = berhenti dengan pesan limit harian.
// Dengan begitu total biaya tidak bisa melewati budget harian walau banyak
// request berjalan paralel: setiap panggilan sudah "dibayar di muka" dengan
// angka terburuknya. Satu reservasi besar untuk skenario terburuk (±$1 per
// pertanyaan) justru menolak hampir semua pertanyaan normal (±$0,01).

import { CHUNK_TOKENS, MAX_OUTPUT_TOKENS, TOP_K } from "@/lib/config";
import { chatCostUsd } from "@/lib/llm/pricing";
import type { Tool } from "@/lib/llm/types";
import {
  REWRITE_HISTORY_MESSAGES,
  REWRITE_MAX_OUTPUT_TOKENS,
  REWRITE_SYSTEM_PROMPT,
  SYSTEM_PROMPT_BASE,
  buildRewriteInput,
} from "@/lib/rag/prompt";
import type { ChatHistoryMessage } from "@/lib/types";

import { estimateTokens } from "./usage-estimate";

export const DAILY_LIMIT_MESSAGE = "Demo limit harian tercapai, coba lagi besok.";

/** Reservasi budget ditolak di tengah stream (ronde tool berikutnya). */
export class DailyLimitError extends Error {
  constructor() {
    super(DAILY_LIMIT_MESSAGE);
    this.name = "DailyLimitError";
  }
}

/**
 * Batas atas token context hasil retrieval SEBELUM retrieval terjadi: top-k
 * chunk × ≤CHUNK_TOKENS token (tokenizer embedding), ×2 karena tokenizer
 * model chat bisa menghitung teks yang sama lebih banyak (mis. teks non-Latin)
 * plus pembungkus <chunk>.
 */
const CONTEXT_RESERVE_TOKENS = TOP_K * CHUNK_TOKENS * 2;

/** Biaya maksimal 1 panggilan LLM: estimasi input + output maksimal. */
export function llmCallReserveUsd(model: string, promptText: string, maxOutputTokens: number): number {
  return chatCostUsd(model, estimateTokens(promptText), maxOutputTokens);
}

/**
 * Reservasi awal 1 pertanyaan (sebelum streaming): rewrite (kalau ada
 * riwayat) + ronde LLM pertama dengan context terburuk.
 */
export function initialChatReserveUsd(opts: {
  model: string;
  question: string;
  history: ChatHistoryMessage[];
  tools: Tool[];
}): number {
  const { model, question, history, tools } = opts;
  let total = 0;
  if (history.length > 0) {
    const rewriteInput = buildRewriteInput(history.slice(-REWRITE_HISTORY_MESSAGES), question);
    total += llmCallReserveUsd(model, REWRITE_SYSTEM_PROMPT + rewriteInput, REWRITE_MAX_OUTPUT_TOKENS);
  }
  const firstRoundPrompt = [
    SYSTEM_PROMPT_BASE,
    JSON.stringify(tools),
    ...history.map((message) => message.content),
    question,
  ].join("\n");
  total += chatCostUsd(model, estimateTokens(firstRoundPrompt) + CONTEXT_RESERVE_TOKENS, MAX_OUTPUT_TOKENS);
  return total;
}
