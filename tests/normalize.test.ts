import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MIN_EXTRACTED_CHARS } from "@/lib/config";
import { hasEnoughReadableText, normalizeExtractedText } from "@/lib/rag/normalize";

describe("normalizeExtractedText", () => {
  test("CRLF, spasi di akhir baris, baris kosong berlebih, trim", () => {
    const raw = "  Judul\r\n\r\n\r\n\r\nParagraf satu   \r\nlanjut\t\n\n\n\nAkhir\f  ";
    assert.equal(normalizeExtractedText(raw), "Judul\n\nParagraf satu\nlanjut\n\nAkhir");
  });

  test("karakter kontrol (termasuk NUL yang ditolak Postgres) dibuang, tab dipertahankan", () => {
    assert.equal(normalizeExtractedText("a\u0000b\u0007c\u001b[0md\te"), "abc[0md\te");
  });

  test("surrogate yatim diganti, bukan dibiarkan merusak JSON", () => {
    const result = normalizeExtractedText("rusak \ud800 di sini");
    assert.equal(result, "rusak � di sini");
    assert.ok(result.isWellFormed());
  });

  test("PDF: ligatur dipecah (NFKC); file teks: hanya NFC", () => {
    assert.equal(normalizeExtractedText("ﬁle ﬂow", { pdf: true }), "file flow");
    assert.equal(normalizeExtractedText("ﬁle m²"), "ﬁle m²");
    assert.equal(normalizeExtractedText("é"), "é"); // NFC menggabungkan aksen
  });
});

describe("hasEnoughReadableText", () => {
  test("kosong / simbol / karakter rusak saja → tidak cukup (PDF hasil scan)", () => {
    assert.equal(hasEnoughReadableText("", MIN_EXTRACTED_CHARS), false);
    assert.equal(hasEnoughReadableText("- 1 -\n- 2 -\n- 3 -", MIN_EXTRACTED_CHARS), false);
    assert.equal(hasEnoughReadableText("�".repeat(500) + " . , ; ".repeat(50), MIN_EXTRACTED_CHARS), false);
  });

  test("huruf (termasuk non-Latin) & angka dihitung", () => {
    assert.equal(hasEnoughReadableText("Halo dunia, ini teks yang terbaca.", MIN_EXTRACTED_CHARS), true);
    assert.equal(hasEnoughReadableText("漢字テキスト漢字テキスト漢字テキスト漢字テキスト", MIN_EXTRACTED_CHARS), true);
    assert.equal(hasEnoughReadableText("a".repeat(19), 20), false);
    assert.equal(hasEnoughReadableText("a".repeat(20), 20), true);
  });
});
