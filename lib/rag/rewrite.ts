import "server-only";

// Langkah 4 pipeline RAG (spec §3.4): query rewriting untuk multi-turn.
// Follow-up seperti "terus contohnya?" kalau di-embed mentah akan menemukan
// chunk acak — kata "contohnya" tidak membawa topik apa pun. LLM menggabungkan
// 1–2 pesan terakhir + pertanyaan baru jadi 1 query mandiri sebelum di-embed.

import { collectStream } from "@/lib/llm";
import type { ChatProvider } from "@/lib/llm/types";
import { estimateTokens } from "@/lib/server/usage-estimate";
import type { ChatHistoryMessage } from "@/lib/types";

import {
  REWRITE_HISTORY_MESSAGES,
  REWRITE_MAX_OUTPUT_TOKENS,
  REWRITE_SYSTEM_PROMPT,
  buildRewriteInput,
  resolveRewrittenQuery,
} from "./prompt";

export type RewriteResult = {
  /** Query yang akan di-embed. */
  query: string;
  /** true kalau query berbeda dari pertanyaan asli (UI menampilkan "Dicari sebagai: …"). */
  rewritten: boolean;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Ubah pertanyaan follow-up jadi query mandiri. Tanpa riwayat → pertanyaan
 * dipakai apa adanya (tanpa panggilan LLM, 0 token). Error provider dibiarkan
 * naik: route chat menampilkannya, bukan diam-diam memakai query mentah.
 */
export async function rewriteQuery(
  provider: ChatProvider,
  history: ChatHistoryMessage[],
  question: string,
  signal?: AbortSignal,
): Promise<RewriteResult> {
  if (history.length === 0) {
    return { query: question, rewritten: false, inputTokens: 0, outputTokens: 0 };
  }

  const input = buildRewriteInput(history.slice(-REWRITE_HISTORY_MESSAGES), question);
  const result = await collectStream(
    provider.streamChat([{ role: "user", content: input }], "", undefined, {
      system: REWRITE_SYSTEM_PROMPT,
      maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
      signal,
    }),
  );

  // Output kosong / aneh / gema pertanyaan → pakai pertanyaan asli (retrieval tetap jalan).
  const { query, rewritten } = resolveRewrittenQuery(result.text, question);
  // Provider tidak melaporkan token (stream terganggu di akhir) ≠ gratis →
  // catat estimasi (lib/server/usage-estimate.ts).
  const usage = result.usageReported
    ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
    : { inputTokens: estimateTokens(REWRITE_SYSTEM_PROMPT + input), outputTokens: estimateTokens(result.text) };
  return { query, rewritten, ...usage };
}
