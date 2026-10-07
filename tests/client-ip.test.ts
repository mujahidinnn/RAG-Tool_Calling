// Aturan "header IP mana yang boleh dipercaya" (lib/server/client-ip.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clientIpFromHeaders, type ProxyTrust } from "@/lib/server/client-ip";

const SELF_HOST: ProxyTrust = { trustedProxyHops: 0, onVercel: false };
const BEHIND_NGINX: ProxyTrust = { trustedProxyHops: 1, onVercel: false };
const VERCEL: ProxyTrust = { trustedProxyHops: 0, onVercel: true };

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("clientIpFromHeaders", () => {
  it("self-host tanpa proxy tepercaya: X-Forwarded-For dari klien TIDAK dipercaya", () => {
    // Penyerang mengganti XFF tiap request → kalau dipercaya, dapat kuota baru terus.
    for (let i = 1; i <= 3; i++) {
      assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": `198.51.100.${i}` }), SELF_HOST), null);
    }
    assert.equal(clientIpFromHeaders(headers({ "x-real-ip": "198.51.100.9" }), SELF_HOST), null);
  });

  it("di belakang 1 proxy yang menambahkan IP: pakai entri PALING KANAN, bukan paling kiri", () => {
    // nginx: "<XFF dari klien>, <IP yang dilihat nginx>"
    const h = headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 203.0.113.7" });
    assert.equal(clientIpFromHeaders(h, BEHIND_NGINX), "203.0.113.7");
    assert.equal(clientIpFromHeaders(h, { trustedProxyHops: 2, onVercel: false }), "1.2.3.4");
  });

  it("jumlah entri lebih sedikit dari hop yang dikonfigurasi → null (salah konfigurasi, jangan menebak)", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.7" });
    assert.equal(clientIpFromHeaders(h, { trustedProxyHops: 2, onVercel: false }), null);
    assert.equal(clientIpFromHeaders(headers({}), BEHIND_NGINX), null);
  });

  it("Vercel: pakai header yang diisi ulang platform", () => {
    assert.equal(
      clientIpFromHeaders(headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "6.6.6.6" }), VERCEL),
      "203.0.113.7",
    );
    assert.equal(clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.8" }), VERCEL), "203.0.113.8");
    assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.9" }), VERCEL), "203.0.113.9");
  });

  it("nilai yang terlalu panjang untuk sebuah IP tidak dipakai sebagai key", () => {
    const h = headers({ "x-forwarded-for": `a${"x".repeat(100)}` });
    assert.equal(clientIpFromHeaders(h, BEHIND_NGINX), null);
  });
});
