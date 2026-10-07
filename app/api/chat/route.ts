// POST /api/chat — tanya jawab dokumen (RAG + tool calling), jawaban di-stream
// sebagai Server-Sent Events.
//
// Dua fase:
// 1. SEBELUM streaming (prepareChat): pemeriksaan murah — passcode, validasi
//    body, rate limit, API key provider, budget harian. Gagal → respons JSON
//    biasa dengan status HTTP yang tepat (401/400/429/503), karena status
//    HTTP tidak bisa diubah lagi setelah stream dimulai.
// 2. Streaming (lib/server/chat-stream.ts): rewrite → retrieve → loop
//    LLM ⇄ tool → usage → done. Error di fase ini dikirim sebagai event `error`.

import { after } from "next/server";

import { getProvider, type ChatProvider } from "@/lib/llm";
import { formatUsd } from "@/lib/llm/pricing";
import { retrieveChunks } from "@/lib/rag/retrieve";
import { rewriteQuery } from "@/lib/rag/rewrite";
import { parseChatRequest, trimHistory } from "@/lib/server/chat-request";
import { createChatStream } from "@/lib/server/chat-stream";
import { maybeCleanupExpired } from "@/lib/server/cleanup";
import { errorFromUnknown, getClientIp, jsonError, readJsonBody } from "@/lib/server/http";
import { initialChatReserveUsd } from "@/lib/server/budget";
import { chatIpRateLimiter, chatRateLimiter } from "@/lib/server/rateLimit";
import { requireSession } from "@/lib/server/session";
import { SSE_HEADERS } from "@/lib/server/sse";
import { DAILY_LIMIT_MESSAGE, reserveBudget, settleUsage, type Reservation } from "@/lib/server/usage";
import { TOOLS, executeTool } from "@/lib/tools";
import type { ChatHistoryMessage } from "@/lib/types";

// Beberapa panggilan LLM + tool bisa makan puluhan detik. chat-stream.ts
// memasang deadline sendiri (50 dtk) supaya selesai rapi sebelum batas ini.
export const maxDuration = 60;

/**
 * Batas ukuran body. Pertanyaan ≤ 2.000 karakter + riwayat; server hanya
 * memakai beberapa pesan terakhir, jadi 1 MB sudah sangat longgar.
 */
const MAX_CHAT_BODY_BYTES = 1_000_000;

type PreparedChat = {
  sessionId: string;
  provider: ChatProvider;
  question: string;
  history: ChatHistoryMessage[];
  reservation: Reservation;
};

export async function POST(request: Request): Promise<Response> {
  const prepared = await prepareChat(request);
  if (prepared instanceof Response) return prepared;
  const { reservation, ...chat } = prepared;

  // Mulai titik ini reservasi WAJIB di-settle tepat 1x. Tanggung jawab itu
  // dipegang stream: blok `finally` di chat-stream.ts memanggil settleUsage
  // di akhir stream — sukses, error, maupun client memutus koneksi.
  // Reservasi tambahan (ronde tool berikutnya, ringkasan) dikumpulkan di
  // array yang sama supaya ikut di-settle sekaligus.
  const reservations: Reservation[] = [reservation];
  const stream = createChatStream(
    { ...chat, signal: request.signal },
    {
      rewriteQuery,
      retrieveChunks,
      executeTool,
      tools: TOOLS,
      reserveMore: async (costUsd) => {
        try {
          const more = await reserveBudget(costUsd);
          if (!more.ok) return false;
          reservations.push(more.reservation);
          return true;
        } catch (err) {
          // Fail closed: DB bermasalah = jangan memanggil LLM tanpa reservasi.
          console.error("[chat] reservasi budget tambahan gagal:", err instanceof Error ? err.message : err);
          return false;
        }
      },
      settleUsage: (actual) => settleUsage(reservations, actual),
    },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Fase 1. Mengembalikan Response kalau request harus ditolak. Reservasi
 * budget sengaja jadi langkah TERAKHIR: kalau ada pemeriksaan yang gagal,
 * belum ada reservasi yang perlu dikembalikan.
 */
async function prepareChat(request: Request): Promise<PreparedChat | Response> {
  try {
    const auth = await requireSession();
    if (!auth.ok) return auth.response;
    const { sessionId } = auth;
    // Auto-hapus dokumen > 24 jam, dijalankan SETELAH respons selesai.
    after(() => maybeCleanupExpired());

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return body.response;
    const parsed = parseChatRequest(body.value);
    if (!parsed.ok) return jsonError(400, "bad_request", parsed.message);
    const { question } = parsed.value;
    const history = trimHistory(parsed.value.history);

    // Key rate limit = session id dari cookie (konsep yang sama dengan scoping
    // dokumen), plus per IP kalau IP-nya bisa dipercaya: sesi baru bisa
    // dibuat siapa pun yang tahu passcode.
    const ip = getClientIp(request.headers);
    const limit = chatRateLimiter.check(sessionId);
    const ipLimit = limit.allowed && ip !== null ? chatIpRateLimiter.check(`ip:${ip}`) : null;
    const blocked = !limit.allowed ? limit : ipLimit?.allowed === false ? ipLimit : null;
    if (blocked) {
      return jsonError(
        429,
        "rate_limited",
        `Terlalu banyak pertanyaan. Coba lagi dalam ${blocked.retryAfterSec} detik.`,
        { retryable: true, retryAfterSec: blocked.retryAfterSec },
      );
    }

    // Provider sesuai pilihan user di dropdown. API key belum di-set →
    // ProviderError missing_key → 503 dengan pesan jelas (errorFromUnknown).
    // TIDAK ada fallback diam-diam ke provider lain.
    const provider = getProvider(parsed.value.provider);

    // Cek-dan-pesan budget dalam 1 statement SQL atomic (lib/server/usage.ts).
    // Yang dipesan di sini = biaya MAKSIMAL panggilan yang pasti terjadi
    // (rewrite + ronde LLM pertama, dihitung dari panjang prompt). Panggilan
    // tambahan (ronde tool, ringkasan) memesan sendiri di tengah stream —
    // dengan begitu request paralel pun tidak bisa bersama-sama melewati
    // budget harian (lib/server/budget.ts).
    const estimate = initialChatReserveUsd({ model: provider.model, question, history, tools: TOOLS });
    const reserved = await reserveBudget(estimate);
    if (!reserved.ok) {
      if (estimate > reserved.budgetUsd) {
        // Pesan untuk operator, bukan user: dengan budget sekecil ini TIDAK
        // ada pertanyaan yang bisa lolos, berapa pun pemakaian hari ini.
        console.warn(
          `[chat] DAILY_BUDGET_USD (${formatUsd(reserved.budgetUsd)}) lebih kecil dari reservasi 1 pertanyaan (${formatUsd(estimate)}) — semua pertanyaan akan ditolak.`,
        );
      }
      return jsonError(429, "daily_limit", DAILY_LIMIT_MESSAGE);
    }

    return { sessionId, provider, question, history, reservation: reserved.reservation };
  } catch (err) {
    return errorFromUnknown(err);
  }
}
