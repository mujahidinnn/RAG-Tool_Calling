import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStreamEvent,
  assistantText,
  buildHistory,
  chatReducer,
  createAssistantTurn,
  finishTurn,
  type AssistantTurn,
  type ChatTurn,
} from "@/lib/client/chat";
import { MAX_HISTORY_MESSAGE_CHARS, MAX_HISTORY_MESSAGES } from "@/lib/config";
import type { ChatStreamEvent } from "@/lib/types";

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
