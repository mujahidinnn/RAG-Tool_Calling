import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_RATE_LIMIT,
  PASSCODE_GLOBAL_FAILURE_LIMIT,
  PASSCODE_IP_RATE_LIMIT,
  PASSCODE_RATE_LIMIT,
} from "@/lib/config";
import {
  GLOBAL_KEY,
  admitPasscodeAttempt,
  chatRateLimiter,
  createRateLimiter,
  passcodeRateLimiter,
  recordPasscodeFailure,
  type PasscodeLimiters,
} from "@/lib/server/rateLimit";

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

describe("createRateLimiter — peek", () => {
  it("peek tidak mencatat request; hanya check yang menghabiskan slot", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(limiter.peek("g", T0 + i), { allowed: true, remaining: 2, retryAfterSec: 0 });
    }
    assert.equal(limiter.size(), 0, "peek tidak boleh membuat key baru di memori");
    limiter.check("g", T0);
    limiter.check("g", T0 + 1);
    const blocked = limiter.peek("g", T0 + 2);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSec, 60);
    // Setelah window lewat, peek kembali mengizinkan.
    assert.equal(limiter.peek("g", T0 + 60_001).allowed, true);
  });
});

describe("admitPasscodeAttempt — rem brute-force POST /api/auth", () => {
  function freshLimiters(): PasscodeLimiters {
    return {
      perSession: createRateLimiter(PASSCODE_RATE_LIMIT),
      perIp: createRateLimiter(PASSCODE_IP_RATE_LIMIT),
      globalFailures: createRateLimiter(PASSCODE_GLOBAL_FAILURE_LIMIT),
    };
  }

  let sessionCounter = 0;
  /** Sesi baru di setiap percobaan = klien yang membuang cookie. */
  function freshSession(): string {
    sessionCounter += 1;
    return `sesi-${sessionCounter}`;
  }

  /** Urutan yang sama dengan route: admit → cek passcode → catat kalau salah. */
  function attempt(
    limiters: PasscodeLimiters,
    ip: string | null,
    correct: boolean,
    now: number,
  ): "ok" | "wrong" | "blocked" {
    if (admitPasscodeAttempt(limiters, freshSession(), ip, now)) return "blocked";
    if (correct) return "ok";
    recordPasscodeFailure(limiters, ip, now);
    return "wrong";
  }

  /** Simulasi 2 menit: penyerang tiap `attackEveryMs`, user sah (sesi baru) tiap 3 detik. */
  function simulate(opts: {
    attackEveryMs: number;
    attackerIp: (i: number) => string | null;
    userIp: string | null;
  }): { userResults: string[]; attackerWrong: number } {
    const limiters = freshLimiters();
    const events: { at: number; who: "attacker" | "user"; i: number }[] = [];
    for (let at = 0, i = 0; at < 120_000; at += opts.attackEveryMs, i++) events.push({ at, who: "attacker", i });
    for (let at = 1_500, i = 0; at < 120_000; at += 3_000, i++) events.push({ at, who: "user", i });
    events.sort((a, b) => a.at - b.at);

    const userResults: string[] = [];
    let attackerWrong = 0;
    for (const event of events) {
      if (event.who === "user") {
        userResults.push(attempt(limiters, opts.userIp, true, T0 + event.at));
      } else if (attempt(limiters, opts.attackerIp(event.i), false, T0 + event.at) === "wrong") {
        attackerWrong++;
      }
    }
    return { userResults, attackerWrong };
  }

  it("penebak anonim pelan (tanpa cookie, IP tidak dipercaya) tidak mengunci login user sah", () => {
    // 4 tebakan/detik = 240/menit, di bawah plafon global.
    const { userResults, attackerWrong } = simulate({ attackEveryMs: 250, attackerIp: () => null, userIp: null });
    assert.equal(userResults.length, 40);
    assert.ok(userResults.every((result) => result === "ok"), userResults.join(","));
    assert.equal(attackerWrong, 480, "tanpa identitas penebak, hanya plafon global yang membatasi");
  });

  it("IP tepercaya: 1 IP yang membanjiri (±9,6/detik) dihentikan limiter per IP, user dari IP lain tetap masuk", () => {
    const { userResults, attackerWrong } = simulate({
      attackEveryMs: 104,
      attackerIp: () => "203.0.113.66",
      userIp: "198.51.100.7",
    });
    assert.ok(userResults.every((result) => result === "ok"), userResults.join(","));
    // 20 per menit selama 2 menit — jauh dari plafon global.
    assert.equal(attackerWrong, PASSCODE_IP_RATE_LIMIT.max * 2);
  });

  it("plafon global: tebakan masif dari banyak IP tetap ditahan, dengan scope 'global'", () => {
    const limiters = freshLimiters();
    let wrong = 0;
    let lastBlock: ReturnType<typeof admitPasscodeAttempt> = null;
    for (let i = 0; i < 400; i++) {
      const now = T0 + i * 10;
      const ip = `10.0.${Math.floor(i / 250)}.${i % 250}`;
      lastBlock = admitPasscodeAttempt(limiters, freshSession(), ip, now);
      if (lastBlock) continue;
      recordPasscodeFailure(limiters, ip, now);
      wrong++;
    }
    assert.equal(wrong, PASSCODE_GLOBAL_FAILURE_LIMIT.max, "rotasi sesi/IP tidak menambah jatah tebakan");
    assert.equal(lastBlock?.scope, "global");
    assert.equal(limiters.globalFailures.peek(GLOBAL_KEY, T0 + 4_000).allowed, false);
    // Selama plafon penuh, percobaan user sah ditolak TANPA menghabiskan kuota sesi/IP-nya.
    assert.equal(admitPasscodeAttempt(limiters, "sesi-user", "198.51.100.7", T0 + 4_000)?.scope, "global");
    assert.equal(limiters.perSession.peek("sesi-user", T0 + 4_000).remaining, PASSCODE_RATE_LIMIT.max);
    assert.equal(limiters.perIp.peek("ip:198.51.100.7", T0 + 4_000).remaining, PASSCODE_IP_RATE_LIMIT.max);
  });

  it("1 kelas (>20 murid) di belakang 1 IP NAT bisa login semua: login BENAR tidak dihitung per IP", () => {
    const limiters = freshLimiters();
    const natIp = "203.0.113.50";
    const results = Array.from({ length: 40 }, (_, i) => attempt(limiters, natIp, true, T0 + i * 500));
    assert.ok(results.every((result) => result === "ok"), results.join(","));
    // Tebakan SALAH dari IP yang sama tetap direm setelah PASSCODE_IP_RATE_LIMIT.max.
    const wrong = Array.from({ length: PASSCODE_IP_RATE_LIMIT.max + 1 }, (_, i) =>
      attempt(limiters, natIp, false, T0 + 30_000 + i),
    );
    assert.equal(wrong.filter((result) => result === "wrong").length, PASSCODE_IP_RATE_LIMIT.max);
    assert.equal(wrong.at(-1), "blocked");
  });

  it("limiter sesi/IP milik klien sendiri → scope 'client'", () => {
    const limiters = freshLimiters();
    for (let i = 0; i < PASSCODE_RATE_LIMIT.max; i++) {
      assert.equal(admitPasscodeAttempt(limiters, "sesi-x", null, T0 + i), null);
    }
    assert.equal(admitPasscodeAttempt(limiters, "sesi-x", null, T0 + 10)?.scope, "client");
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

  it("plafon global passcode salah sengaja tinggi (bukan rem utama)", () => {
    assert.deepEqual(PASSCODE_GLOBAL_FAILURE_LIMIT, { max: 300, windowMs: 60_000 });
    assert.ok(PASSCODE_GLOBAL_FAILURE_LIMIT.max >= PASSCODE_IP_RATE_LIMIT.max * 10);
  });

  it("passcodeRateLimiter mengikuti PASSCODE_RATE_LIMIT", () => {
    const key = `test-pass-${Math.random()}`;
    for (let i = 0; i < PASSCODE_RATE_LIMIT.max; i++) {
      assert.equal(passcodeRateLimiter.check(key, T0).allowed, true);
    }
    assert.equal(passcodeRateLimiter.check(key, T0).allowed, false);
  });
});
