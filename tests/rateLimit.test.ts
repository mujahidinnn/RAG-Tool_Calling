import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_RATE_LIMIT, PASSCODE_RATE_LIMIT } from "@/lib/config";
import { chatRateLimiter, createRateLimiter, passcodeRateLimiter } from "@/lib/server/rateLimit";

// Semua test memakai `now` eksplisit supaya deterministik (tanpa sleep).
const T0 = 1_000_000;

describe("createRateLimiter", () => {
  it("mengizinkan tepat `max` request per window, request berikutnya ditolak", () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
    assert.deepEqual(limiter.check("a", T0), { allowed: true, remaining: 2, retryAfterSec: 0 });
    assert.deepEqual(limiter.check("a", T0 + 1), { allowed: true, remaining: 1, retryAfterSec: 0 });
    assert.deepEqual(limiter.check("a", T0 + 2), { allowed: true, remaining: 0, retryAfterSec: 0 });

    const blocked = limiter.check("a", T0 + 3);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  });

  it("retryAfterSec = waktu sampai request TERTUA keluar dari window (dibulatkan ke atas)", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    limiter.check("a", T0);
    limiter.check("a", T0 + 10_000);
    // Slot pertama kosong di T0 + 60s → dari T0 + 15.5s tersisa 44.5s → 45.
    assert.equal(limiter.check("a", T0 + 15_500).retryAfterSec, 45);
    // Sesaat sebelum slot kosong tetap minimal 1 detik (bukan 0).
    assert.equal(limiter.check("a", T0 + 59_999).retryAfterSec, 1);
  });

  it("sliding window: tiap request kedaluwarsa sendiri-sendiri (bukan reset per menit)", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    limiter.check("a", T0);
    limiter.check("a", T0 + 30_000);
    assert.equal(limiter.check("a", T0 + 59_999).allowed, false);
    // Request di T0 keluar window tepat di T0 + 60s → 1 slot terbuka...
    assert.equal(limiter.check("a", T0 + 60_000).allowed, true);
    // ...tapi request T0+30s masih di dalam window → slot kedua belum.
    assert.equal(limiter.check("a", T0 + 60_001).allowed, false);
    assert.equal(limiter.check("a", T0 + 90_000).allowed, true);
  });

  it("request yang ditolak tidak ikut dihitung (tidak memperpanjang hukuman)", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000 });
    assert.equal(limiter.check("a", T0).allowed, true);
    for (let i = 1; i <= 50; i++) {
      assert.equal(limiter.check("a", T0 + i * 10).allowed, false);
    }
    // Kalau penolakan ikut dicatat, key ini masih terkunci di sini.
    assert.equal(limiter.check("a", T0 + 1_000).allowed, true);
  });

  it("key berbeda punya kuota sendiri-sendiri", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    assert.equal(limiter.check("sesi-A", T0).allowed, true);
    assert.equal(limiter.check("sesi-A", T0).allowed, false);
    assert.equal(limiter.check("sesi-B", T0).allowed, true);
  });

  it("membuang key yang sudah tidak aktif supaya memori tidak tumbuh terus", () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 1_000 });
    for (let i = 0; i < 100; i++) limiter.check(`sesi-${i}`, T0);
    assert.equal(limiter.size(), 100);
    // Setelah 1 window lewat, check berikutnya men-sweep key yang kedaluwarsa.
    limiter.check("baru", T0 + 1_000);
    assert.equal(limiter.size(), 1);
  });

  it("jumlah key dibatasi maxKeys (key paling lama tidak aktif dibuang duluan)", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 3 });
    limiter.check("k1", T0);
    limiter.check("k2", T0 + 1);
    limiter.check("k3", T0 + 2);
    limiter.check("k4", T0 + 3); // k1 dibuang
    assert.equal(limiter.size(), 3);
    assert.equal(limiter.check("k1", T0 + 4).allowed, true, "k1 sudah dilupakan");
    assert.equal(limiter.check("k4", T0 + 5).allowed, false, "k4 masih dilacak");
  });

  it("menolak opsi yang tidak masuk akal", () => {
    assert.throws(() => createRateLimiter({ max: 0, windowMs: 1_000 }));
    assert.throws(() => createRateLimiter({ max: 1.5, windowMs: 1_000 }));
    assert.throws(() => createRateLimiter({ max: 1, windowMs: 0 }));
    assert.throws(() => createRateLimiter({ max: 1, windowMs: Number.NaN }));
    assert.throws(() => createRateLimiter({ max: 1, windowMs: 1_000, maxKeys: 0 }));
  });
});

describe("limiter bawaan", () => {
  it("chatRateLimiter: 20 request/menit per sesi, request ke-21 ditolak (spec §2 & §10)", () => {
    assert.deepEqual(CHAT_RATE_LIMIT, { max: 20, windowMs: 60_000 });
    const key = `test-chat-${Math.random()}`;
    for (let i = 1; i <= 20; i++) {
      assert.equal(chatRateLimiter.check(key, T0 + i).allowed, true, `request ke-${i}`);
    }
    const blocked = chatRateLimiter.check(key, T0 + 21);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  });

  it("passcodeRateLimiter mengikuti PASSCODE_RATE_LIMIT", () => {
    const key = `test-pass-${Math.random()}`;
    for (let i = 0; i < PASSCODE_RATE_LIMIT.max; i++) {
      assert.equal(passcodeRateLimiter.check(key, T0).allowed, true);
    }
    assert.equal(passcodeRateLimiter.check(key, T0).allowed, false);
  });
});
