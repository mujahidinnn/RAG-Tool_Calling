import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MIN_EXTRACTED_CHARS } from "@/lib/config";
import {
  countMeaningfulPdfChars,
  hasEnoughReadablePdfText,
  hasEnoughReadableText,
  normalizeExtractedText,
} from "@/lib/rag/normalize";

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

describe("hasEnoughReadablePdfText (PDF hasil scan dengan sedikit teks)", () => {
  const pages = (count: number, perPage: (page: number) => string): string =>
    Array.from({ length: count }, (_, i) => perPage(i + 1)).join("\n");

  test("watermark aplikasi scanner di setiap halaman → tidak terbaca", () => {
    const text = pages(10, () => "Scanned with CamScanner");
    assert.ok(hasEnoughReadableText(text, MIN_EXTRACTED_CHARS), "cek lama meloloskannya");
    assert.equal(countMeaningfulPdfChars(text, 10), 0);
    assert.equal(hasEnoughReadablePdfText(text, 10, MIN_EXTRACTED_CHARS), false);
  });

  test("hanya nomor halaman / stempel angka → tidak terbaca", () => {
    assert.equal(hasEnoughReadablePdfText(pages(30, (n) => String(n)), 30, MIN_EXTRACTED_CHARS), false);
    assert.equal(hasEnoughReadablePdfText(pages(30, (n) => `- ${n} -`), 30, MIN_EXTRACTED_CHARS), false);
  });

  test("1 halaman scan dengan watermark saja → tidak terbaca", () => {
    assert.equal(hasEnoughReadablePdfText("Scanned with CamScanner", 1, MIN_EXTRACTED_CHARS), false);
  });

  test("dokumen biasa dengan header/footer berulang tetap terbaca (isi halaman dihitung)", () => {
    const text = pages(
      12,
      (n) => `Laporan Tahunan 2025\nBab ${n}: kebijakan cuti karyawan dijelaskan di bagian ini secara rinci.\n${n}`,
    );
    assert.equal(hasEnoughReadablePdfText(text, 12, MIN_EXTRACTED_CHARS), true);
  });

  test("slide deck yang jarang teksnya tetap lolos", () => {
    const text = pages(20, (n) => `Slide ${n}: Arsitektur RAG dan embedding`);
    assert.equal(hasEnoughReadablePdfText(text, 20, MIN_EXTRACTED_CHARS), true);
  });
});
