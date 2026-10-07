import "server-only";

// Pintu masuk modul LLM: pilih adapter berdasarkan provider yang dipilih user
// (dropdown UI → body request), BUKAN hanya dari env. Env DEFAULT_LLM_PROVIDER
// cuma menentukan pilihan awal dropdown.
//
// TIDAK ADA auto-fallback ke provider lain, kapan pun. Kalau provider yang
// dipilih gagal, errornya diteruskan supaya user tahu kenapa jawabannya gagal.

import { getServerEnv } from "@/lib/env";

import { createAnthropicProvider } from "./anthropic";
import { missingKeyError } from "./errors";
import { createOpenAIProvider } from "./openai";
import type { ChatProvider, ProviderName } from "./types";

export type {
  ChatOptions,
  ChatProvider,
  JsonSchemaObject,
  Message,
  ProviderErrorCode,
  ProviderName,
  StreamEvent,
  Tool,
} from "./types";
export { ProviderError } from "./types";
export { collectStream, type CollectedToolCall } from "./stream";

export function isProviderName(x: unknown): x is ProviderName {
  return x === "anthropic" || x === "openai";
}

// 1 instance per provider per proses server, supaya client SDK (dan koneksi
// HTTP-nya) dipakai ulang antar request. Aman karena env di-cache juga:
// mengganti API key memang butuh restart server.
const providers = new Map<ProviderName, ChatProvider>();

/**
 * Adapter untuk provider pilihan user.
 *
 * Melempar ProviderError `missing_key` SEKETIKA kalau API key provider itu
 * belum di-set — supaya API route bisa membalas 503 dengan pesan jelas
 * SEBELUM mulai streaming (bukan error di tengah stream).
 */
export function getProvider(name: ProviderName): ChatProvider {
  const cached = providers.get(name);
  if (cached) return cached;

  const env = getServerEnv();
  const apiKey = name === "anthropic" ? env.anthropicApiKey : env.openaiApiKey;
  if (!apiKey) throw missingKeyError(name);

  const provider =
    name === "anthropic" ? createAnthropicProvider(apiKey) : createOpenAIProvider(apiKey);
  providers.set(name, provider);
  return provider;
}
