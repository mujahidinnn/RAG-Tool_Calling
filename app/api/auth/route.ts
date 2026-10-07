// /api/auth — gerbang passcode demo (spec §2).
//   GET    → status: sudah login? provider apa saja yang tersedia? batas upload?
//   POST   → { passcode } → set cookie auth kalau benar
//   DELETE → logout (hapus cookie auth)
// Satu-satunya API route yang TIDAK memanggil requireSession().

import { after } from "next/server";
import { z } from "zod";
import {
  ALLOWED_EXTENSIONS,
  CHAT_MODELS,
  DOCUMENT_TTL_HOURS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  PROVIDER_LABELS,
} from "@/lib/config";
import { getServerEnv, isProviderConfigured } from "@/lib/env";
import type { ProviderName } from "@/lib/llm/types";
import { errorFromUnknown, getClientIp, jsonError, readJsonBody } from "@/lib/server/http";
import { maybeCleanupExpired } from "@/lib/server/cleanup";
import {
  GLOBAL_KEY,
  passcodeFailureLimiter,
  passcodeIpRateLimiter,
  passcodeRateLimiter,
  type RateLimitResult,
} from "@/lib/server/rateLimit";
import {
  clearAuthCookie,
  getOrCreateSessionId,
  isAuthenticated,
  setAuthCookie,
  verifyPasscode,
} from "@/lib/server/session";
import type { AuthStatusResponse } from "@/lib/types";

const PROVIDER_ORDER: ProviderName[] = ["anthropic", "openai"];

const passcodeBodySchema = z.object({
  passcode: z.string().min(1).max(200),
});

// Status auth bergantung pada cookie → jangan pernah di-cache.
const NO_STORE = { "Cache-Control": "no-store" };

function buildStatus(authenticated: boolean): AuthStatusResponse {
  return {
    authenticated,
    defaultProvider: getServerEnv().defaultProvider,
    providers: PROVIDER_ORDER.map((name) => ({
      name,
      label: PROVIDER_LABELS[name],
      model: CHAT_MODELS[name],
      // Provider tanpa API key tetap ditampilkan (ditandai di UI) supaya demo
      // "error jelas, tanpa fallback diam-diam" bisa dicoba.
      configured: isProviderConfigured(name),
    })),
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxFilesPerSession: MAX_FILES_PER_SESSION,
      allowedExtensions: [...ALLOWED_EXTENSIONS],
      documentTtlHours: DOCUMENT_TTL_HOURS,
    },
  };
}

function tooManyAttempts(blocked: RateLimitResult, message: string): Response {
  return jsonError(429, "too_many_attempts", `${message} Coba lagi dalam ${blocked.retryAfterSec} detik.`, {
    retryable: true,
    retryAfterSec: blocked.retryAfterSec,
  });
}

export async function GET(): Promise<Response> {
  try {
    // Pastikan cookie sesi ada sejak awal (kalau proxy belum sempat membuatnya).
    const sessionId = await getOrCreateSessionId();
    // Endpoint ini dipanggil di SETIAP pembukaan halaman, termasuk pengunjung
    // yang tertahan di gerbang passcode — jadi auto-hapus 24 jam tetap jalan
    // walau tidak ada yang login (sudah di-throttle, tidak pernah throw).
    after(() => maybeCleanupExpired());
    return Response.json(buildStatus(await isAuthenticated(sessionId)), { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = await getOrCreateSessionId();
    after(() => maybeCleanupExpired());

    // Rate limit DULUAN (sebelum parse & cek passcode) supaya setiap percobaan
    // terhitung. 3 lapis, karena key per sesi & per IP bisa diganti-ganti klien:
    // 1. global: terlalu banyak passcode SALAH dari semua klien → semua ditahan
    //    sebentar (cek saja; yang dicatat hanya percobaan yang salah, di bawah).
    const global = passcodeFailureLimiter.peek(GLOBAL_KEY);
    if (!global.allowed) {
      return tooManyAttempts(global, "Terlalu banyak percobaan passcode yang salah di server ini.");
    }
    // 2. per sesi (kontrak) + 3. per IP (hanya kalau IP bisa dipercaya).
    const ip = getClientIp(request.headers);
    const checks = [passcodeRateLimiter.check(sessionId)];
    if (ip !== null) checks.push(passcodeIpRateLimiter.check(`ip:${ip}`));
    const blocked = checks.find((result) => !result.allowed);
    if (blocked) return tooManyAttempts(blocked, "Terlalu banyak percobaan passcode.");

    // Body passcode itu kecil; batasi 4 KB supaya tidak bisa dipakai membanjiri memori.
    const body = await readJsonBody(request, 4 * 1024);
    if (!body.ok) return body.response;
    const parsed = passcodeBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Passcode wajib diisi (maks 200 karakter).");
    }

    if (!verifyPasscode(parsed.data.passcode)) {
      passcodeFailureLimiter.check(GLOBAL_KEY);
      return jsonError(401, "invalid_passcode", "Passcode salah.");
    }

    // Token terikat ke sesi ini: sesi baru harus login lagi (lewat limiter di atas).
    await setAuthCookie(sessionId);
    return Response.json(buildStatus(true), { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    await clearAuthCookie();
    return Response.json({ authenticated: false }, { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}
