import "server-only";

// Adapter Anthropic (Claude) untuk interface ChatProvider.
// Alurnya: riwayat generik → translate.ts → Messages API (streaming) →
// stream.ts → StreamEvent generik. Error SDK → errors.ts → ProviderError.

import Anthropic from "@anthropic-ai/sdk";

import { CHAT_MODELS, MAX_OUTPUT_TOKENS, PROVIDER_LABELS } from "@/lib/config";
import { buildSystemPrompt } from "@/lib/rag/prompt";

import { missingKeyError, toAnthropicProviderError } from "./errors";
import { mapAnthropicStream } from "./stream";
import { toAnthropicMessages, toAnthropicTools } from "./translate";
import type { ChatOptions, ChatProvider, Message, StreamEvent, Tool } from "./types";

// Batas waktu per request ke API. Route chat punya maxDuration 60 detik, jadi
// request yang menggantung lebih lama dari itu tidak ada gunanya ditunggu.
const REQUEST_TIMEOUT_MS = 55_000;
// SDK otomatis retry (dengan backoff) untuk 429/5xx/koneksi putus. Retry ini
// tetap ke provider YANG SAMA — bukan fallback ke provider lain.
const MAX_RETRIES = 2;

export function createAnthropicProvider(apiKey: string | null): ChatProvider {
  const model = CHAT_MODELS.anthropic;
  // Client dibuat sekali per provider (lazy) dan dipakai ulang antar request.
  let client: Anthropic | null = null;

  async function* streamChat(
    messages: Message[],
    context: string,
    tools?: Tool[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    if (!apiKey) throw missingKeyError("anthropic");
    client ??= new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    const { signal } = options;

    try {
      // Sengaja `messages.create({ stream: true })` (event SSE mentah), bukan
      // helper `messages.stream()`: kita memetakan event sendiri di
      // stream.ts, termasuk parse JSON input tool secara ketat. Helper
      // stream() juga membangun snapshot pesan + parse JSON toleran yang
      // tidak kita pakai (dan errornya muncul di tengah iterasi).
      const stream = await client.messages.create(
        {
          model,
          max_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          system: options.system ?? buildSystemPrompt(context),
          messages: toAnthropicMessages(messages),
          ...(tools && tools.length > 0
            ? {
                tools: toAnthropicTools(tools),
                // "none" didukung Sonnet 5.5 (yang ditolak hanya forced "any"/"tool").
                ...(options.toolChoice === "none" ? { tool_choice: { type: "none" as const } } : {}),
              }
            : {}),
          // Claude Sonnet 5.5: effort "low" adalah titik awal yang dianjurkan
          // untuk chat/Q&A — jawaban cepat, thinking minim. Field `thinking`
          // sengaja TIDAK dikirim: adaptive thinking adalah default, dan
          // `{ type: "disabled" }` ditolak (400) oleh model ini. Temperature
          // juga tidak di-set (pakai default model).
          output_config: { effort: "low" },
          stream: true,
        },
        { signal },
      );
      // Prompt caching sengaja tidak dipakai: system prompt berisi context
      // hasil retrieval yang berubah tiap pertanyaan, jadi cache jarang kena,
      // dan biaya tetap mudah dihitung dengan 1 harga input.
      yield* mapAnthropicStream(stream);
    } catch (err) {
      throw toAnthropicProviderError(err, signal);
    }
  }

  return { name: "anthropic", model, label: PROVIDER_LABELS.anthropic, streamChat };
}
