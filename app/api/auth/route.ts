// /api/auth — gerbang passcode demo (spec §2).
//   GET    → status: sudah login? provider apa saja yang tersedia? batas upload?
//   POST   → { passcode } → set cookie auth kalau benar
//   DELETE → logout (hapus cookie auth)
// Satu-satunya API route yang TIDAK memanggil requireSession().

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
import { passcodeIpRateLimiter, passcodeRateLimiter } from "@/lib/server/rateLimit";
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

export async function GET(): Promise<Response> {
  try {
    // Pastikan cookie sesi ada sejak awal (kalau proxy belum sempat membuatnya).
    await getOrCreateSessionId();
    return Response.json(buildStatus(await isAuthenticated()), { headers: NO_STORE });
  } catch (err) {
    return errorFromUnknown(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = await getOrCreateSessionId();

    // Rate limit DULUAN (sebelum parse & cek passcode) supaya setiap percobaan
    // terhitung. Per sesi (kontrak) + per IP (karena sesi bisa dibuang).
    const ip = getClientIp(request.headers);
    const checks = [passcodeRateLimiter.check(sessionId)];
    if (ip !== null) checks.push(passcodeIpRateLimiter.check(`ip:${ip}`));
    const blocked = checks.find((result) => !result.allowed);
    if (blocked) {
      return jsonError(
        429,
        "too_many_attempts",
        `Terlalu banyak percobaan passcode. Coba lagi dalam ${blocked.retryAfterSec} detik.`,
        { retryable: true, retryAfterSec: blocked.retryAfterSec },
      );
    }

    // Body passcode itu kecil; batasi 4 KB supaya tidak bisa dipakai membanjiri memori.
    const body = await readJsonBody(request, 4 * 1024);
    if (!body.ok) return body.response;
    const parsed = passcodeBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Passcode wajib diisi (maks 200 karakter).");
    }

    if (!verifyPasscode(parsed.data.passcode)) {
      return jsonError(401, "invalid_passcode", "Passcode salah.");
    }

    await setAuthCookie();
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
