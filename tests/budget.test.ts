// Ukuran reservasi budget (lib/server/budget.ts) dan pencatatan biaya saat
// panggilan LLM gagal (lib/server/usage-estimate.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_MODELS, MAX_OUTPUT_TOKENS } from "@/lib/config";
import { chatCostUsd } from "@/lib/llm/pricing";
import { ProviderError } from "@/lib/llm/types";
import { initialChatReserveUsd, llmCallReserveUsd } from "@/lib/server/budget";
import { estimateTokens, mayHaveBeenBilled, reportedUsage, usageAfterFailure } from "@/lib/server/usage-estimate";

describe("initialChatReserveUsd", () => {
  it("cukup untuk ronde pertama dengan output maksimal", () => {
    for (const model of Object.values(CHAT_MODELS)) {
      const reserve = initialChatReserveUsd({ model, question: "Apa itu RAG?", history: [], tools: [] });
      assert.ok(reserve >= chatCostUsd(model, 0, MAX_OUTPUT_TOKENS), `${model}: ${reserve}`);
    }
  });

  it("budget kecil yang wajar (mis. $0.10) tetap muat ≥ 1 pertanyaan", () => {
    for (const model of Object.values(CHAT_MODELS)) {
      const reserve = initialChatReserveUsd({
        model,
        question: "x".repeat(2000),
        history: [
          { role: "user", content: "y".repeat(4000) },
          { role: "assistant", content: "z".repeat(4000) },
        ],
        tools: [],
      });
      assert.ok(reserve < 0.1, `${model}: reservasi ${reserve} menolak semua pertanyaan di budget $0.10`);
    }
  });

  it("ada riwayat → biaya rewrite ikut dipesan; pertanyaan lebih panjang → reservasi lebih besar", () => {
    const model = CHAT_MODELS.anthropic;
    const base = initialChatReserveUsd({ model, question: "Halo", history: [], tools: [] });
    const withHistory = initialChatReserveUsd({
      model,
      question: "Halo",
      history: [{ role: "user", content: "Sebelumnya" }],
      tools: [],
    });
    assert.ok(withHistory > base + chatCostUsd(model, 0, 1000));
    const longer = initialChatReserveUsd({ model, question: "Halo".repeat(300), history: [], tools: [] });
    assert.ok(longer > base);
  });

  it("llmCallReserveUsd = estimasi input + output maksimal", () => {
    const model = CHAT_MODELS.openai;
    assert.equal(llmCallReserveUsd(model, "a".repeat(300), 1500), chatCostUsd(model, 100, 1500));
  });
});

describe("usage saat panggilan LLM gagal", () => {
  const prompt = "p".repeat(300);
  const output = "o".repeat(30);

  it("error dengan HTTP status (provider menolak sebelum stream, mis. 529/500) → tidak ditagih", () => {
    for (const status of [500, 503, 529]) {
      const err = new ProviderError({ provider: "anthropic", code: "overloaded", status, message: "sibuk" });
      assert.equal(mayHaveBeenBilled(err), false, `status ${status}`);
      assert.deepEqual(usageAfterFailure(err, prompt, output), { inputTokens: 0, outputTokens: 0 });
    }
  });

  it("error di TENGAH stream (tanpa status) / error asing → diestimasi", () => {
    const midStream = new ProviderError({ provider: "anthropic", code: "overloaded", message: "putus" });
    assert.equal(mayHaveBeenBilled(midStream), true);
    assert.deepEqual(usageAfterFailure(midStream, prompt, output), {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(output),
    });
    assert.equal(mayHaveBeenBilled(new Error("lain")), true);
  });

  it("ditolak di pintu (key salah dll.) → tidak ditagih", () => {
    const err = new ProviderError({ provider: "openai", code: "auth", message: "key salah" });
    assert.deepEqual(usageAfterFailure(err, prompt, output), { inputTokens: 0, outputTokens: 0 });
  });

  it("usage yang dibawa error dipakai apa adanya (termasuk token thinking yang tak terlihat)", () => {
    const err = new ProviderError({
      provider: "anthropic",
      code: "refusal",
      message: "menolak",
      usage: { inputTokens: 8000, outputTokens: 4096 },
    });
    assert.deepEqual(reportedUsage(err), { inputTokens: 8000, outputTokens: 4096 });
    assert.deepEqual(usageAfterFailure(err, prompt, output), { inputTokens: 8000, outputTokens: 4096 });
  });
});
