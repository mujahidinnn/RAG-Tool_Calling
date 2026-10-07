import "server-only";

// Langkah 3 pipeline RAG (spec §3.3). Embedding SELALU 1 provider (OpenAI),
// apa pun provider chat yang dipilih user (spec §0): kalau ikut multi-provider,
// dimensi vector beda-beda dan kolom vector(1536) di pgvector tidak bisa dipakai
// bersama. Chat boleh ganti provider kapan saja tanpa embed ulang dokumen.

import OpenAI from "openai";

import { EMBEDDING_DIMENSIONS } from "@/lib/config";
import { getServerEnv } from "@/lib/env";
import { embeddingCostUsd } from "@/lib/llm/pricing";
import { ProviderError } from "@/lib/llm/types";

/** Jumlah teks per request ke API embeddings. */
const BATCH_SIZE = 100;
/** Batch yang dikirim bersamaan — dokumen besar (ribuan chunk) jadi beberapa kali lebih cepat. */
const PARALLEL_BATCHES = 3;

const MISSING_KEY_MESSAGE =
  "OPENAI_API_KEY belum di-set — dibutuhkan untuk embedding (embedding selalu pakai OpenAI, apa pun provider chat-nya).";

let cachedClient: { apiKey: string; client: OpenAI } | null = null;

function getClient(): OpenAI {
  const { openaiApiKey } = getServerEnv();
  if (!openaiApiKey) {
    // ProviderError (bukan Error biasa) supaya route chat menampilkannya apa
    // adanya sebagai error provider "openai" — jelas kenapa gagal, walau user
    // sedang memilih Claude untuk chat.
    throw new ProviderError({ provider: "openai", code: "missing_key", message: MISSING_KEY_MESSAGE });
  }
  if (cachedClient?.apiKey !== openaiApiKey) {
    cachedClient = {
      apiKey: openaiApiKey,
      // Timeout pendek: pemrosesan dokumen berjalan di after() dengan batas maxDuration.
      client: new OpenAI({ apiKey: openaiApiKey, timeout: 30_000, maxRetries: 2 }),
    };
  }
  return cachedClient.client;
}

export type EmbedResult = { embeddings: number[][]; tokens: number; costUsd: number };

/** Embed banyak teks sekaligus (urutan hasil = urutan input). */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], tokens: 0, costUsd: 0 };
  if (texts.some((text) => text.trim() === "")) {
    // API menolak string kosong; ini bug di pemanggil, bukan kesalahan user.
    throw new Error("embedTexts: input tidak boleh berisi teks kosong.");
  }

  const client = getClient();
  const model = getServerEnv().embeddingModel;

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) batches.push(texts.slice(i, i + BATCH_SIZE));

  const embeddings: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
    const group = batches.slice(i, i + PARALLEL_BATCHES);
    const results = await Promise.all(group.map((batch) => embedBatch(client, model, batch, signal)));
    for (const result of results) {
      embeddings.push(...result.vectors);
      tokens += result.tokens;
    }
  }
  return { embeddings, tokens, costUsd: embeddingCostUsd(model, tokens) };
}

/** Embed 1 query (pertanyaan user) untuk retrieval. */
export async function embedQuery(
  text: string,
  signal?: AbortSignal,
): Promise<{ embedding: number[]; tokens: number; costUsd: number }> {
  const { embeddings, tokens, costUsd } = await embedTexts([text], signal);
  return { embedding: embeddings[0], tokens, costUsd };
}

/**
 * Format vector untuk parameter pgvector lewat supabase-js/PostgREST:
 * literal string "[0.1,0.2,...]" (array JSON biasa tidak otomatis jadi vector).
 */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function embedBatch(
  client: OpenAI,
  model: string,
  input: string[],
  signal: AbortSignal | undefined,
): Promise<{ vectors: number[][]; tokens: number }> {
  let response: OpenAI.CreateEmbeddingResponse;
  try {
    // encoding_format "float" eksplisit: default SDK minta base64 lalu
    // mengubahnya jadi Float32Array — bukan number[] seperti tertulis di tipe.
    response = await client.embeddings.create({ model, input, encoding_format: "float" }, { signal });
  } catch (err) {
    throw toProviderError(err, model);
  }

  const vectors: number[][] = new Array<number[]>(input.length);
  for (const item of response.data) {
    if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Model embedding "${model}" menghasilkan vector ${item.embedding.length} dimensi, padahal ` +
          `database memakai vector(${EMBEDDING_DIMENSIONS}). Samakan EMBEDDING_MODEL, ` +
          "EMBEDDING_DIMENSIONS (lib/config.ts), dan schema.sql.",
      );
    }
    vectors[item.index] = item.embedding;
  }
  // Jangan asumsikan API selalu mengembalikan semua item: vector yang hilang
  // akan membuat chunk tersimpan dengan embedding yang salah pasangan.
  for (let i = 0; i < input.length; i++) {
    if (!vectors[i]) throw new Error(`Respons embedding tidak lengkap (item #${i} hilang).`);
  }
  return { vectors, tokens: response.usage.prompt_tokens };
}

/** Terjemahkan error SDK OpenAI jadi ProviderError dengan pesan yang jelas. */
function toProviderError(err: unknown, model: string): unknown {
  const fail = (code: ConstructorParameters<typeof ProviderError>[0]["code"], message: string, status?: number) =>
    new ProviderError({ provider: "openai", code, message: `OpenAI (embedding): ${message}`, status, cause: err });

  // Urutan penting: subclass dicek sebelum parent-nya (mis. Timeout ⊂ Connection).
  if (err instanceof OpenAI.APIUserAbortError) return fail("aborted", "permintaan dibatalkan.");
  if (err instanceof OpenAI.APIConnectionTimeoutError) return fail("network", "timeout saat menghubungi API.");
  if (err instanceof OpenAI.APIConnectionError) return fail("network", "gagal terhubung ke API.");
  if (err instanceof OpenAI.AuthenticationError) {
    return fail("auth", "API key tidak valid atau sudah dicabut. Periksa OPENAI_API_KEY.", 401);
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return fail("auth", `akun/API key tidak punya akses ke model "${model}".`, 403);
  }
  if (err instanceof OpenAI.RateLimitError) {
    // 429 "insufficient_quota" = kuota/billing habis → percuma di-retry.
    return err.code === "insufficient_quota"
      ? new ProviderError({
          provider: "openai",
          code: "rate_limit",
          message: "OpenAI (embedding): kuota/billing akun habis.",
          status: 429,
          retryable: false,
          cause: err,
        })
      : fail("rate_limit", "terkena rate limit. Coba lagi sebentar lagi.", 429);
  }
  if (err instanceof OpenAI.NotFoundError) {
    return fail("bad_request", `model "${model}" tidak ditemukan. Periksa EMBEDDING_MODEL.`, 404);
  }
  if (err instanceof OpenAI.BadRequestError) return fail("bad_request", "request ditolak (400).", 400);
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    return status !== undefined && status >= 500
      ? fail("overloaded", `server sedang bermasalah (${status}). Coba lagi sebentar lagi.`, status)
      : fail("unknown", `error tak terduga${status ? ` (${status})` : ""}.`, status);
  }
  return err;
}
