import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as AnthropicErrors from "@anthropic-ai/sdk/core/error";
import * as OpenAIErrors from "openai/core/error";

import { missingKeyError, toAnthropicProviderError, toOpenAIProviderError } from "@/lib/llm/errors";
import { ProviderError } from "@/lib/llm/types";

// Error dibuat dengan constructor class SDK asli (sama seperti yang dilempar
// SDK saat menerima respons error), lalu dicek hasil klasifikasinya.

function anthropicBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

describe("toAnthropicProviderError", () => {
  it("401 → auth, pesan menyebut provider & nama env key", () => {
    const err = new AnthropicErrors.AuthenticationError(
      401,
      anthropicBody("authentication_error", "invalid x-api-key"),
      undefined,
      new Headers(),
      "authentication_error",
    );
    const result = toAnthropicProviderError(err);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.code, "auth");
    assert.equal(result.status, 401);
    assert.equal(result.retryable, false);
    assert.match(result.message, /^Anthropic: API key tidak valid/);
    assert.match(result.message, /ANTHROPIC_API_KEY/);
  });

  it("429 → rate_limit (retryable)", () => {
    const err = new AnthropicErrors.RateLimitError(
      429,
      anthropicBody("rate_limit_error", "Number of requests has exceeded your rate limit"),
      undefined,
      new Headers(),
      "rate_limit_error",
    );
    const result = toAnthropicProviderError(err);
    assert.equal(result.code, "rate_limit");
    assert.equal(result.retryable, true);
  });

  it("529 overloaded → overloaded (retryable)", () => {
    const err = new AnthropicErrors.InternalServerError(
      529,
      anthropicBody("overloaded_error", "Overloaded"),
      undefined,
      new Headers(),
      "overloaded_error",
    );
    const result = toAnthropicProviderError(err);
    assert.equal(result.code, "overloaded");
    assert.equal(result.retryable, true);
    assert.match(result.message, /529/);
  });

  it("400 → bad_request dengan detail dari API (mis. saldo habis)", () => {
    const err = new AnthropicErrors.BadRequestError(
      400,
      anthropicBody("invalid_request_error", "Your credit balance is too low to access the Anthropic API."),
      undefined,
      new Headers(),
      "invalid_request_error",
    );
    const result = toAnthropicProviderError(err);
    assert.equal(result.code, "bad_request");
    assert.equal(result.retryable, false);
    assert.match(result.message, /credit balance is too low/);
  });

  it("error di tengah stream (tanpa HTTP status) diklasifikasi dari err.type", () => {
    const err = new AnthropicErrors.APIError(
      undefined,
      anthropicBody("overloaded_error", "Overloaded"),
      undefined,
      new Headers(),
      "overloaded_error",
    );
    const result = toAnthropicProviderError(err);
    assert.equal(result.code, "overloaded");
    assert.equal(result.status, undefined);
    assert.doesNotMatch(result.message, /\(\d+\)/); // tidak mengarang kode status
  });

  it("koneksi gagal / timeout → network (retryable)", () => {
    const conn = toAnthropicProviderError(new AnthropicErrors.APIConnectionError({ message: "Connection error." }));
    assert.equal(conn.code, "network");
    assert.equal(conn.retryable, true);
    const timeout = toAnthropicProviderError(new AnthropicErrors.APIConnectionTimeoutError());
    assert.equal(timeout.code, "network");
    assert.match(timeout.message, /timeout/);
  });

  it("dibatalkan: APIUserAbortError atau signal sudah abort → aborted", () => {
    assert.equal(toAnthropicProviderError(new AnthropicErrors.APIUserAbortError()).code, "aborted");
    const controller = new AbortController();
    controller.abort();
    // Apa pun errornya (mis. "stream terputus"), kalau client membatalkan → aborted.
    const streamCut = new ProviderError({ provider: "anthropic", code: "network", message: "putus" });
    assert.equal(toAnthropicProviderError(streamCut, controller.signal).code, "aborted");
  });

  it("ProviderError (mis. refusal dari pemetaan stream) diteruskan apa adanya", () => {
    const refusal = new ProviderError({ provider: "anthropic", code: "refusal", message: "menolak" });
    assert.equal(toAnthropicProviderError(refusal), refusal);
  });

  it("error non-SDK → unknown, error asli disimpan di cause (untuk log server)", () => {
    const original = new TypeError("boom");
    const result = toAnthropicProviderError(original);
    assert.equal(result.code, "unknown");
    assert.equal(result.cause, original);
    assert.doesNotMatch(result.message, /boom/); // detail internal tidak bocor ke user
  });
});

describe("toOpenAIProviderError", () => {
  it("401 → auth, TANPA meneruskan pesan API (yang memuat potongan API key)", () => {
    const err = new OpenAIErrors.AuthenticationError(
      401,
      {
        message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at ...",
        type: "invalid_request_error",
        code: "invalid_api_key",
        param: null,
      },
      undefined,
      new Headers(),
    );
    const result = toOpenAIProviderError(err);
    assert.equal(result.provider, "openai");
    assert.equal(result.code, "auth");
    assert.match(result.message, /^OpenAI: API key tidak valid/);
    assert.match(result.message, /OPENAI_API_KEY/);
    assert.doesNotMatch(result.message, /sk-/);
  });

  it("429 insufficient_quota → rate_limit TAPI tidak retryable (billing, bukan limit sementara)", () => {
    const err = new OpenAIErrors.RateLimitError(
      429,
      { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
      undefined,
      new Headers(),
    );
    const result = toOpenAIProviderError(err);
    assert.equal(result.code, "rate_limit");
    assert.equal(result.retryable, false);
    assert.match(result.message, /insufficient_quota/);
  });

  it("429 biasa → rate_limit retryable", () => {
    const err = new OpenAIErrors.RateLimitError(
      429,
      { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" },
      undefined,
      new Headers(),
    );
    const result = toOpenAIProviderError(err);
    assert.equal(result.code, "rate_limit");
    assert.equal(result.retryable, true);
  });

  it("400 → bad_request dengan detail", () => {
    const err = new OpenAIErrors.BadRequestError(
      400,
      { message: "Unsupported parameter: 'temperature'", type: "invalid_request_error", param: "temperature" },
      undefined,
      new Headers(),
    );
    const result = toOpenAIProviderError(err);
    assert.equal(result.code, "bad_request");
    assert.match(result.message, /Unsupported parameter/);
  });

  it("5xx → overloaded; error server di tengah stream juga overloaded", () => {
    const http = new OpenAIErrors.InternalServerError(500, { message: "server error" }, undefined, new Headers());
    assert.equal(toOpenAIProviderError(http).code, "overloaded");
    const midStream = new OpenAIErrors.APIError(
      undefined,
      { message: "The server had an error", type: "server_error" },
      undefined,
      undefined,
    );
    assert.equal(toOpenAIProviderError(midStream).code, "overloaded");
  });

  it("koneksi, timeout, dan abort", () => {
    assert.equal(toOpenAIProviderError(new OpenAIErrors.APIConnectionError({})).code, "network");
    assert.equal(toOpenAIProviderError(new OpenAIErrors.APIConnectionTimeoutError()).code, "network");
    assert.equal(toOpenAIProviderError(new OpenAIErrors.APIUserAbortError()).code, "aborted");
  });
});

describe("missingKeyError", () => {
  it("code missing_key, tidak retryable, menyebut env var", () => {
    const err = missingKeyError("anthropic");
    assert.equal(err.code, "missing_key");
    assert.equal(err.retryable, false);
    assert.match(err.message, /ANTHROPIC_API_KEY belum di-set di server/);
    assert.match(missingKeyError("openai").message, /OPENAI_API_KEY/);
  });
});
