import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSseParser } from "@/lib/client/sse";

/** Jalankan parser dengan potongan-potongan input, kembalikan semua data event. */
function parse(chunks: string[], { flush = true } = {}): string[] {
  const events: string[] = [];
  const parser = createSseParser((data) => events.push(data));
  for (const chunk of chunks) parser.push(chunk);
  if (flush) parser.flush();
  return events;
}

describe("createSseParser", () => {
  it("1 event utuh dalam 1 chunk", () => {
    assert.deepEqual(parse(['data: {"type":"done"}\n\n']), ['{"type":"done"}']);
  });

  it("beberapa event dalam 1 chunk, urutan terjaga", () => {
    assert.deepEqual(parse(["data: a\n\ndata: b\n\ndata: c\n\n"]), ["a", "b", "c"]);
  });

  it("event terbelah di sembarang posisi (termasuk di tengah 'data:' dan di antara \\n\\n)", () => {
    const wire = 'data: {"type":"text","delta":"Halo"}\n\ndata: {"type":"done"}\n\n';
    const expected = ['{"type":"text","delta":"Halo"}', '{"type":"done"}'];
    // Coba SEMUA titik potong supaya bug di batas chunk pasti ketahuan.
    for (let cut = 1; cut < wire.length; cut++) {
      assert.deepEqual(parse([wire.slice(0, cut), wire.slice(cut)]), expected, `potong di ${cut}`);
    }
    // Ekstrem: 1 karakter per chunk.
    assert.deepEqual(parse([...wire]), expected);
  });

  it("CRLF, termasuk \\r\\n yang terbelah di batas chunk, tidak dihitung 2 baris", () => {
    assert.deepEqual(parse(["data: a\r\n\r\ndata: b\r\n\r\n"]), ["a", "b"]);
    // "\r" di akhir chunk 1, "\n" di awal chunk 2 → tetap 1 akhir baris.
    assert.deepEqual(parse(["data: a\r", "\ndata: lanjut\r\n\r\n"]), ["a\nlanjut"]);
    // CR saja juga akhir baris yang sah.
    assert.deepEqual(parse(["data: a\r\rdata: b\r\r"]), ["a", "b"]);
  });

  it("mengabaikan baris komentar (keep-alive) dan field selain data", () => {
    const events = parse([": keep-alive\n\nevent: message\nid: 7\nretry: 1000\ndata: x\n\n"]);
    assert.deepEqual(events, ["x"]);
  });

  it("beberapa baris data: digabung dengan newline", () => {
    assert.deepEqual(parse(["data: baris 1\ndata: baris 2\ndata:\n\n"]), ["baris 1\nbaris 2\n"]);
  });

  it("hanya 1 spasi setelah titik dua yang dibuang", () => {
    assert.deepEqual(parse(["data:tanpa spasi\n\n", "data:   tiga spasi\n\n"]), [
      "tanpa spasi",
      "  tiga spasi",
    ]);
  });

  it("baris kosong tanpa data tidak menghasilkan event", () => {
    assert.deepEqual(parse(["\n\n\n: komentar\n\n"]), []);
  });

  it("BOM di awal stream diabaikan", () => {
    assert.deepEqual(parse(["﻿data: a\n\n"]), ["a"]);
  });

  it("tanpa flush, event yang belum ditutup baris kosong belum dikirim", () => {
    assert.deepEqual(parse(["data: a\n\ndata: b\n"], { flush: false }), ["a"]);
  });

  it("flush mengirim event terakhir walau baris kosong penutupnya terpotong", () => {
    assert.deepEqual(parse(["data: a\n\ndata: b"]), ["a", "b"]);
    assert.deepEqual(parse(["data: a\n\ndata: b\r"]), ["a", "b"]);
  });

  it("karakter non-ASCII (emoji, aksara) tetap utuh", () => {
    assert.deepEqual(parse(["data: 📄 Dokumen ", "ditemukan — ok\n\n"]), ["📄 Dokumen ditemukan — ok"]);
  });
});
