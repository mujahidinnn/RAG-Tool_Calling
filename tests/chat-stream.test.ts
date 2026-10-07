// Test orkestrasi chat (lib/server/chat-stream.ts) dengan provider & deps
// palsu — tanpa jaringan. Fokus: loop tool-call (spec §1b), penjumlahan
// biaya, dan jaminan reservasi budget di-settle TEPAT 1x apa pun yang terjadi.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { MAX_TOOL_ROUNDS } from "@/lib/config";
import { chatCostUsd } from "@/lib/llm/pricing";
import {
  ProviderError,
  type ChatOptions,
  type ChatProvider,
  type Message,
  type StreamEvent,
  type Tool,
} from "@/lib/llm/types";
import { buildSystemPrompt, formatContext } from "@/lib/rag/prompt";
import {
  MAX_TOOL_CALLS_PER_ROUND,
  createChatStream,
  type ChatStreamDeps,
  type ChatStreamInput,
} from "@/lib/server/chat-stream";
import { estimateTokens } from "@/lib/server/usage-estimate";
import type { ToolContext, ToolExecutionResult } from "@/lib/tools/shared";
import type { ChatHistoryMessage, ChatStreamEvent, Source } from "@/lib/types";

// --- Perlengkapan test ---------------------------------------------------------------

const MODEL = "claude-sonnet-5-5";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const EMBEDDING_TOKENS = 7;
const EMBEDDING_COST = 0.00000014;

const SOURCES: Source[] = [
  {
    id: "c1",
    documentId: "d1",
    filename: "panduan.pdf",
    chunkIndex: 3,
    content: "Cuti tahunan adalah 12 hari.",
    similarity: 0.91,
  },
];

const TOOLS: Tool[] = [
  {
    name: "list_uploaded_documents",
    description: "daftar dokumen",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

type ProviderCall = {
  messages: Message[];
  context: string;
  tools: Tool[] | undefined;
  options: ChatOptions | undefined;
};
type RoundScript = (call: ProviderCall) => AsyncGenerator<StreamEvent>;

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done = (inputTokens: number, outputTokens: number): StreamEvent => ({
  type: "done",
  inputTokens,
  outputTokens,
});
const toolCall = (id: string, name = "list_uploaded_documents", input: unknown = {}): StreamEvent => ({
  type: "tool_call",
  id,
  name,
  input,
});

/** Ronde yang mengirim event-event ini lalu selesai normal. */
function reply(...events: StreamEvent[]): RoundScript {
  return async function* () {
    for (const event of events) yield event;
  };
}

/** Ronde yang mengirim event-event ini lalu melempar error (stream putus). */
function replyThenFail(err: unknown, ...events: StreamEvent[]): RoundScript {
  return async function* () {
    for (const event of events) yield event;
    throw err;
  };
}

/** Ronde yang menggantung sampai signal di-abort, lalu gagal seperti SDK asli. */
function hangUntilAborted(...events: StreamEvent[]): RoundScript {
  return async function* (call) {
    for (const event of events) yield event;
    const signal = call.options?.signal;
    await new Promise<void>((_, reject) => {
      if (!signal) {
        reject(new Error("provider dipanggil tanpa AbortSignal"));
        return;
      }
      const fail = (): void =>
        reject(new ProviderError({ provider: "anthropic", code: "aborted", message: "Anthropic: permintaan dibatalkan." }));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  };
}

function fakeProvider(rounds: RoundScript[] | ((index: number) => RoundScript)): {
  provider: ChatProvider;
  calls: ProviderCall[];
} {
  const calls: ProviderCall[] = [];
  const provider: ChatProvider = {
    name: "anthropic",
    model: MODEL,
    label: "Claude",
    streamChat(messages, context, tools, options) {
      const call: ProviderCall = { messages, context, tools, options };
      const index = calls.length;
      calls.push(call);
      const script = typeof rounds === "function" ? rounds(index) : rounds[index];
      if (!script) throw new Error(`panggilan provider ke-${index} tidak diharapkan`);
      return script(call);
    },
  };
  return { provider, calls };
}

type ToolInvocation = { name: string; input: unknown; ctx: ToolContext };

function toolResult(content: string, usage = { inputTokens: 0, outputTokens: 0 }): ToolExecutionResult {
  return { content, payload: { kind: "documents", documents: [] }, usage };
}

function makeDeps(overrides: Partial<ChatStreamDeps> = {}): {
  deps: ChatStreamDeps;
  settleCalls: { tokens: number; costUsd: number }[];
  toolInvocations: ToolInvocation[];
  settled: Promise<void>;
} {
  const settleCalls: { tokens: number; costUsd: number }[] = [];
  const toolInvocations: ToolInvocation[] = [];
  let markSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });

  const deps: ChatStreamDeps = {
    rewriteQuery: async (_provider, history, question) =>
      history.length === 0
        ? { query: question, rewritten: false, inputTokens: 0, outputTokens: 0 }
        : { query: `mandiri: ${question}`, rewritten: true, inputTokens: 100, outputTokens: 10 },
    retrieveChunks: async () => ({
      sources: SOURCES,
      embeddingTokens: EMBEDDING_TOKENS,
      embeddingCostUsd: EMBEDDING_COST,
    }),
    executeTool: async (name, input, ctx) => {
      toolInvocations.push({ name, input, ctx });
      return toolResult(JSON.stringify({ total: 1 }));
    },
    tools: TOOLS,
    settleUsage: async (actual) => {
      settleCalls.push(actual);
      markSettled();
    },
    ...overrides,
  };
  return { deps, settleCalls, toolInvocations, settled };
}

function makeInput(provider: ChatProvider, overrides: Partial<ChatStreamInput> = {}): ChatStreamInput {
  return {
    sessionId: SESSION_ID,
    provider,
    question: "Berapa hari cuti tahunan?",
    history: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function parseWire(wire: string): ChatStreamEvent[] {
  return wire
    .split("\n\n")
    .filter((part) => part !== "")
    .map((part) => {
      assert.ok(part.startsWith("data: "), `bukan event SSE: ${part}`);
      return JSON.parse(part.slice("data: ".length)) as ChatStreamEvent;
    });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<ChatStreamEvent[]> {
  return parseWire(await new Response(stream).text());
}

function ofType<T extends ChatStreamEvent["type"]>(
  events: ChatStreamEvent[],
  type: T,
): Extract<ChatStreamEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ChatStreamEvent, { type: T }> => event.type === type);
}

function only<T extends ChatStreamEvent["type"]>(
  events: ChatStreamEvent[],
  type: T,
): Extract<ChatStreamEvent, { type: T }> {
  const found = ofType(events, type);
  assert.equal(found.length, 1, `harus ada tepat 1 event ${type}, dapat ${found.length}`);
  return found[0];
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Log server (console.error/warn/info) sengaja dibisukan supaya output test bersih.
beforeEach(() => {
  mock.method(console, "error", () => undefined);
  mock.method(console, "warn", () => undefined);
  mock.method(console, "info", () => undefined);
});
afterEach(() => {
  mock.restoreAll();
});

// --- Test ----------------------------------------------------------------------------------

describe("createChatStream — jawaban biasa", () => {
  it("urutan event meta → sources → text → usage → done, dan settle 1x dengan biaya yang benar", async () => {
    const { provider, calls } = fakeProvider([reply(text("Cuti 12 hari "), text("[panduan.pdf, chunk #3]"), done(1000, 50))]);
    const { deps, settleCalls } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.deepEqual(
      events.map((event) => event.type),
      ["meta", "sources", "text", "text", "usage", "done"],
    );
    assert.deepEqual(only(events, "meta"), {
      type: "meta",
      provider: "anthropic",
      model: MODEL,
      label: "Claude",
      searchQuery: "Berapa hari cuti tahunan?",
      rewritten: false,
    });
    assert.deepEqual(only(events, "sources").sources, SOURCES);
    assert.equal(
      ofType(events, "text").map((event) => event.delta).join(""),
      "Cuti 12 hari [panduan.pdf, chunk #3]",
    );

    const expectedCost = chatCostUsd(MODEL, 1000, 50) + EMBEDDING_COST;
    const usage = only(events, "usage");
    assert.equal(usage.inputTokens, 1000 + EMBEDDING_TOKENS);
    assert.equal(usage.outputTokens, 50);
    assertClose(usage.costUsd, expectedCost);

    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0].tokens, 1000 + EMBEDDING_TOKENS + 50);
    assertClose(settleCalls[0].costUsd, expectedCost);

    // Provider menerima pertanyaan + context hasil retrieval + definisi tools + signal.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].messages, [{ role: "user", content: "Berapa hari cuti tahunan?" }]);
    assert.equal(calls[0].context, formatContext(SOURCES));
    assert.deepEqual(calls[0].tools, TOOLS);
    assert.ok(calls[0].options?.signal instanceof AbortSignal);
    assert.equal(calls[0].options?.system, undefined);
  });

  it("follow-up: query di-rewrite, riwayat ikut ke LLM, token rewrite ikut dihitung", async () => {
    const history: ChatHistoryMessage[] = [
      { role: "user", content: "Apa itu cuti tahunan?" },
      { role: "assistant", content: "Cuti berbayar." },
    ];
    const { provider, calls } = fakeProvider([reply(text("12 hari."), done(800, 20))]);
    let retrievedWith = "";
    const { deps, settleCalls } = makeDeps({
      retrieveChunks: async (_sessionId, query) => {
        retrievedWith = query;
        return { sources: SOURCES, embeddingTokens: EMBEDDING_TOKENS, embeddingCostUsd: EMBEDDING_COST };
      },
    });

    const events = await readAll(createChatStream(makeInput(provider, { history, question: "Berapa lama?" }), deps));

    const meta = only(events, "meta");
    assert.equal(meta.rewritten, true);
    assert.equal(meta.searchQuery, "mandiri: Berapa lama?");
    // Yang di-embed adalah query hasil rewrite, BUKAN pertanyaan mentah.
    assert.equal(retrievedWith, "mandiri: Berapa lama?");
    assert.deepEqual(calls[0].messages, [...history, { role: "user", content: "Berapa lama?" }]);

    const usage = only(events, "usage");
    assert.equal(usage.inputTokens, 100 + 800 + EMBEDDING_TOKENS);
    assert.equal(usage.outputTokens, 10 + 20);
    assertClose(usage.costUsd, chatCostUsd(MODEL, 900, 30) + EMBEDDING_COST);
    assert.equal(settleCalls.length, 1);
  });
});

describe("createChatStream — loop tool-call (spec §1b)", () => {
  it("tool_call → eksekusi di server → streamChat lagi dengan pesan role:tool → jawaban final", async () => {
    const { provider, calls } = fakeProvider([
      reply(text("Saya cek dulu."), toolCall("call_1"), done(500, 20)),
      reply(text("Ada 1 dokumen: panduan.pdf."), done(700, 30)),
    ]);
    const { deps, settleCalls, toolInvocations } = makeDeps({
      executeTool: async (name, input, ctx) => {
        toolInvocations.push({ name, input, ctx });
        return toolResult('{"total":1}', { inputTokens: 300, outputTokens: 40 });
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.deepEqual(
      events.map((event) => event.type),
      ["meta", "sources", "text", "tool_call", "tool_result", "text", "usage", "done"],
    );
    assert.deepEqual(only(events, "tool_call"), {
      type: "tool_call",
      id: "call_1",
      name: "list_uploaded_documents",
      input: {},
    });
    const result = only(events, "tool_result");
    assert.equal(result.id, "call_1");
    assert.equal(result.payload.kind, "documents");

    // Tool dieksekusi di server dengan sesi & provider yang sama.
    assert.equal(toolInvocations.length, 1);
    assert.equal(toolInvocations[0].name, "list_uploaded_documents");
    assert.equal(toolInvocations[0].ctx.sessionId, SESSION_ID);
    assert.equal(toolInvocations[0].ctx.provider, provider);
    assert.ok(toolInvocations[0].ctx.signal instanceof AbortSignal);

    // Panggilan ke-2: riwayat + teks assistant ronde 1 + 1 pesan role:"tool" di akhir.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].messages, [
      { role: "user", content: "Berapa hari cuti tahunan?" },
      { role: "assistant", content: "Saya cek dulu." },
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "list_uploaded_documents",
        input: {},
        content: '{"total":1}',
      },
    ]);
    // Panggilan pertama tidak ikut termutasi oleh pesan yang ditambahkan setelahnya.
    assert.equal(calls[0].messages.length, 1);

    // Teks 2 ronde diberi jeda paragraf supaya tidak menempel.
    assert.equal(
      ofType(events, "text").map((event) => event.delta).join(""),
      "Saya cek dulu.\n\nAda 1 dokumen: panduan.pdf.",
    );

    // Biaya = SEMUA ronde + token LLM di dalam tool + embedding.
    const usage = only(events, "usage");
    assert.equal(usage.inputTokens, 500 + 700 + 300 + EMBEDDING_TOKENS);
    assert.equal(usage.outputTokens, 20 + 30 + 40);
    assertClose(usage.costUsd, chatCostUsd(MODEL, 1500, 90) + EMBEDDING_COST);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0].tokens, 1500 + 90 + EMBEDDING_TOKENS);
  });

  it("ronde tanpa teks: tidak ada pesan assistant kosong di riwayat", async () => {
    const { provider, calls } = fakeProvider([
      reply(toolCall("call_1"), done(10, 5)),
      reply(text("Selesai."), done(10, 5)),
    ]);
    const { deps } = makeDeps();
    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.deepEqual(
      calls[1].messages.map((message) => message.role),
      ["user", "tool"],
    );
    assert.equal(ofType(events, "text").map((event) => event.delta).join(""), "Selesai.");
  });

  it("tool call paralel: dieksekusi bersamaan, hasil ke model tetap SESUAI URUTAN panggilan", async () => {
    const { provider, calls } = fakeProvider([
      reply(toolCall("call_a", "get_document_summary", { document_id: "a" }), toolCall("call_b", "get_document_summary", { document_id: "b" }), done(10, 5)),
      reply(text("Ringkasan keduanya."), done(10, 5)),
    ]);
    let running = 0;
    let maxRunning = 0;
    const { deps } = makeDeps({
      executeTool: async (_name, input) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        const id = (input as { document_id: string }).document_id;
        // call_a selesai BELAKANGAN.
        await sleep(id === "a" ? 30 : 5);
        running -= 1;
        return toolResult(`hasil ${id}`);
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.equal(maxRunning, 2, "kedua tool harus berjalan bersamaan");
    assert.deepEqual(
      ofType(events, "tool_call").map((event) => event.id),
      ["call_a", "call_b"],
    );
    // Event tool_result mengikuti urutan selesai (b dulu) — UI memasangkan lewat id.
    assert.deepEqual(
      ofType(events, "tool_result").map((event) => event.id),
      ["call_b", "call_a"],
    );
    const toolMessages = calls[1].messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      toolMessages.map((message) => (message.role === "tool" ? [message.toolCallId, message.content] : [])),
      [
        ["call_a", "hasil a"],
        ["call_b", "hasil b"],
      ],
    );
  });

  it(`berhenti setelah ${MAX_TOOL_ROUNDS} ronde tool: ronde terakhir tetap kirim tools + instruksi menjawab`, async () => {
    const { provider, calls } = fakeProvider(() => reply(toolCall(`call_${Math.random()}`), done(100, 10)));
    const { deps, settleCalls, toolInvocations } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.equal(calls.length, MAX_TOOL_ROUNDS + 1);
    assert.equal(toolInvocations.length, MAX_TOOL_ROUNDS, "tool di ronde terakhir tidak boleh dieksekusi");
    const finalCall = calls[MAX_TOOL_ROUNDS];
    assert.deepEqual(finalCall.tools, TOOLS);
    assert.match(finalCall.options?.system ?? "", /JANGAN memanggil tool lagi/);
    // Ronde terakhir mematikan tool lewat tool_choice "none" (tools tetap dikirim).
    assert.equal(finalCall.options?.toolChoice, "none");
    // System prompt ronde terakhir tetap memuat context dokumen.
    assert.ok((finalCall.options?.system ?? "").includes("Cuti tahunan adalah 12 hari."));
    for (const call of calls.slice(0, MAX_TOOL_ROUNDS)) {
      assert.equal(call.options?.system, undefined);
      assert.equal(call.options?.toolChoice, undefined, "ronde biasa: model bebas memanggil tool");
    }

    const error = only(events, "error");
    assert.equal(error.code, "provider_error");
    assert.equal(error.provider, "anthropic");
    assert.match(error.message, /masih meminta tool/);
    assert.deepEqual(events.slice(-3).map((event) => event.type), ["error", "usage", "done"]);

    const usage = only(events, "usage");
    assert.equal(usage.inputTokens, 100 * (MAX_TOOL_ROUNDS + 1) + EMBEDDING_TOKENS);
    assert.equal(settleCalls.length, 1);
  });

  it(`maks ${MAX_TOOL_CALLS_PER_ROUND} tool call dieksekusi per ronde; sisanya tetap dijawab dengan error`, async () => {
    const count = MAX_TOOL_CALLS_PER_ROUND + 2;
    const calls = Array.from({ length: count }, (_, i) => toolCall(`call_${i}`));
    const { provider, calls: providerCalls } = fakeProvider([
      reply(...calls, done(10, 5)),
      reply(text("ok"), done(10, 5)),
    ]);
    const { deps, toolInvocations } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.equal(toolInvocations.length, MAX_TOOL_CALLS_PER_ROUND);
    assert.equal(ofType(events, "tool_result").length, count);
    const toolMessages = providerCalls[1].messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, count, "setiap tool call wajib punya hasil");
    assert.match(toolMessages[count - 1].content, /Terlalu banyak pemanggilan tool/);
  });

  it("executeTool yang (melanggar janji) melempar error tidak menggagalkan loop", async () => {
    const { provider, calls } = fakeProvider([
      reply(toolCall("call_1"), done(10, 5)),
      reply(text("Maaf, tool gagal."), done(10, 5)),
    ]);
    const { deps, settleCalls } = makeDeps({
      executeTool: async () => {
        throw new Error("bug");
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));

    const result = only(events, "tool_result");
    assert.equal(result.payload.kind, "error");
    assert.equal(calls.length, 2);
    assert.equal(ofType(events, "error").length, 0);
    assert.equal(settleCalls.length, 1);
  });
});

describe("createChatStream — error & biaya", () => {
  it("provider putus di tengah stream → event error jelas, usage berisi ESTIMASI (bukan 0), settle 1x", async () => {
    const overloaded = new ProviderError({
      provider: "anthropic",
      code: "overloaded",
      message: "Anthropic: server provider sedang sibuk/bermasalah (529). Coba lagi sebentar lagi.",
    });
    const { provider } = fakeProvider([replyThenFail(overloaded, text("Jawaban sebagian"))]);
    const { deps, settleCalls } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider), deps));

    assert.deepEqual(
      events.map((event) => event.type),
      ["meta", "sources", "text", "error", "usage", "done"],
    );
    assert.deepEqual(only(events, "error"), {
      type: "error",
      code: "provider_error",
      message: overloaded.message,
      retryable: true,
      provider: "anthropic",
    });
    const usage = only(events, "usage");
    // Estimasi input minimal sebesar system prompt + context yang terkirim.
    const minimumInput = estimateTokens(buildSystemPrompt(formatContext(SOURCES)));
    assert.ok(
      usage.inputTokens - EMBEDDING_TOKENS >= minimumInput,
      `estimasi input harus mencakup system prompt (dapat ${usage.inputTokens}, minimal ${minimumInput})`,
    );
    assert.ok(usage.outputTokens > 0);
    assert.ok(usage.costUsd > EMBEDDING_COST);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0].tokens, usage.inputTokens + usage.outputTokens);
  });

  it("ditolak sebelum diproses (API key salah) → tidak diestimasi sebagai biaya", async () => {
    const auth = new ProviderError({
      provider: "anthropic",
      code: "auth",
      message: "Anthropic: API key tidak valid atau sudah dicabut (401). Cek ANTHROPIC_API_KEY di server.",
    });
    const { provider } = fakeProvider([replyThenFail(auth)]);
    const { deps, settleCalls } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider), deps));

    const error = only(events, "error");
    assert.equal(error.retryable, false);
    assert.match(error.message, /API key tidak valid/);
    const usage = only(events, "usage");
    assert.equal(usage.inputTokens, EMBEDDING_TOKENS);
    assert.equal(usage.outputTokens, 0);
    assert.equal(settleCalls.length, 1);
  });

  it("rewrite gagal → error, tanpa meta, biaya rewrite diestimasi", async () => {
    const { provider, calls } = fakeProvider([]);
    const { deps, settleCalls } = makeDeps({
      rewriteQuery: async () => {
        throw new ProviderError({ provider: "anthropic", code: "network", message: "Anthropic: koneksi stream terputus." });
      },
    });
    const history: ChatHistoryMessage[] = [{ role: "user", content: "Halo" }];

    const events = await readAll(createChatStream(makeInput(provider, { history }), deps));

    assert.deepEqual(events.map((event) => event.type), ["error", "usage", "done"]);
    assert.equal(calls.length, 0);
    assert.ok(only(events, "usage").inputTokens > 0);
    assert.equal(settleCalls.length, 1);
  });

  it("error non-provider (mis. database) → pesan generik, detail internal tidak bocor", async () => {
    const { provider } = fakeProvider([]);
    const { deps, settleCalls } = makeDeps({
      retrieveChunks: async () => {
        throw new Error("match_chunks gagal: relation \"chunks\" does not exist (SQL detail)");
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));

    const error = only(events, "error");
    assert.equal(error.code, "internal");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /SQL|relation|match_chunks/);
    assert.equal(settleCalls.length, 1);
  });

  it("embedding tanpa OPENAI_API_KEY (ProviderError openai) → error menyebut provider openai", async () => {
    const { provider } = fakeProvider([]);
    const { deps } = makeDeps({
      retrieveChunks: async () => {
        throw new ProviderError({
          provider: "openai",
          code: "missing_key",
          message: "OPENAI_API_KEY belum di-set — dibutuhkan untuk embedding.",
        });
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));
    const error = only(events, "error");
    assert.equal(error.provider, "openai");
    assert.match(error.message, /OPENAI_API_KEY/);
  });

  it("settleUsage gagal tetap mengirim done dan menutup stream", async () => {
    const { provider } = fakeProvider([reply(text("ok"), done(10, 5))]);
    const { deps } = makeDeps({
      settleUsage: async () => {
        throw new Error("db down");
      },
    });

    const events = await readAll(createChatStream(makeInput(provider), deps));
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["usage", "done"]);
  });

  it("deadline tercapai → semua pekerjaan dibatalkan, error 'waktu habis', settle 1x", async () => {
    const { provider, calls } = fakeProvider([hangUntilAborted(text("Sebentar"))]);
    const { deps, settleCalls } = makeDeps();

    const events = await readAll(createChatStream(makeInput(provider, { deadlineMs: 30 }), deps));

    assert.equal(calls[0].options?.signal?.aborted, true);
    const error = only(events, "error");
    assert.match(error.message, /Waktu pemrosesan habis/);
    assert.ok(only(events, "usage").inputTokens > EMBEDDING_TOKENS, "ronde yang dibatalkan tetap diestimasi");
    assert.equal(settleCalls.length, 1);
  });
});

describe("createChatStream — client memutus koneksi", () => {
  it("reader di-cancel → LLM dibatalkan, tidak ada throw, settle tetap 1x dengan estimasi", async () => {
    const { provider, calls } = fakeProvider([hangUntilAborted(text("Jawaban "), text("sebagian"))]);
    const { deps, settleCalls, settled } = makeDeps();

    const stream = createChatStream(makeInput(provider), deps);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // Baca sampai teks pertama masuk, lalu "tutup tab".
    for (;;) {
      const { value, done: finished } = await reader.read();
      assert.equal(finished, false, "stream selesai sebelum teks pertama");
      if (parseWire(decoder.decode(value)).some((event) => event.type === "text")) break;
    }
    await reader.cancel();

    await settled;
    await sleep(20); // beri waktu kalau-kalau ada settle ke-2 (seharusnya tidak)
    assert.equal(calls[0].options?.signal?.aborted, true, "panggilan LLM harus ikut dibatalkan");
    assert.equal(settleCalls.length, 1);
    assert.ok(settleCalls[0].tokens > EMBEDDING_TOKENS, "token yang sudah diproses tetap dicatat (estimasi)");
  });

  it("request.signal ter-abort → tidak mengirim event error, tetap usage + done + settle 1x", async () => {
    const client = new AbortController();
    const { provider, calls } = fakeProvider([hangUntilAborted(text("Jawaban"))]);
    const { deps, settleCalls } = makeDeps();

    const stream = createChatStream(makeInput(provider, { signal: client.signal }), deps);
    setTimeout(() => client.abort(), 10);
    const events = await readAll(stream);

    assert.equal(calls[0].options?.signal?.aborted, true);
    assert.equal(ofType(events, "error").length, 0, "client sudah pergi — tidak perlu event error");
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["usage", "done"]);
    assert.equal(settleCalls.length, 1);
  });

  it("request yang sudah ter-abort sebelum stream mulai → tidak memanggil LLM, settle 1x", async () => {
    const client = new AbortController();
    client.abort();
    const { provider } = fakeProvider([hangUntilAborted()]);
    const { deps, settleCalls } = makeDeps({
      rewriteQuery: async (_provider, _history, question, signal) => {
        signal?.throwIfAborted();
        return { query: question, rewritten: false, inputTokens: 0, outputTokens: 0 };
      },
    });

    const events = await readAll(createChatStream(makeInput(provider, { signal: client.signal }), deps));

    assert.deepEqual(events.map((event) => event.type), ["usage", "done"]);
    assert.equal(settleCalls.length, 1);
    assert.deepEqual(settleCalls[0], { tokens: 0, costUsd: 0 });
  });
});
