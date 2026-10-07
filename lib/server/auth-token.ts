// Token cookie auth. PURE (tanpa next / env) supaya bisa diuji
// (tests/auth-token.test.ts); lib/server/session.ts yang memakainya.

import { createHmac } from "node:crypto";

// v2: token terikat ke session id. Cookie v1 (tanpa sid) otomatis tidak berlaku.
const AUTH_TOKEN_CONTEXT = "ai-docs-assistant:auth:v2";

/**
 * Token yang disimpan di AUTH_COOKIE: HMAC dari passcode, bukan passcode-nya
 * (cookie bocor ≠ passcode bocor). Ganti DEMO_PASSCODE = semua cookie lama
 * otomatis tidak berlaku.
 *
 * Kenapa session id ikut di-HMAC: kalau token sama untuk semua orang, klien
 * bisa menyimpan cookie auth lalu membuang cookie sesi di tiap request →
 * setiap request = sesi baru = kuota rate limit & batas 5 file yang baru.
 * Dengan token per sesi, sesi baru WAJIB lewat POST /api/auth lagi (yang
 * di-rate-limit).
 */
export function authToken(passcode: string, sessionId: string): string {
  return createHmac("sha256", passcode).update(`${AUTH_TOKEN_CONTEXT}:${sessionId}`).digest("hex");
}
