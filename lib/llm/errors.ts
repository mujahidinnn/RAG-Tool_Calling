// Error SDK Anthropic / OpenAI → ProviderError dengan pesan Bahasa Indonesia
// yang menyebut nama provider-nya.
//
// Kenapa penting: spec melarang auto-fallback diam-diam ke provider lain.
// Jadi saat gagal, user HARUS tahu provider mana yang gagal dan kenapa
// (key salah? kena limit? server sibuk?) — itu bahan ajar observability.
//
// Klasifikasi memakai class error bertipe dari SDK (`instanceof`), bukan
// mencocokkan isi teks pesan error. File ini tidak memakai server-only
// supaya bisa dites (tests/llm-errors.test.ts); class error diimpor dari
// subpath `core/error` yang ringan, bukan seluruh SDK.

import * as AnthropicErrors from "@anthropic-ai/sdk/core/error";
import * as OpenAIErrors from "openai/core/error";

import { ProviderError, type ProviderErrorCode, type ProviderName } from "./types";

const DISPLAY_NAME: Record<ProviderName, string> = { anthropic: "Anthropic", openai: "OpenAI" };
const KEY_ENV: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

type Classified = { code: ProviderErrorCode; message: string; retryable?: boolean };

/** Error saat API key provider belum di-set (dipakai adapter & getProvider). */
export function missingKeyError(provider: ProviderName): ProviderError {
  return new ProviderError({
    provider,
    code: "missing_key",
    message: `${KEY_ENV[provider]} belum di-set di server — provider ${DISPLAY_NAME[provider]} belum bisa dipakai. Isi key-nya di .env.local atau pilih provider lain.`,
    retryable: false,
  });
}

function abortedError(provider: ProviderName, cause: unknown): ProviderError {
  return new ProviderError({
    provider,
    code: "aborted",
    message: `${DISPLAY_NAME[provider]}: permintaan dibatalkan.`,
    retryable: false,
    cause,
  });
}

// Ambil pesan error dari body respons API (bentuknya beda per provider):
// Anthropic: { type: "error", error: { type, message } }; OpenAI: { message, type, code }.
function apiDetail(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const nested = "error" in body ? body.error : null;
  const source = typeof nested === "object" && nested !== null ? nested : body;
  if ("message" in source && typeof source.message === "string" && source.message.trim() !== "") {
    const message = source.message.trim();
    return message.length > 300 ? `${message.slice(0, 300)}…` : message;
  }
  return null;
}

type ErrorKind = "auth" | "forbidden" | "not_found" | "rate_limit" | "overloaded" | "bad_request";

function kindFromStatus(status: number): ErrorKind | null {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "bad_request";
  return null;
}

/**
 * Pesan per jenis error. `status` null = error datang di tengah stream (tidak
 * ada HTTP status), jadi kode status tidak ditampilkan.
 * Detail dari API hanya disertakan untuk error "request salah" — pesan error
 * auth sengaja tidak diteruskan karena OpenAI menyertakan potongan API key.
 */
function describe(
  provider: ProviderName,
  kind: ErrorKind | null,
  status: number | null,
  detail: string | null,
): Classified {
  const name = DISPLAY_NAME[provider];
  const tag = status === null ? "" : ` (${status})`;
  const withDetail = detail ? ` Detail: ${detail}` : "";

  switch (kind) {
    case "auth":
      return {
        code: "auth",
        message: `${name}: API key tidak valid atau sudah dicabut${tag}. Cek ${KEY_ENV[provider]} di server.`,
      };
    case "forbidden":
      return {
        code: "auth",
        message: `${name}: akses ditolak${tag} — API key tidak punya izin untuk model/fitur ini.`,
      };
    case "not_found":
      return {
        code: "bad_request",
        message: `${name}: model atau endpoint tidak ditemukan${tag}. Cek CHAT_MODELS di lib/config.ts.${withDetail}`,
      };
    case "rate_limit":
      return {
        code: "rate_limit",
        message: `${name}: kena rate limit${tag}. Tunggu sebentar lalu coba lagi.`,
      };
    case "overloaded":
      return {
        code: "overloaded",
        message: `${name}: server provider sedang sibuk/bermasalah${tag}. Coba lagi sebentar lagi.`,
      };
    case "bad_request":
      return { code: "bad_request", message: `${name}: request ditolak${tag}.${withDetail}` };
    case null:
      return { code: "unknown", message: `${name}: respons tidak terduga${tag}.` };
  }
}

/** Klasifikasi berdasarkan HTTP status (setelah dipastikan errornya APIError). */
function classifyStatus(provider: ProviderName, status: number, detail: string | null): Classified {
  return describe(provider, kindFromStatus(status), status, detail);
}

function connectionError(provider: ProviderName, timeout: boolean): Classified {
  const name = DISPLAY_NAME[provider];
  return {
    code: "network",
    message: timeout
      ? `${name}: tidak ada respons (timeout). Coba lagi sebentar lagi.`
      : `${name}: gagal terhubung ke server provider. Cek koneksi internet server lalu coba lagi.`,
  };
}

function unknownError(provider: ProviderName): Classified {
  return {
    code: "unknown",
    message: `${DISPLAY_NAME[provider]}: terjadi error tak terduga saat memanggil model. Coba lagi.`,
  };
}

function build(provider: ProviderName, info: Classified, err: unknown): ProviderError {
  const status =
    err instanceof AnthropicErrors.APIError || err instanceof OpenAIErrors.APIError
      ? err.status
      : undefined;
  return new ProviderError({
    provider,
    code: info.code,
    message: info.message,
    status,
    retryable: info.retryable,
    cause: err,
  });
}

/**
 * Error apa pun dari pemanggilan Anthropic → ProviderError.
 * `signal` dicek duluan: kalau client yang membatalkan, apa pun errornya
 * (termasuk "stream terputus"), penyebab sebenarnya adalah pembatalan.
 */
export function toAnthropicProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  const provider: ProviderName = "anthropic";
  if (signal?.aborted || err instanceof AnthropicErrors.APIUserAbortError) {
    return abortedError(provider, err);
  }
  if (err instanceof ProviderError) return err;

  if (err instanceof AnthropicErrors.APIConnectionTimeoutError) {
    return build(provider, connectionError(provider, true), err);
  }
  if (err instanceof AnthropicErrors.APIConnectionError) {
    return build(provider, connectionError(provider, false), err);
  }
  if (err instanceof AnthropicErrors.APIError) {
    if (typeof err.status === "number") {
      return build(provider, classifyStatus(provider, err.status, apiDetail(err.error)), err);
    }
    // Error yang datang DI TENGAH stream (event SSE `error`) tidak punya
    // HTTP status — jenisnya ada di field bertipe `err.type`.
    switch (err.type) {
      case "overloaded_error":
      case "api_error":
      case "timeout_error":
        return build(provider, describe(provider, "overloaded", null, null), err);
      case "rate_limit_error":
        return build(provider, describe(provider, "rate_limit", null, null), err);
      case "authentication_error":
        return build(provider, describe(provider, "auth", null, null), err);
      case "permission_error":
        return build(provider, describe(provider, "forbidden", null, null), err);
      case "billing_error":
        return build(
          provider,
          {
            code: "bad_request",
            message: "Anthropic: ada masalah billing di akun API (saldo/kredit habis?).",
          },
          err,
        );
      case "invalid_request_error":
      case "not_found_error":
        return build(provider, describe(provider, "bad_request", null, apiDetail(err.error)), err);
      default:
        return build(provider, unknownError(provider), err);
    }
  }
  return build(provider, unknownError(provider), err);
}

/** Error apa pun dari pemanggilan OpenAI → ProviderError. */
export function toOpenAIProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  const provider: ProviderName = "openai";
  if (signal?.aborted || err instanceof OpenAIErrors.APIUserAbortError) {
    return abortedError(provider, err);
  }
  if (err instanceof ProviderError) return err;

  if (err instanceof OpenAIErrors.APIConnectionTimeoutError) {
    return build(provider, connectionError(provider, true), err);
  }
  if (err instanceof OpenAIErrors.APIConnectionError) {
    return build(provider, connectionError(provider, false), err);
  }
  // 429 di OpenAI punya 2 arti: rate limit sementara, ATAU kuota/billing
  // habis (code "insufficient_quota") yang tidak akan sembuh dengan retry.
  if (err instanceof OpenAIErrors.RateLimitError && err.code === "insufficient_quota") {
    return build(
      provider,
      {
        code: "rate_limit",
        message: "OpenAI: kuota/billing akun API habis (insufficient_quota). Cek billing di dashboard OpenAI.",
        retryable: false,
      },
      err,
    );
  }
  if (err instanceof OpenAIErrors.APIError) {
    if (typeof err.status === "number") {
      return build(provider, classifyStatus(provider, err.status, apiDetail(err.error)), err);
    }
    // Error di tengah stream (tanpa HTTP status).
    if (err.type === "server_error") {
      return build(provider, describe(provider, "overloaded", null, null), err);
    }
    return build(provider, unknownError(provider), err);
  }
  return build(provider, unknownError(provider), err);
}
