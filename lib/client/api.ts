// Wrapper fetch bertipe untuk semua API route. Komponen UI tidak memanggil
// `fetch` langsung, jadi penanganan error cukup di 1 tempat: setiap kegagalan
// dilempar sebagai ApiClientError dengan pesan siap tampil (Bahasa Indonesia).
//
// Catatan keamanan: tidak ada secret di sini. Cookie sesi & auth bersifat
// httpOnly — browser mengirimnya otomatis, JavaScript tidak bisa membacanya.

import { createSseParser } from "@/lib/client/sse";
import type {
  ApiErrorBody,
  ApiErrorCode,
  AuthStatusResponse,
  ChatRequestBody,
  ChatStreamEvent,
  DocumentDTO,
  DocumentsResponse,
  ProviderName,
} from "@/lib/types";

/** Kode tambahan khusus client: gagal jaringan & dibatalkan user. */
export type ClientErrorCode = ApiErrorCode | "network" | "aborted";

export class ApiClientError extends Error {
  readonly status: number; // 0 = tidak ada respons HTTP (jaringan / dibatalkan)
  readonly code: ClientErrorCode;
  readonly retryAfterSec?: number;
  readonly retryable: boolean;
  readonly provider?: ProviderName;

  constructor(opts: {
    status: number;
    code: ClientErrorCode;
    message: string;
    retryAfterSec?: number;
    retryable?: boolean;
    provider?: ProviderName;
  }) {
    super(opts.message);
    this.name = "ApiClientError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterSec = opts.retryAfterSec;
    this.retryable = opts.retryable ?? (opts.status === 0 || opts.status >= 500 || opts.status === 429);
    this.provider = opts.provider;
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof ApiClientError && err.code === "aborted") ||
    (err instanceof DOMException && err.name === "AbortError")
  );
}

// --- Parsing error ------------------------------------------------------------------

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  "unauthorized",
  "invalid_passcode",
  "too_many_attempts",
  "rate_limited",
  "daily_limit",
  "file_too_large",
  "unsupported_type",
  "too_many_files",
  "empty_file",
  "not_found",
  "bad_request",
  "provider_error",
  "config_error",
  "internal",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validasi ringan bentuk ApiErrorBody tanpa zod (hemat ukuran bundle client). */
function asApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message, retryable, retryAfterSec, provider } = value.error;
  if (typeof code !== "string" || !API_ERROR_CODES.has(code) || typeof message !== "string") {
    return null;
  }
  return {
    error: {
      code: code as ApiErrorCode,
      message,
      retryable: typeof retryable === "boolean" ? retryable : undefined,
      retryAfterSec: typeof retryAfterSec === "number" ? retryAfterSec : undefined,
      provider: provider === "anthropic" || provider === "openai" ? provider : undefined,
    },
  };
}

// Respons error bisa datang dari platform hosting (bukan route kita) dan
// tidak berbentuk JSON — mis. 413 dari reverse proxy. Tetap beri pesan jelas.
function fallbackError(status: number): { code: ApiErrorCode; message: string } {
  if (status === 401) return { code: "unauthorized", message: "Masukkan passcode demo dulu." };
  if (status === 413) return { code: "file_too_large", message: "File melebihi 5 MB." };
  if (status === 429) {
    return { code: "rate_limited", message: "Terlalu banyak permintaan. Coba lagi sebentar lagi." };
  }
  if (status >= 500) {
    return { code: "internal", message: "Server sedang bermasalah. Coba lagi sebentar lagi." };
  }
  return { code: "bad_request", message: `Permintaan gagal (HTTP ${status}).` };
}

function errorFromBody(status: number, body: unknown, retryAfterHeader: string | null): ApiClientError {
  const parsed = asApiErrorBody(body);
  const headerSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterSec =
    parsed?.error.retryAfterSec ?? (Number.isFinite(headerSeconds) ? headerSeconds : undefined);
  if (!parsed) return new ApiClientError({ status, ...fallbackError(status), retryAfterSec });
  return new ApiClientError({
    status,
    code: parsed.error.code,
    message: parsed.error.message,
    retryAfterSec,
    retryable: parsed.error.retryable,
    provider: parsed.error.provider,
  });
}

async function errorFromResponse(response: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Body bukan JSON — pakai pesan fallback berdasarkan status.
  }
  return errorFromBody(response.status, body, response.headers.get("retry-after"));
}

const NETWORK_MESSAGE = "Tidak bisa terhubung ke server. Periksa koneksi internet lalu coba lagi.";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // no-store: semua data di sini per-sesi & berubah terus (status dokumen, auth).
    response = await fetch(input, { cache: "no-store", ...init });
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiClientError({ status: 0, code: "aborted", message: "Dibatalkan." });
    }
    throw new ApiClientError({ status: 0, code: "network", message: NETWORK_MESSAGE });
  }
  if (!response.ok) throw await errorFromResponse(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiClientError({
      status: response.status,
      code: "internal",
      message: "Respons server tidak valid.",
    });
  }
}

// --- Auth -----------------------------------------------------------------------------

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return request<AuthStatusResponse>("/api/auth");
}

export function submitPasscode(passcode: string): Promise<AuthStatusResponse> {
  return request<AuthStatusResponse>("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
}

export async function logout(): Promise<void> {
  await request<{ authenticated: false }>("/api/auth", { method: "DELETE" });
}

// --- Dokumen -------------------------------------------------------------------------

export async function listDocuments(): Promise<DocumentDTO[]> {
  const body = await request<DocumentsResponse>("/api/documents");
  return body.documents;
}

export async function deleteDocument(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Upload 1 file sebagai raw body (bukan multipart) — server menghitung byte
 * aktual selagi membaca stream (spec §2).
 *
 * Kenapa XMLHttpRequest, bukan fetch? `fetch` di browser belum punya event
 * progress untuk upload; XHR punya `xhr.upload.onprogress` untuk progress bar.
 */
export function uploadDocument(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<DocumentDTO> {
  return new Promise<DocumentDTO>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiClientError({ status: 0, code: "aborted", message: "Upload dibatalkan." }));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    // Content-Type dari browser hanya informasi; server memvalidasi isi file sendiri.
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    // Header HTTP hanya boleh ASCII → nama file di-encode (server men-decode & menyanitasi).
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.responseType = "text";

    const onAbortSignal = (): void => xhr.abort();
    signal?.addEventListener("abort", onAbortSignal, { once: true });
    const cleanup = (): void => signal?.removeEventListener("abort", onAbortSignal);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      cleanup();
      let body: unknown = null;
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
      } catch {
        // Bukan JSON (mis. halaman error dari proxy) — ditangani di bawah.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (isRecord(body) && isRecord(body.document)) {
          onProgress(1);
          resolve(body.document as DocumentDTO);
        } else {
          reject(
            new ApiClientError({ status: xhr.status, code: "internal", message: "Respons server tidak valid." }),
          );
        }
        return;
      }
      reject(errorFromBody(xhr.status, body, xhr.getResponseHeader("retry-after")));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiClientError({ status: 0, code: "network", message: NETWORK_MESSAGE }));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new ApiClientError({ status: 0, code: "aborted", message: "Upload dibatalkan." }));
    };

    xhr.send(file);
  });
}

// --- Chat (streaming) ---------------------------------------------------------------

const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<ChatStreamEvent["type"]>([
  "meta",
  "sources",
  "text",
  "tool_call",
  "tool_result",
  "usage",
  "error",
  "done",
]);

/** Cek minimal: objek dengan `type` yang dikenal. Event tak dikenal diabaikan (forward-compatible). */
function parseStreamEvent(data: string): ChatStreamEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (isRecord(value) && typeof value.type === "string" && STREAM_EVENT_TYPES.has(value.type)) {
      return value as ChatStreamEvent;
    }
  } catch {
    // Data rusak (mis. stream terpotong) — lewati event ini.
  }
  return null;
}

/**
 * Kirim pertanyaan dan hasilkan event SSE satu per satu.
 *
 * Error SEBELUM streaming dimulai (401, 429 rate limit, daily limit, provider
 * tanpa API key, dst.) dikirim server sebagai JSON biasa → dilempar sebagai
 * ApiClientError. Error SETELAH streaming dimulai datang sebagai event `error`.
 */
export async function* streamChat(
  body: ChatRequestBody,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiClientError({ status: 0, code: "aborted", message: "Dibatalkan." });
    }
    throw new ApiClientError({ status: 0, code: "network", message: NETWORK_MESSAGE });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    throw await errorFromResponse(response);
  }
  if (!response.body) {
    throw new ApiClientError({ status: response.status, code: "internal", message: "Respons server kosong." });
  }

  const queue: ChatStreamEvent[] = [];
  const parser = createSseParser((data) => {
    const event = parseStreamEvent(data);
    if (event) queue.push(event);
  });
  const reader = response.body.getReader();
  // stream: true → karakter multi-byte (mis. emoji) yang terbelah di batas chunk tetap utuh.
  const decoder = new TextDecoder();

  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw new ApiClientError({ status: 0, code: "aborted", message: "Dibatalkan." });
        }
        throw new ApiClientError({ status: 0, code: "network", message: "Koneksi terputus saat menerima jawaban." });
      }
      if (result.done) {
        parser.push(decoder.decode());
        parser.flush();
      } else {
        parser.push(decoder.decode(result.value, { stream: true }));
      }
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
      if (result.done) return;
    }
  } finally {
    // Kalau konsumen berhenti lebih awal (break / unmount), lepaskan koneksi.
    reader.cancel().catch(() => undefined);
  }
}
