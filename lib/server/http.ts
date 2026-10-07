import "server-only";

// Helper respons HTTP untuk API route: semua error dikirim dengan bentuk JSON
// yang sama (ApiErrorBody) supaya UI cukup punya 1 cara menampilkan error.

import { ConfigError } from "@/lib/env";
import { ProviderError, type ProviderName } from "@/lib/llm/types";
import type { ApiErrorBody, ApiErrorCode } from "@/lib/types";

export type JsonErrorExtra = {
  retryable?: boolean;
  retryAfterSec?: number;
  provider?: ProviderName;
};

/** Respons JSON error standar. `retryAfterSec` juga dikirim sebagai header Retry-After. */
export function jsonError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: JsonErrorExtra = {},
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  if (extra.retryable !== undefined) body.error.retryable = extra.retryable;
  if (extra.provider !== undefined) body.error.provider = extra.provider;

  // Respons error tidak boleh di-cache (mis. 429 tersimpan di CDN untuk orang lain).
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (extra.retryAfterSec !== undefined && extra.retryAfterSec > 0) {
    const seconds = Math.ceil(extra.retryAfterSec);
    body.error.retryAfterSec = seconds;
    headers.set("Retry-After", String(seconds));
  }
  return Response.json(body, { status, headers });
}

// `instanceof` gagal kalau modul yang sama termuat 2x (mis. campuran ESM/CJS
// saat test, atau bundler menduplikasi modul) — cek `name` sebagai cadangan.
function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError || (err instanceof Error && err.name === "ConfigError");
}

function isProviderError(err: unknown): err is ProviderError {
  if (err instanceof ProviderError) return true;
  return (
    err instanceof Error &&
    err.name === "ProviderError" &&
    "provider" in err &&
    "code" in err &&
    "retryable" in err
  );
}

/**
 * Ubah error tak terduga jadi respons. Pesan internal (stack, detail SQL)
 * TIDAK dikirim ke client — cukup dicatat di log server.
 */
export function errorFromUnknown(err: unknown): Response {
  if (isConfigError(err)) {
    // Pesannya hanya berisi NAMA env yang kurang (tanpa nilai) — aman & membantu.
    console.error(`[api] ${err.message}`);
    return jsonError(500, "config_error", err.message);
  }
  if (isProviderError(err)) {
    console.error(`[api] provider ${err.provider} error (${err.code}):`, err.message);
    // missing_key = server belum dikonfigurasi (503), selain itu = upstream gagal (502).
    return jsonError(err.code === "missing_key" ? 503 : 502, "provider_error", err.message, {
      retryable: err.retryable,
      provider: err.provider,
    });
  }
  console.error("[api] unhandled error:", err);
  return jsonError(500, "internal", "Terjadi kesalahan di server. Coba lagi sebentar lagi.", {
    retryable: true,
  });
}

/**
 * Baca body JSON dengan batas ukuran. `request.json()` akan membaca body
 * sebesar apa pun ke memori; header Content-Length tidak bisa dipercaya
 * (bisa dipalsukan / tidak ada), jadi byte dihitung saat dibaca.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const tooLarge = (): { ok: false; response: Response } => ({
    ok: false,
    response: jsonError(413, "bad_request", "Body request terlalu besar."),
  });
  const invalid = (): { ok: false; response: Response } => ({
    ok: false,
    response: jsonError(400, "bad_request", "Body request harus JSON yang valid."),
  });

  if (!request.body) return invalid();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      parts.push(value);
    }
  } catch {
    return invalid();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return invalid();
  }
}

/**
 * IP klien dari header proxy (best effort). Hanya bisa dipercaya kalau app
 * berada di belakang proxy yang MENIMPA header ini (mis. Vercel); kalau
 * self-host tanpa proxy, klien bisa memalsukannya — jadi pakai hanya untuk
 * rem tambahan, bukan satu-satunya kontrol keamanan.
 */
export function getClientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = headers.get("x-real-ip")?.trim();
  return realIp ? realIp : null;
}
