import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/lib/llm/types";
import { estimateTokens, mayHaveBeenBilled } from "@/lib/server/usage-estimate";
import { NO_USAGE, pickEvenlySpaced, toolErrorResult } from "@/lib/tools/shared";

describe("pickEvenlySpaced (sampel chunk untuk ringkasan dokumen panjang)", () => {
  it("total <= count → semua indeks", () => {
    assert.deepEqual(pickEvenlySpaced(3, 24), [0, 1, 2]);
    assert.deepEqual(pickEvenlySpaced(24, 24), Array.from({ length: 24 }, (_, i) => i));
  });

  it("sampel selalu memuat awal & akhir, urut naik, tanpa duplikat, jumlah tepat", () => {
    for (const total of [25, 26, 50, 99, 1000, 2917]) {
      for (const count of [2, 3, 7, 24]) {
        const picked = pickEvenlySpaced(total, count);
        assert.equal(picked.length, count, `total=${total} count=${count}`);
        assert.equal(picked[0], 0);
        assert.equal(picked[picked.length - 1], total - 1);
        for (let i = 1; i < picked.length; i++) {
          assert.ok(picked[i] > picked[i - 1], `harus naik ketat: ${picked.join(",")}`);
        }
      }
    }
  });

  it("tersebar merata (awal, tengah, akhir)", () => {
    assert.deepEqual(pickEvenlySpaced(101, 5), [0, 25, 50, 75, 100]);
    assert.deepEqual(pickEvenlySpaced(10, 3), [0, 5, 9]); // 4.5 dibulatkan ke 5
  });

  it("input aneh → [] atau [0], tidak pernah melempar", () => {
    assert.deepEqual(pickEvenlySpaced(0, 5), []);
    assert.deepEqual(pickEvenlySpaced(10, 0), []);
    assert.deepEqual(pickEvenlySpaced(-3, 2), []);
    assert.deepEqual(pickEvenlySpaced(2.5, 2), []);
    assert.deepEqual(pickEvenlySpaced(10, 1), [0]);
  });
});

describe("toolErrorResult", () => {
  it("string JSON untuk model + card error untuk UI, usage default 0", () => {
    const result = toolErrorResult('Dokumen "a.pdf" masih diproses.');
    assert.deepEqual(JSON.parse(result.content), { error: 'Dokumen "a.pdf" masih diproses.' });
    assert.deepEqual(result.payload, { kind: "error", message: 'Dokumen "a.pdf" masih diproses.' });
    assert.deepEqual(result.usage, NO_USAGE);
  });

  it("usage bisa dibawa (mis. ringkasan gagal setelah token terpakai)", () => {
    assert.deepEqual(toolErrorResult("gagal", { inputTokens: 10, outputTokens: 0 }).usage, {
      inputTokens: 10,
      outputTokens: 0,
    });
  });
});

describe("usage-estimate", () => {
  it("estimateTokens membulatkan ke atas (lebih aman untuk budget)", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 2);
    // Estimasi harus >= hitungan kasar 4 karakter/token.
    const text = "Cuti tahunan karyawan tetap adalah dua belas hari kerja per tahun.";
    assert.ok(estimateTokens(text) >= Math.ceil(text.length / 4));
  });

  it("error yang ditolak sebelum diproses tidak dianggap ditagih", () => {
    for (const code of ["missing_key", "auth", "bad_request", "rate_limit"] as const) {
      assert.equal(mayHaveBeenBilled(new ProviderError({ provider: "openai", code, message: code })), false, code);
    }
  });

  it("stream putus / dibatalkan / error tak dikenal → dianggap ditagih (ragu = aman)", () => {
    for (const code of ["overloaded", "network", "aborted", "refusal", "unknown"] as const) {
      assert.equal(mayHaveBeenBilled(new ProviderError({ provider: "anthropic", code, message: code })), true, code);
    }
    assert.equal(mayHaveBeenBilled(new Error("apa saja")), true);
    assert.equal(mayHaveBeenBilled(null), true);
  });

  it("ProviderError dari salinan modul lain (instanceof gagal) tetap dikenali lewat name + code", () => {
    const foreign = Object.assign(new Error("x"), { name: "ProviderError", code: "auth" });
    assert.equal(mayHaveBeenBilled(foreign), false);
  });
});
