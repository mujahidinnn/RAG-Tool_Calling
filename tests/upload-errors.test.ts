import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toUploadError } from "@/app/(ui)/hooks/useDocuments";
import { ApiClientError } from "@/lib/client/api";

describe("toUploadError", () => {
  it("error yang pasti terulang (termasuk budget harian habis) tanpa tombol retry", () => {
    for (const [status, code] of [
      [413, "file_too_large"],
      [400, "unsupported_type"],
      [400, "empty_file"],
      [429, "daily_limit"],
    ] as const) {
      const err = new ApiClientError({ status, code, message: "x" });
      assert.equal(toUploadError(err).retryable, false, code);
    }
  });

  it("gangguan sementara tetap bisa di-retry", () => {
    assert.equal(toUploadError(new ApiClientError({ status: 500, code: "internal", message: "x" })).retryable, true);
    assert.equal(toUploadError(new ApiClientError({ status: 0, code: "network", message: "x" })).retryable, true);
    assert.equal(toUploadError(new Error("boom")).retryable, true);
  });
});
