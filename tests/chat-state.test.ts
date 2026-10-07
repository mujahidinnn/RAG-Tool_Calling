import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStreamEvent,
  assistantText,
  buildHistory,
  chatReducer,
  createAssistantTurn,
  describeChatError,
  failTurn,
  finishTurn,
  isEmbeddingFailure,
  type AssistantTurn,
  type ChatErrorInfo,
  type ChatTurn,
} from "@/lib/client/chat";
import { CHAT_RATE_LIMIT, MAX_HISTORY_MESSAGE_CHARS, MAX_HISTORY_MESSAGES } from "@/lib/config";
import type { ChatStreamEvent, ProviderInfo, ProviderName } from "@/lib/types";

function newTurn(id = "a1", replyTo = "u1"): AssistantTurn {
  return createAssistantTurn({ id, replyTo, question: "Apa isi dokumen?", provider: "anthropic", label: "Claude" });
}

function applyAll(turn: AssistantTurn, events: ChatStreamEvent[]): AssistantTurn {
  return events.reduce(applyStreamEvent, turn);
}

function doneExchange(userId: string, question: string, answer: string): ChatTurn[] {
  const assistant = applyAll(newTurn(`a-${userId}`, userId), [
    { type: "text", delta: answer },
    { type: "done" },
  ]);
  return [{ id: userId, role: "user", content: question }, assistant];
}

describe("applyStreamEvent", () => {
  it("alur normal: meta → sources → text → usage → done", () => {
    const turn = applyAll(newTurn(), [
      {
        type: "meta",
        provider: "openai",
        model: "gpt-5.6-terra",
        label: "GPT",
        searchQuery: "isi dokumen kebijakan cuti",
        rewritten: true,
      },
      { type: "sources", sources: [] },
      { type: "text", delta: "Halo " },
      { type: "text", delta: "dunia" },
      { type: "usage", inputTokens: 1200, outputTokens: 80, costUsd: 0.0034 },
      { type: "done" },
    ]);
    assert.equal(turn.status, "done");
    assert.equal(turn.provider, "openai");
    assert.equal(turn.label, "GPT");
    assert.equal(turn.searchQuery, "isi dokumen kebijakan cuti");
    assert.equal(turn.rewritten, true);
    assert.deepEqual(turn.sources, []);
    assert.deepEqual(turn.parts, [{ type: "text", text: "Halo dunia" }]);
    assert.deepEqual(turn.usage, { inputTokens: 1200, outputTokens: 80, costUsd: 0.0034 });
  });

  it("status pending sampai teks/tool pertama datang", () => {
    const turn = applyAll(newTurn(), [{ type: "sources", sources: [] }]);
    assert.equal(turn.status, "pending");
    assert.equal(applyStreamEvent(turn, { type: "text", delta: "x" }).status, "streaming");
  });

  it("urutan teks → tool → teks dipertahankan sebagai part terpisah", () => {
    const turn = applyAll(newTurn(), [
      { type: "text", delta: "Saya cek dulu." },
      { type: "tool_call", id: "t1", name: "list_uploaded_documents", input: {} },
      { type: "tool_result", id: "t1", name: "list_uploaded_documents", payload: { kind: "documents", documents: [] } },
      { type: "text", delta: "Belum ada dokumen." },
      { type: "done" },
    ]);
    assert.deepEqual(
      turn.parts.map((part) => part.type),
      ["text", "tool", "text"],
    );
    const tool = turn.parts[1];
    assert.ok(tool.type === "tool");
    assert.deepEqual(tool.result, { kind: "documents", documents: [] });
    assert.equal(assistantText(turn), "Saya cek dulu.\n\nBelum ada dokumen.");
  });

  it("error di tengah stream: teks yang sudah masuk tetap ada, done tidak menimpa status error", () => {
    const turn = applyAll(newTurn(), [
      { type: "text", delta: "Sebagian" },
      { type: "error", code: "provider_error", message: "Anthropic: limit", retryable: true, provider: "anthropic" },
      { type: "usage", inputTokens: 10, outputTokens: 2, costUsd: 0.00001 },
      { type: "done" },
    ]);
    assert.equal(turn.status, "error");
    assert.equal(turn.error?.message, "Anthropic: limit");
    assert.equal(turn.error?.provider, "anthropic");
    assert.equal(assistantText(turn), "Sebagian");
    assert.notEqual(turn.usage, null);
  });
});

describe("finishTurn", () => {
  it("stream berakhir tanpa done → error yang bisa di-retry", () => {
    const turn = finishTurn(applyStreamEvent(newTurn(), { type: "text", delta: "x" }), "ended");
    assert.equal(turn.status, "error");
    assert.equal(turn.error?.retryable, true);
  });

  it("dibatalkan user → stopped; pesan yang sudah selesai tidak diubah", () => {
    assert.equal(finishTurn(newTurn(), "aborted").status, "stopped");
    const done = applyStreamEvent(newTurn(), { type: "done" });
    assert.equal(finishTurn(done, "ended"), done);
  });
});

describe("buildHistory", () => {
  it("hanya pasangan tanya-jawab yang berhasil", () => {
    const failed = applyAll(newTurn("a-bad", "u-bad"), [
      { type: "error", code: "internal", message: "gagal", retryable: true },
      { type: "done" },
    ]);
    const turns: ChatTurn[] = [
      ...doneExchange("u1", "Q1", "A1"),
      { id: "u-bad", role: "user", content: "Q gagal" },
      failed,
      ...doneExchange("u2", "Q2", "A2"),
    ];
    assert.deepEqual(buildHistory(turns), [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
    ]);
  });

  it("dibatasi MAX_HISTORY_MESSAGES (pesan terbaru) dan panjang tiap pesan", () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 10; i++) turns.push(...doneExchange(`u${i}`, `Q${i}`, `A${i}`));
    const history = buildHistory(turns);
    assert.equal(history.length, MAX_HISTORY_MESSAGES);
    assert.deepEqual(history.at(-1), { role: "assistant", content: "A9" });
    assert.equal(history[0].role, "user");

    const long = buildHistory(doneExchange("u", "Q", "x".repeat(MAX_HISTORY_MESSAGE_CHARS + 500)));
    assert.equal(long[1].content.length, MAX_HISTORY_MESSAGE_CHARS);
  });
});

describe("chatReducer", () => {
  it("ask → event → retry mengganti jawaban gagal di posisi yang sama", () => {
    const user = { id: "u1", role: "user" as const, content: "Halo?" };
    let turns = chatReducer([], { type: "ask", user, assistant: newTurn("a1", "u1") });
    turns = chatReducer(turns, {
      type: "fail",
      id: "a1",
      error: { code: "network", message: "putus", retryable: true },
    });
    assert.equal((turns[1] as AssistantTurn).status, "error");

    turns = chatReducer(turns, { type: "retry", failedId: "a1", assistant: newTurn("a2", "u1") });
    assert.deepEqual(
      turns.map((t) => t.id),
      ["u1", "a2"],
    );
    turns = chatReducer(turns, { type: "event", id: "a2", event: { type: "text", delta: "Hai" } });
    assert.equal(assistantText(turns[1] as AssistantTurn), "Hai");
    assert.deepEqual(chatReducer(turns, { type: "reset" }), []);
  });
});

describe("describeChatError (kartu error)", () => {
  const PROVIDERS: ProviderInfo[] = [
    { name: "anthropic", label: "Claude", model: "claude-sonnet-5-5", configured: true },
    { name: "openai", label: "GPT", model: "gpt-5.6-terra", configured: true },
  ];

  function meta(provider: ProviderName): ChatStreamEvent {
    const info = PROVIDERS.find((p) => p.name === provider)!;
    return { type: "meta", provider, model: info.model, label: info.label, searchQuery: "q", rewritten: false };
  }

  function streamError(provider: ProviderName, retryable = false): ChatStreamEvent {
    return { type: "error", code: "provider_error", message: "OpenAI (embedding): API key tidak valid.", retryable, provider };
  }

  function chatTurn(provider: ProviderName): AssistantTurn {
    const label = PROVIDERS.find((p) => p.name === provider)!.label;
    return createAssistantTurn({ id: "a1", replyTo: "u1", question: "Q?", provider, label });
  }

  function cardFor(turn: AssistantTurn, providers = PROVIDERS) {
    return describeChatError(turn, turn.error!, providers);
  }

  it("embedding gagal saat Claude dipilih: judul menyebut embedding, tanpa retry ke GPT & tanpa ganti provider", () => {
    const turn = applyAll(chatTurn("anthropic"), [meta("anthropic"), streamError("openai")]);
    assert.equal(isEmbeddingFailure(turn), true);
    const card = cardFor(turn);
    assert.equal(card.title, "Embedding (OpenAI) gagal");
    assert.equal(card.canRetry, false); // retryable=false (key salah)
    assert.equal(card.alternative, null);
  });

  it("embedding gagal saat GPT dipilih (provider sama) tetap dikenali dari urutan meta → sources", () => {
    const turn = applyAll(chatTurn("openai"), [meta("openai"), streamError("openai", true)]);
    assert.equal(isEmbeddingFailure(turn), true);
    const card = cardFor(turn);
    assert.equal(card.title, "Embedding (OpenAI) gagal");
    assert.equal(card.canRetry, true);
    assert.equal(card.alternative, null, "Claude juga butuh embedding OpenAI — jangan ditawarkan");
  });

  it("provider chat gagal setelah sources: retry + tawaran provider lain", () => {
    const turn = applyAll(chatTurn("anthropic"), [
      meta("anthropic"),
      { type: "sources", sources: [] },
      { type: "error", code: "provider_error", message: "Claude: overloaded", retryable: true, provider: "anthropic" },
    ]);
    assert.equal(isEmbeddingFailure(turn), false);
    const card = cardFor(turn);
    assert.equal(card.title, "Claude gagal menjawab");
    assert.equal(card.canRetry, true);
    assert.equal(card.alternative?.name, "openai");
  });

  it("API key provider chat kosong (503 sebelum stream): tanpa 'Coba lagi', tapi tetap tawarkan provider lain", () => {
    const error: ChatErrorInfo = {
      code: "provider_error",
      message: "ANTHROPIC_API_KEY belum di-set di server",
      retryable: false,
      provider: "anthropic",
    };
    const turn = failTurn(chatTurn("anthropic"), error);
    const card = cardFor(turn);
    assert.equal(card.title, "Claude gagal menjawab");
    assert.equal(card.canRetry, false);
    assert.equal(card.alternative?.name, "openai");

    const unconfigured = PROVIDERS.map((p) => (p.name === "openai" ? { ...p, configured: false } : p));
    assert.equal(cardFor(turn, unconfigured).alternative, null);
  });

  it("rate limit: pesan statis tanpa angka detik yang membeku (hitung mundur ada di tombol)", () => {
    const turn = failTurn(chatTurn("anthropic"), {
      code: "rate_limited",
      message: "Terlalu banyak pertanyaan. Coba lagi dalam 57 detik.",
      retryable: true,
      retryAt: Date.now() + 57_000,
    });
    const card = cardFor(turn);
    assert.equal(card.title, "Terlalu banyak pertanyaan");
    assert.ok(!card.message.includes("57"));
    assert.ok(card.message.includes(String(CHAT_RATE_LIMIT.max)));
    assert.equal(card.canRetry, true);
    assert.equal(card.alternative, null);
  });

  it("retry disembunyikan untuk daily_limit, unauthorized, dan error non-retryable", () => {
    for (const error of [
      { code: "daily_limit", message: "x", retryable: true },
      { code: "unauthorized", message: "x", retryable: true },
      { code: "config_error", message: "SUPABASE_URL belum di-set", retryable: false },
    ] satisfies ChatErrorInfo[]) {
      assert.equal(cardFor(failTurn(chatTurn("anthropic"), error)).canRetry, false, error.code);
    }
    const network = finishTurn(chatTurn("anthropic"), "ended");
    assert.equal(cardFor(network).canRetry, true);
  });
});
