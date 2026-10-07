import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_MODELS } from "@/lib/config";
import {
  CHAT_PRICING,
  chatCostUsd,
  embeddingCostUsd,
  formatUsd,
  PRICING_LAST_VERIFIED,
} from "@/lib/llm/pricing";

describe("chatCostUsd", () => {
  it("menghitung biaya dari harga per 1 juta token", () => {
    // claude-sonnet-5-5: $2 input + $10 output per MTok.
    assert.equal(chatCostUsd("claude-sonnet-5-5", 1_000_000, 0), 2);
    assert.equal(chatCostUsd("claude-sonnet-5-5", 0, 1_000_000), 10);
    // 1.000 input + 500 output = 0.002 + 0.005
    assert.ok(Math.abs(chatCostUsd("claude-sonnet-5-5", 1000, 500) - 0.007) < 1e-12);
    // gpt-5.6-terra: $2 input + $12 output per MTok.
    assert.ok(Math.abs(chatCostUsd("gpt-5.6-terra", 1000, 500) - 0.008) < 1e-12);
  });

  it("0 token = $0", () => {
    assert.equal(chatCostUsd("gpt-5.6-terra", 0, 0), 0);
  });

  it("model tanpa harga → throw (supaya ganti model tanpa update harga langsung ketahuan)", () => {
    assert.throws(() => chatCostUsd("model-baru-tanpa-harga", 10, 10), /belum ada di lib\/llm\/pricing\.ts/);
  });

  it("jumlah token negatif / NaN → throw", () => {
    assert.throws(() => chatCostUsd("claude-sonnet-5-5", -1, 0));
    assert.throws(() => chatCostUsd("claude-sonnet-5-5", 0, Number.NaN));
  });

  it("setiap model di CHAT_MODELS punya harga", () => {
    for (const model of Object.values(CHAT_MODELS)) {
      assert.ok(CHAT_PRICING[model], `harga untuk ${model} belum ada`);
    }
  });

  it("tanggal verifikasi harga tercatat (YYYY-MM-DD)", () => {
    assert.match(PRICING_LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("embeddingCostUsd", () => {
  it("text-embedding-3-small = $0.02 per MTok", () => {
    assert.ok(Math.abs(embeddingCostUsd("text-embedding-3-small", 1_000_000) - 0.02) < 1e-12);
    assert.ok(Math.abs(embeddingCostUsd("text-embedding-3-small", 5000) - 0.0001) < 1e-12);
  });

  it("model embedding tanpa harga → throw", () => {
    assert.throws(() => embeddingCostUsd("text-embedding-entah", 10), /belum ada/);
  });
});

describe("formatUsd", () => {
  it("angka kecil pakai 4 desimal", () => {
    assert.equal(formatUsd(0.0012), "$0.0012");
    assert.equal(formatUsd(0.0001), "$0.0001");
    assert.equal(formatUsd(0.12345), "$0.1235");
  });

  it("di bawah $0.0001 → '<$0.0001' (bukan '$0.0000' yang menyesatkan)", () => {
    assert.equal(formatUsd(0.00004), "<$0.0001");
  });

  it("nol / tidak valid → '$0'", () => {
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(-1), "$0");
    assert.equal(formatUsd(Number.NaN), "$0");
  });

  it(">= $1 pakai 2 desimal", () => {
    assert.equal(formatUsd(1.234), "$1.23");
    assert.equal(formatUsd(2), "$2.00");
  });
});
