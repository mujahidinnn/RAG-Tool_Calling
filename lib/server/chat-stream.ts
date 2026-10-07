// Orkestrasi 1 pertanyaan chat → stream Server-Sent Events (spec §1b & §3):
//
//   rewrite query → retrieve top-k → [LLM ⇄ tool]* → usage → done
//
// Modul ini tidak mengimpor server-only / next / env. Semua yang menyentuh
// jaringan (LLM, embedding, database, pencatatan biaya) masuk lewat `deps`,
// sehingga bagian paling rawan bug — loop tool-call, penjumlahan biaya, dan
// jaminan reservasi budget di-settle TEPAT 1x — bisa diuji tanpa jaringan
// (tests/chat-stream.test.ts). app/api/chat/route.ts yang menyambungkan
// implementasi aslinya.

import { MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS } from "@/lib/config";
import { chatCostUsd } from "@/lib/llm/pricing";
import {
  ProviderError,
  type AssistantReplay,
  type ChatOptions,
  type ChatProvider,
  type Message,
  type Tool,
} from "@/lib/llm/types";
import {
  REWRITE_SYSTEM_PROMPT,
  buildRewriteInput,
  buildSystemPrompt,
  formatContext,
} from "@/lib/rag/prompt";
import type { RetrieveResult } from "@/lib/rag/retrieve";
import type { RewriteResult } from "@/lib/rag/rewrite";
import { NO_USAGE, toolErrorResult, type ToolContext, type ToolExecutionResult } from "@/lib/tools/shared";
import type { ChatHistoryMessage, ChatStreamEvent } from "@/lib/types";

import { DAILY_LIMIT_MESSAGE, DailyLimitError, llmCallReserveUsd } from "./budget";
import { encodeSseEvent } from "./sse";
import { usageAfterFailure } from "./usage-estimate";

/**
 * Batas waktu total 1 pertanyaan. Sengaja di bawah maxDuration route (60
 * detik): kalau platform mematikan fungsi secara paksa, blok `finally` tidak
 * sempat jalan dan reservasi budget tidak pernah di-settle. Sisa ±10 detik
 * dipakai untuk settle + menutup stream dengan rapi.
 */
export const CHAT_DEADLINE_MS = 50_000;
/** Settle hanya ditunggu selama ini, supaya DB yang lambat tidak menahan stream terbuka. */
const SETTLE_TIMEOUT_MS = 5_000;
/**
 * Maks tool call yang dieksekusi dalam 1 ronde. Cukup untuk meringkas semua
 * dokumen sesi (maks 5) sekaligus; mencegah model (atau prompt injection di
 * dokumen) memicu puluhan ringkasan mahal dalam 1 langkah.
 */
export const MAX_TOOL_CALLS_PER_ROUND = 5;

const FINAL_ROUND_INSTRUCTION =
  "\n\nPENTING: batas pemanggilan tool untuk pertanyaan ini sudah tercapai. JANGAN memanggil tool lagi — " +
  "jawab sekarang hanya dengan informasi dari Context dan hasil tool sebelumnya.";
/** Ditambahkan ke jawaban yang berhenti karena batas panjang output (bukan karena selesai). */
export const TRUNCATED_NOTICE =
  "_(Jawaban terpotong karena mencapai batas panjang output. Minta lanjutannya, atau ajukan pertanyaan yang lebih spesifik.)_";
const DEADLINE_MESSAGE = `Waktu pemrosesan habis (lebih dari ${Math.round(CHAT_DEADLINE_MS / 1000)} detik). Coba lagi, atau ajukan pertanyaan yang lebih spesifik.`;
const INTERNAL_MESSAGE = "Terjadi kesalahan di server saat memproses pertanyaan. Coba lagi sebentar lagi.";

export type ChatStreamInput = {
  sessionId: string;
  provider: ChatProvider;
  question: string;
  /** Riwayat yang sudah dipotong (trimHistory). */
  history: ChatHistoryMessage[];
  /** `request.signal` — ter-abort saat client menutup koneksi. */
  signal: AbortSignal;
  /** Override batas waktu (untuk test). Default CHAT_DEADLINE_MS. */
  deadlineMs?: number;
};

export type ChatStreamDeps = {
  rewriteQuery: (
    provider: ChatProvider,
    history: ChatHistoryMessage[],
    question: string,
    signal?: AbortSignal,
  ) => Promise<RewriteResult>;
  retrieveChunks: (
    sessionId: string,
    query: string,
    opts: { signal?: AbortSignal },
  ) => Promise<RetrieveResult>;
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolExecutionResult>;
  /** Definisi tool generik (TOOLS dari lib/tools). */
  tools: Tool[];
  /**
   * Pesan budget TAMBAHAN sebelum tiap panggilan LLM setelah reservasi awal
   * route (ronde tool berikutnya, ringkasan dokumen). false = budget habis.
   * Implementasi wajib fail-closed (error DB → false) dan menggabungkan
   * reservasinya ke reservasi yang di-settle oleh `settleUsage`.
   */
  reserveMore: (costUsd: number) => Promise<boolean>;
  /** Selesaikan SEMUA reservasi budget. Dipanggil TEPAT 1x per stream — juga saat error/abort. */
  settleUsage: (actual: { tokens: number; costUsd: number }) => Promise<void>;
};

type ToolCall = { id: string; name: string; input: unknown };

/** Penjumlah token & biaya SEMUA panggilan untuk 1 pertanyaan. */
class UsageTally {
  private readonly model: string;
  private llmInputTokens = 0;
  private llmOutputTokens = 0;
  private embeddingTokens = 0;
  private costUsd = 0;

  constructor(model: string) {
    this.model = model;
  }

  /** Panggilan LLM chat (rewrite, tiap ronde, ringkasan tool) — semua pakai model provider ini. */
  addLlm(inputTokens: number, outputTokens: number): void {
    this.llmInputTokens += inputTokens;
    this.llmOutputTokens += outputTokens;
    this.costUsd += chatCostUsd(this.model, inputTokens, outputTokens);
  }

  addEmbedding(tokens: number, costUsd: number): void {
    this.embeddingTokens += tokens;
    this.costUsd += costUsd;
  }

  /**
   * Panggilan LLM yang gagal sebelum sempat melaporkan token lewat `done`:
   * pakai angka yang dibawa error kalau ada, selain itu estimasi kalau
   * kemungkinan tetap ditagih (alasan: lib/server/usage-estimate.ts).
   */
  addEstimate(err: unknown, promptText: string, outputText: string): void {
    const usage = usageAfterFailure(err, promptText, outputText);
    this.addLlm(usage.inputTokens, usage.outputTokens);
  }

  totals(): { inputTokens: number; outputTokens: number; costUsd: number } {
    return {
      // Token embedding ikut dihitung sebagai input (embedding memang hanya punya input).
      inputTokens: this.llmInputTokens + this.embeddingTokens,
      outputTokens: this.llmOutputTokens,
      costUsd: this.costUsd,
    };
  }
}

/** State yang dibawa sepanjang 1 pertanyaan. */
type Run = {
  signal: AbortSignal;
  send: (event: ChatStreamEvent) => void;
  usage: UsageTally;
  /** Semua teks jawaban yang sudah dikirim ke client (untuk jeda antar ronde). */
  textSent: string;
  /**
   * Hasil tool per (nama + input) dalam pertanyaan ini. Panggilan yang sama
   * persis (mis. ringkasan dokumen yang sama diminta berulang — bisa dipicu
   * prompt injection) memakai hasil pertama tanpa biaya LLM lagi.
   */
  toolResults: Map<string, Promise<ToolExecutionResult>>;
};

/**
 * Buat stream SSE untuk 1 pertanyaan. Error SEBELUM streaming (auth, rate
 * limit, budget) sudah ditangani route sebagai JSON biasa; error di dalam
 * stream dikirim sebagai event `error`, lalu `usage` dan `done` tetap dikirim.
 */
export function createChatStream(input: ChatStreamInput, deps: ChatStreamDeps): ReadableStream<Uint8Array> {
  // 1 controller untuk SEMUA pekerjaan pertanyaan ini (LLM, embedding, DB,
  // tool). Di-abort oleh: client menutup koneksi, stream di-cancel, atau deadline.
  const abort = new AbortController();
  const onClientAbort = (): void => abort.abort();
  let closed = false;
  let deadlineHit = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event));
        } catch {
          // enqueue setelah stream ditutup/di-cancel melempar TypeError →
          // client sudah pergi: berhenti menulis & hentikan sisa pekerjaan.
          closed = true;
          abort.abort();
        }
      };

      if (input.signal.aborted) abort.abort();
      else input.signal.addEventListener("abort", onClientAbort, { once: true });
      const deadline = setTimeout(() => {
        deadlineHit = true;
        abort.abort();
      }, input.deadlineMs ?? CHAT_DEADLINE_MS);

      const run: Run = {
        signal: abort.signal,
        send,
        usage: new UsageTally(input.provider.model),
        textSent: "",
        toolResults: new Map(),
      };
      try {
        await answerQuestion(input, deps, run);
      } catch (err) {
        if (abort.signal.aborted && !deadlineHit) {
          // Client sudah pergi (tab ditutup / tombol stop): tidak ada yang
          // perlu diberi tahu. Ini bukan error server.
          console.info("[chat] client menutup koneksi — pemrosesan dihentikan.");
        } else {
          send(toErrorEvent(err, deadlineHit));
        }
      } finally {
        clearTimeout(deadline);
        input.signal.removeEventListener("abort", onClientAbort);

        const totals = run.usage.totals();
        send({ type: "usage", ...totals });
        // Satu-satunya pemanggil settle, dan start() hanya jalan 1x per
        // stream → reservasi di-settle TEPAT 1x, termasuk saat error/abort.
        // Settle tidak memakai `abort.signal`: biaya tetap harus dicatat
        // justru ketika client sudah pergi.
        await settleSafely(deps, { tokens: totals.inputTokens + totals.outputTokens, costUsd: totals.costUsd });
        send({ type: "done" });

        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // sudah ditutup/di-cancel di antara cek & close — abaikan.
          }
        }
      }
    },

    cancel() {
      // Konsumen stream berhenti membaca (koneksi client putus).
      closed = true;
      abort.abort();
    },
  });
}

async function answerQuestion(input: ChatStreamInput, deps: ChatStreamDeps, run: Run): Promise<void> {
  const { provider, history, question } = input;

  // 1. Query rewriting untuk follow-up (spec §3.4). Tanpa riwayat, rewriteQuery
  //    tidak memanggil LLM sama sekali.
  let rewrite: RewriteResult;
  try {
    rewrite = await deps.rewriteQuery(provider, history, question, run.signal);
  } catch (err) {
    // Estimasi dari SELURUH riwayat (rewrite hanya memakai 2 pesan terakhir)
    // → sedikit berlebih, sengaja: untuk budget, lebih aman kelebihan.
    if (history.length > 0) {
      run.usage.addEstimate(err, REWRITE_SYSTEM_PROMPT + buildRewriteInput(history, question), "");
    }
    throw err;
  }
  run.usage.addLlm(rewrite.inputTokens, rewrite.outputTokens);
  run.send({
    type: "meta",
    provider: provider.name,
    model: provider.model,
    label: provider.label,
    searchQuery: rewrite.query,
    rewritten: rewrite.rewritten,
  });

  // 2. Retrieve top-k chunk milik sesi ini (spec §3.5). Biaya embedding
  //    query ikut dihitung (embedding selalu OpenAI, apa pun provider chat-nya).
  const retrieval = await deps.retrieveChunks(input.sessionId, rewrite.query, { signal: run.signal });
  run.usage.addEmbedding(retrieval.embeddingTokens, retrieval.embeddingCostUsd);
  run.send({ type: "sources", sources: retrieval.sources });

  // 3. Generate (streaming) + loop tool-call.
  await runToolLoop(input, deps, run, formatContext(retrieval.sources));
}

/**
 * Loop tool-call (spec §1b, "Alur tool-call sampai selesai"). Event
 * `tool_call` BUKAN akhir request: server mengeksekusi tool, menambahkan
 * hasilnya ke riwayat sebagai pesan `role: "tool"`, lalu memanggil model
 * LAGI sampai model menjawab tanpa meminta tool. Loop ini milik server —
 * UI hanya menampilkan event yang mengalir.
 */
async function runToolLoop(
  input: ChatStreamInput,
  deps: ChatStreamDeps,
  run: Run,
  context: string,
): Promise<void> {
  const { provider } = input;
  const messages: Message[] = [...input.history, { role: "user", content: input.question }];
  const toolContext: ToolContext = {
    sessionId: input.sessionId,
    provider,
    signal: run.signal,
    // Tool yang memanggil LLM (ringkasan) memesan budget-nya sendiri.
    reserveBudget: (costUsd) => (run.signal.aborted ? Promise.resolve(false) : deps.reserveMore(costUsd)),
  };

  // Ronde 0..MAX_TOOL_ROUNDS-1 boleh memakai tool; ronde terakhir harus menjawab.
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isFinalRound = round === MAX_TOOL_ROUNDS;
    // Ronde terakhir tetap MENGIRIM definisi tools: Anthropic menolak (400)
    // request yang riwayatnya berisi blok tool_use/tool_result tanpa `tools`.
    // Tool dimatikan lewat tool_choice "none" (dijamin API), plus instruksi
    // di system prompt supaya model tahu kenapa harus langsung menjawab.
    const options: ChatOptions = isFinalRound
      ? {
          signal: run.signal,
          system: buildSystemPrompt(context) + FINAL_ROUND_INSTRUCTION,
          toolChoice: "none",
        }
      : { signal: run.signal };
    // System prompt ronde terakhir BERBEDA dari ronde sebelumnya. Claude
    // mengikat tiap blok thinking ke system prompt + riwayat saat blok itu
    // dibuat; mengirim balik blok lama setelah system prompt berubah ditolak
    // (400) di akun baru. Jadi di ronde ini blok thinking tidak dikirim balik
    // (riwayat tanpa thinking selalu diterima API). Selalu salinan: `messages`
    // bertambah setelah ronde ini selesai.
    const roundMessages = isFinalRound ? messages.map(withoutReplay) : messages.slice();

    // Ronde 0 sudah dipesan route (reservasi awal). Ronde berikutnya memesan
    // biaya maksimalnya sendiri — tanpa ini, banyak ronde + ringkasan dalam
    // 1 pertanyaan bisa jauh melewati jatah yang dipesan di awal.
    if (round > 0) {
      const system = options.system ?? buildSystemPrompt(context);
      const cost = llmCallReserveUsd(provider.model, promptText(system, roundMessages, deps.tools), MAX_OUTPUT_TOKENS);
      if (!(await deps.reserveMore(cost))) throw new DailyLimitError();
    }

    const { text, toolCalls, replay } = await streamRound(provider, roundMessages, context, deps.tools, options, run);

    // Tanpa tool call = model sudah selesai menjawab.
    if (toolCalls.length === 0) return;

    if (isFinalRound) {
      // Tool call di ronde terakhir TIDAK dieksekusi (supaya loop pasti
      // berhenti) — beri tahu user dengan jelas daripada jawaban menggantung.
      throw new ProviderError({
        provider: provider.name,
        code: "unknown",
        message: `${provider.label}: model masih meminta tool setelah ${MAX_TOOL_ROUNDS} putaran, jadi jawaban dihentikan. Coba pertanyaan yang lebih spesifik.`,
        retryable: true,
      });
    }

    // Catat giliran model ini ke riwayat: teksnya (kalau ada) lalu 1 pesan
    // `tool` per panggilan. Adapter merekonstruksi tool_use/tool_calls dari
    // pesan `tool` ini (lihat lib/llm/translate.ts) — atau, kalau ada
    // `replay`, mengirim giliran asli provider apa adanya (blok thinking).
    if (text.trim() !== "" || replay) {
      messages.push({ role: "assistant", content: text, ...(replay ? { replay } : {}) });
    }
    const results = await executeToolCalls(toolCalls, deps, toolContext, run);
    toolCalls.forEach((call, index) => {
      const result = results[index];
      run.usage.addLlm(result.usage.inputTokens, result.usage.outputTokens);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        content: result.content,
        ...(result.payload.kind === "error" ? { isError: true } : {}),
      });
    });

    // Client pergi selama tool berjalan → jangan mulai ronde LLM baru.
    run.signal.throwIfAborted();
  }
}

function withoutReplay(message: Message): Message {
  if (message.role === "tool" || message.replay === undefined) return message;
  return { role: message.role, content: message.content };
}

/** 1 panggilan streamChat: teks diteruskan ke client SEGERA, tool call & usage dikumpulkan. */
async function streamRound(
  provider: ChatProvider,
  messages: Message[],
  context: string,
  tools: Tool[],
  options: ChatOptions,
  run: Run,
): Promise<{ text: string; toolCalls: ToolCall[]; replay: AssistantReplay | undefined }> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let replay: AssistantReplay | undefined;
  let usageReported = false;
  let truncated = false;

  try {
    for await (const event of provider.streamChat(messages, context, tools, options)) {
      if (event.type === "text") {
        forwardText(run, event.delta, text === "");
        text += event.delta;
      } else if (event.type === "tool_call") {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === "replay") {
        replay = event.replay;
      } else {
        run.usage.addLlm(event.inputTokens, event.outputTokens);
        usageReported = true;
        truncated = event.truncated === true;
      }
    }
  } catch (err) {
    if (!usageReported) {
      const system = options.system ?? buildSystemPrompt(context);
      run.usage.addEstimate(err, promptText(system, messages, tools), text + JSON.stringify(toolCalls));
    }
    throw err;
  }

  // Adapter seharusnya selalu mengirim `done`; kalau tidak (mis. chunk usage
  // OpenAI tidak sempat datang), tetap catat estimasi.
  if (!usageReported) {
    const system = options.system ?? buildSystemPrompt(context);
    run.usage.addEstimate(null, promptText(system, messages, tools), text + JSON.stringify(toolCalls));
  }

  // Jawaban yang berhenti karena batas output tidak boleh tampil seolah
  // lengkap (dan masuk riwayat follow-up begitu saja) → beri tanda jelas.
  if (truncated && toolCalls.length === 0) {
    forwardText(run, text === "" ? TRUNCATED_NOTICE : `\n\n${TRUNCATED_NOTICE}`, text === "");
  }
  return { text, toolCalls, replay };
}

function forwardText(run: Run, delta: string, isFirstDeltaOfRound: boolean): void {
  let out = delta;
  // Teks ronde sebelumnya (mis. "Saya cek dulu daftar dokumennya.") dan
  // jawaban ronde berikutnya tampil di 1 bubble → beri jeda paragraf supaya
  // tidak menempel jadi satu kalimat.
  if (isFirstDeltaOfRound && run.textSent !== "" && !run.textSent.endsWith("\n")) out = `\n\n${delta}`;
  run.textSent += out;
  run.send({ type: "text", delta: out });
}

/**
 * Eksekusi tool call 1 ronde. Paralel (meringkas 3 dokumen ≈ waktu 1
 * ringkasan), tapi hasil dikembalikan SESUAI URUTAN panggilan: adapter
 * memasangkan pesan `tool` berurutan sebagai 1 batch.
 */
async function executeToolCalls(
  calls: ToolCall[],
  deps: ChatStreamDeps,
  ctx: ToolContext,
  run: Run,
): Promise<ToolExecutionResult[]> {
  // Umumkan semua panggilan dulu → UI langsung bisa menampilkan card-nya.
  for (const call of calls) run.send({ type: "tool_call", id: call.id, name: call.name, input: call.input });

  return Promise.all(
    calls.map(async (call, index) => {
      // Panggilan di atas batas tetap DIJAWAB (dengan error): kedua provider
      // mewajibkan setiap tool call punya hasil di giliran berikutnya.
      const result =
        index < MAX_TOOL_CALLS_PER_ROUND
          ? await executeToolOnce(call, deps, ctx, run)
          : toolErrorResult(
              `Terlalu banyak pemanggilan tool sekaligus (maks ${MAX_TOOL_CALLS_PER_ROUND} per langkah); panggilan ini dilewati.`,
            );
      run.send({ type: "tool_result", id: call.id, name: call.name, payload: result.payload });
      return result;
    }),
  );
}

/** Panggilan identik (nama + input) dalam 1 pertanyaan dieksekusi 1x saja. */
async function executeToolOnce(
  call: ToolCall,
  deps: ChatStreamDeps,
  ctx: ToolContext,
  run: Run,
): Promise<ToolExecutionResult> {
  const key = `${call.name}\u0000${JSON.stringify(call.input) ?? ""}`;
  const earlier = run.toolResults.get(key);
  if (earlier) {
    // Biaya LLM-nya sudah dihitung di panggilan pertama.
    return { ...(await earlier), usage: NO_USAGE };
  }
  const pending = executeToolSafely(call, deps, ctx);
  run.toolResults.set(key, pending);
  return pending;
}

// executeTool dijanjikan tidak pernah throw; tetap dijaga supaya 1 bug di
// tool tidak membuat Promise.all gagal dan biaya tool lain ikut hilang.
async function executeToolSafely(call: ToolCall, deps: ChatStreamDeps, ctx: ToolContext): Promise<ToolExecutionResult> {
  try {
    return await deps.executeTool(call.name, call.input, ctx);
  } catch (err) {
    console.error(`[chat] tool ${call.name} melempar error:`, err);
    return toolErrorResult("Tool gagal dijalankan karena kesalahan di server.");
  }
}

/** Seluruh teks yang dikirim ke model dalam 1 panggilan (dasar estimasi token input). */
function promptText(system: string, messages: Message[], tools: Tool[]): string {
  const parts = [system, JSON.stringify(tools)];
  for (const message of messages) {
    parts.push(message.content);
    if (message.role === "tool") parts.push(JSON.stringify(message.input) ?? "");
  }
  return parts.join("\n");
}

async function settleSafely(deps: ChatStreamDeps, actual: { tokens: number; costUsd: number }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SETTLE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([deps.settleUsage(actual).then(() => "ok" as const), timeout]);
    if (outcome === "timeout") {
      // Reservasi yang belum di-settle tetap terhitung penuh → aman untuk budget.
      console.error("[chat] settleUsage tidak selesai dalam batas waktu; reservasi dibiarkan.");
    }
  } catch (err) {
    console.error("[chat] settleUsage gagal:", err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
}

// `instanceof` bisa gagal kalau modul termuat 2x (bundler/test) → cek bentuknya juga.
function isProviderError(err: unknown): err is ProviderError {
  if (err instanceof ProviderError) return true;
  return (
    err instanceof Error &&
    err.name === "ProviderError" &&
    "provider" in err &&
    "code" in err &&
    "retryable" in err
  );
}

function toErrorEvent(err: unknown, deadlineHit: boolean): Extract<ChatStreamEvent, { type: "error" }> {
  if (deadlineHit) {
    console.warn("[chat] deadline tercapai — pemrosesan dihentikan.");
    return { type: "error", code: "internal", message: DEADLINE_MESSAGE, retryable: true };
  }
  if (err instanceof DailyLimitError) {
    console.warn("[chat] budget harian habis di tengah pertanyaan — ronde berikutnya dibatalkan.");
    return { type: "error", code: "daily_limit", message: DAILY_LIMIT_MESSAGE, retryable: false };
  }
  if (isProviderError(err)) {
    // TIDAK ada fallback ke provider lain: error diteruskan apa adanya supaya
    // user tahu provider mana yang gagal dan kenapa (spec §1b).
    console.warn(`[chat] provider ${err.provider} gagal (${err.code}): ${err.message}`);
    return {
      type: "error",
      code: "provider_error",
      message: err.message,
      retryable: err.retryable,
      provider: err.provider,
    };
  }
  if (err instanceof Error && err.name === "ConfigError") {
    // Pesan ConfigError hanya berisi NAMA env yang kurang — aman ditampilkan.
    return { type: "error", code: "config_error", message: err.message, retryable: false };
  }
  // Detail error lain (SQL, stack) hanya untuk log server, bukan untuk client.
  console.error("[chat] error tak terduga:", err);
  return { type: "error", code: "internal", message: INTERNAL_MESSAGE, retryable: true };
}
