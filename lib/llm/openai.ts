import "server-only";

// Adapter OpenAI (GPT) untuk interface ChatProvider, memakai Chat Completions
// API (spec: hasil tool dikirim sebagai pesan `role: "tool"`).
// Alurnya sama persis dengan anthropic.ts — itulah gunanya adapter.

import OpenAI from "openai";

import { CHAT_MODELS, MAX_OUTPUT_TOKENS, PROVIDER_LABELS } from "@/lib/config";
import { buildSystemPrompt } from "@/lib/rag/prompt";

import { missingKeyError, toOpenAIProviderError } from "./errors";
import { mapOpenAIStream } from "./stream";
import { toOpenAIMessages, toOpenAITools } from "./translate";
import type { ChatOptions, ChatProvider, Message, StreamEvent, Tool } from "./types";

// Lihat alasan kedua angka ini di anthropic.ts.
const REQUEST_TIMEOUT_MS = 55_000;
const MAX_RETRIES = 2;

export function createOpenAIProvider(apiKey: string | null): ChatProvider {
  const model = CHAT_MODELS.openai;
  let client: OpenAI | null = null;

  async function* streamChat(
    messages: Message[],
    context: string,
    tools?: Tool[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    if (!apiKey) throw missingKeyError("openai");
    client ??= new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    const { signal } = options;

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(options.system ?? buildSystemPrompt(context), messages),
          ...(tools && tools.length > 0
            ? {
                tools: toOpenAITools(tools),
                ...(options.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
              }
            : {}),
          stream: true,
          // Tanpa ini, stream tidak membawa jumlah token sama sekali → biaya
          // & daily cap tidak bisa dihitung. Usage datang di chunk terakhir.
          stream_options: { include_usage: true },
          // Model reasoning: `max_completion_tokens` (bukan `max_tokens` yang
          // deprecated) dan batas ini MENCAKUP token reasoning.
          max_completion_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          // Setara effort "low" di Claude: cukup untuk Q&A berbasis dokumen,
          // lebih cepat & hemat token reasoning.
          reasoning_effort: "low",
        },
        { signal },
      );
      yield* mapOpenAIStream(stream);
    } catch (err) {
      throw toOpenAIProviderError(err, signal);
    }
  }

  return { name: "openai", model, label: PROVIDER_LABELS.openai, streamChat };
}
