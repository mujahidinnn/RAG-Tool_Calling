import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freeUploadSlots } from "@/app/(ui)/hooks/useDocuments";
import { MAX_FILES_PER_SESSION } from "@/lib/config";

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `doc-${i}` }));

describe("freeUploadSlots", () => {
  it("menghitung dokumen + upload yang sedang berjalan sebagai slot terpakai", () => {
    assert.deepEqual(freeUploadSlots(null, new Set(), 0), { free: MAX_FILES_PER_SESSION, freeing: [] });
    assert.deepEqual(freeUploadSlots(docs(3), new Set(), 1), { free: MAX_FILES_PER_SESSION - 4, freeing: [] });
    assert.equal(freeUploadSlots(docs(MAX_FILES_PER_SESSION), new Set(), 0).free, 0);
  });

  it("'Hapus & upload ulang' di sesi penuh: dokumen yang sedang dihapus dihitung kosong", () => {
    // Regresi: file pengganti dipilih saat DELETE masih berjalan → dulu ditolak "Maksimal 5 file".
    const full = docs(MAX_FILES_PER_SESSION);
    const slots = freeUploadSlots(full, new Map([["doc-4", Promise.resolve()]]), 0);
    assert.deepEqual(slots, { free: 1, freeing: ["doc-4"] });
  });

  it("id yang sudah tidak ada di daftar tidak dihitung dua kali", () => {
    // Entri DELETE yang berhasil tetap di map; setelah dokumennya hilang dari daftar, tidak ada slot ekstra.
    const slots = freeUploadSlots(docs(4), new Set(["doc-lama"]), 0);
    assert.deepEqual(slots, { free: MAX_FILES_PER_SESSION - 4, freeing: [] });
  });
});
