import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { isValidUuid } from "@/lib/server/uuid";

// isValidUuid menjaga nilai cookie sesi & parameter ?id= sebelum masuk query.
describe("isValidUuid", () => {
  it("menerima UUID dari crypto.randomUUID() dan huruf besar", () => {
    const id = randomUUID();
    assert.equal(isValidUuid(id), true);
    assert.equal(isValidUuid(id.toUpperCase()), true);
  });

  it("menolak nilai yang bukan UUID kanonik", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "123e4567-e89b-12d3-a456-42661417400", // kurang 1 karakter
      "123e4567-e89b-12d3-a456-4266141740000", // lebih 1 karakter
      "123e4567e89b12d3a456426614174000", // tanpa tanda hubung
      "{123e4567-e89b-12d3-a456-426614174000}",
      " 123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000\n",
      "g23e4567-e89b-12d3-a456-426614174000", // bukan hex
      "' OR 1=1 --",
    ]) {
      assert.equal(isValidUuid(bad), false, JSON.stringify(bad));
    }
  });
});
