// Token cookie auth terikat ke session id (lib/server/auth-token.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authToken } from "@/lib/server/auth-token";

const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";

describe("authToken", () => {
  it("deterministik untuk passcode + sesi yang sama", () => {
    assert.equal(authToken("rahasia-panjang", SID_A), authToken("rahasia-panjang", SID_A));
    assert.match(authToken("rahasia-panjang", SID_A), /^[0-9a-f]{64}$/);
  });

  it("beda sesi → token beda (cookie auth tidak bisa dipakai dengan session id baru)", () => {
    assert.notEqual(authToken("rahasia-panjang", SID_A), authToken("rahasia-panjang", SID_B));
  });

  it("ganti passcode → token lama tidak berlaku", () => {
    assert.notEqual(authToken("rahasia-panjang", SID_A), authToken("rahasia-lain", SID_A));
  });

  it("token tidak memuat passcode-nya", () => {
    assert.ok(!authToken("rahasia-panjang", SID_A).includes("rahasia"));
  });
});
