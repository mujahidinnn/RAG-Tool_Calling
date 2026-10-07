// Map harga per model — SATU-SATUNYA tempat harga provider ditulis.
//
// Kenapa hardcode (bukan fetch dari API)? Provider tidak punya endpoint harga
// yang stabil & reliable; harga hanya diumumkan di halaman pricing. Jadi kita
// catat manual + tanggal verifikasinya, dan update file ini kalau harga berubah.
//
// Kenapa satuan $/1 juta token (bukan $/1k seperti contoh di spec)? Karena
// Anthropic & OpenAI sama-sama mempublikasikan harga per 1M token (MTok) —
// menyalin angka apa adanya mengurangi risiko salah konversi saat update.
//
// File ini PURE (tanpa server-only / env) supaya bisa dites & dipakai di mana saja.

/** Tanggal terakhir harga di bawah dicek manual ke halaman pricing resmi. */
export const PRICING_LAST_VERIFIED = "2026-10-07";

export type ChatModelPrice = { inputPerMTok: number; outputPerMTok: number };
export type EmbeddingModelPrice = { inputPerMTok: number };

export const CHAT_PRICING: Record<string, ChatModelPrice> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 }, // anthropic.com/pricing
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 }, // openai.com/api/pricing (harga sejak 30 Jul 2026)
};

export const EMBEDDING_PRICING: Record<string, EmbeddingModelPrice> = {
  "text-embedding-3-small": { inputPerMTok: 0.02 }, // openai.com/api/pricing
};

const TOKENS_PER_MTOK = 1_000_000;

// Token negatif / NaN = bug di pemanggil. Lebih baik gagal keras daripada
// diam-diam menghitung biaya negatif yang "mengembalikan" budget harian.
function assertTokenCount(label: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`Jumlah token ${label} tidak valid: ${tokens}`);
  }
}

/**
 * Estimasi biaya 1 panggilan chat dalam USD.
 *
 * Model tanpa harga → throw. Sengaja: kalau CHAT_MODELS di lib/config.ts
 * diganti tapi map ini lupa di-update, biaya akan terhitung 0 dan daily cap
 * jebol tanpa ketahuan. Error di sini membuat kelalaian itu langsung terlihat.
 *
 * Catatan: token cache (prompt caching) dihitung dengan harga input biasa —
 * kita tidak memakai prompt caching, jadi ini cukup akurat untuk demo.
 */
export function chatCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = CHAT_PRICING[model];
  if (!price) {
    throw new Error(
      `Harga model chat "${model}" belum ada di lib/llm/pricing.ts — tambahkan dulu supaya biaya & daily cap tetap terhitung.`,
    );
  }
  assertTokenCount("input", inputTokens);
  assertTokenCount("output", outputTokens);
  return (
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / TOKENS_PER_MTOK
  );
}

/** Biaya embedding dalam USD. Model tanpa harga → throw (alasan sama dengan chatCostUsd). */
export function embeddingCostUsd(model: string, tokens: number): number {
  const price = EMBEDDING_PRICING[model];
  if (!price) {
    throw new Error(
      `Harga model embedding "${model}" belum ada di lib/llm/pricing.ts — tambahkan dulu supaya biaya & daily cap tetap terhitung.`,
    );
  }
  assertTokenCount("embedding", tokens);
  return (tokens * price.inputPerMTok) / TOKENS_PER_MTOK;
}

/**
 * Format biaya untuk badge UI: "$0.0012", "<$0.0001", "$1.25".
 * Biaya per pesan biasanya < 1 sen, jadi 2 desimal ala harga belanja akan
 * selalu tampil "$0.00" — makanya pakai 4 desimal untuk angka kecil.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
