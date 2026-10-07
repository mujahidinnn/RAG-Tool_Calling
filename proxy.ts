// Proxy Next.js (dulu "middleware"). Tugasnya cuma satu: memastikan browser
// punya cookie sesi SEBELUM halaman memanggil API apa pun.
//
// Kenapa perlu: halaman memanggil beberapa API sekaligus saat dibuka
// (/api/auth, /api/documents). Kalau cookie baru dibuat di API, request
// paralel pertama bisa masing-masing membuat session id BERBEDA — dokumen
// yang diupload bisa "hilang" ke sesi yang tertimpa.
//
// Kenapa matcher HANYA "/" (bukan /api): proxy mem-buffer body request,
// sedangkan /api/upload harus menghitung byte upload secara streaming.
// Route API tetap aman tanpa proxy karena memanggil getOrCreateSessionId()
// sendiri (lib/server/session.ts).

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SEC } from "@/lib/config";
import { cookieOptions } from "@/lib/server/cookieOptions";
import { isValidUuid } from "@/lib/server/uuid";

export function proxy(request: NextRequest): NextResponse {
  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && isValidUuid(existing)) return NextResponse.next();

  const sessionId = crypto.randomUUID();
  // Teruskan juga ke request yang sedang diproses, supaya render halaman ini
  // sudah melihat cookie yang sama dengan yang dikirim ke browser.
  request.cookies.set(SESSION_COOKIE, sessionId);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(SESSION_COOKIE, sessionId, cookieOptions(SESSION_COOKIE_MAX_AGE_SEC));
  return response;
}

export const config = {
  matcher: "/",
};
