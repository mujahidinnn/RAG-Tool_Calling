// Parser Server-Sent Events (SSE) minimal untuk respons POST /api/chat.
//
// Kenapa tidak pakai `EventSource` bawaan browser? EventSource hanya bisa
// GET tanpa body, sedangkan /api/chat butuh POST + JSON (pertanyaan, riwayat,
// provider). Jadi kita baca stream `fetch` sendiri dan mem-parse format SSE.
//
// File ini PURE (tanpa DOM/React) supaya bisa di-unit-test (tests/sse.test.ts).
//
// Hal yang sering kelewat saat parsing stream:
// - Satu chunk jaringan bisa berisi setengah event, atau beberapa event sekaligus.
// - Akhir baris bisa "\n", "\r\n", atau "\r" — dan "\r\n" bisa terbelah di batas chunk.
// - Baris diawali ":" adalah komentar (sering dipakai sebagai keep-alive).
// - Satu event boleh punya beberapa baris `data:` → digabung dengan "\n".

export type SseParser = {
  /** Masukkan potongan teks berikutnya (sudah di-decode dari byte). */
  push(chunk: string): void;
  /** Panggil saat stream selesai untuk memproses sisa buffer. */
  flush(): void;
};

export function createSseParser(onEvent: (data: string) => void): SseParser {
  let buffer = "";
  let dataLines: string[] = [];
  let isFirstChunk = true;

  function dispatch(): void {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    onEvent(data);
  }

  function processLine(line: string): void {
    // Baris kosong = akhir 1 event.
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return; // komentar / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Spesifikasi SSE: buang SATU spasi setelah titik dua (bukan semua spasi).
    if (value.startsWith(" ")) value = value.slice(1);

    // Field lain (event, id, retry) tidak dipakai protokol kita — abaikan.
    if (field === "data") dataLines.push(value);
  }

  return {
    push(chunk: string): void {
      if (isFirstChunk) {
        isFirstChunk = false;
        // BOM di awal stream harus diabaikan (spesifikasi SSE).
        if (chunk.startsWith("﻿")) chunk = chunk.slice(1);
      }
      buffer += chunk;

      let lineStart = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === "\n") {
          processLine(buffer.slice(lineStart, i));
          lineStart = i + 1;
        } else if (ch === "\r") {
          // "\r" di ujung buffer: belum tahu apakah "\r\n" yang terbelah.
          // Tunggu chunk berikutnya supaya tidak terhitung 2 baris kosong.
          if (i === buffer.length - 1) break;
          processLine(buffer.slice(lineStart, i));
          if (buffer[i + 1] === "\n") i++;
          lineStart = i + 1;
        }
      }
      buffer = buffer.slice(lineStart);
    },

    flush(): void {
      if (buffer.length > 0) {
        const rest = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        // Sisa buffer bisa berisi beberapa baris (kasus "\r" yang tertahan).
        for (const line of rest.split(/\r\n|\r|\n/)) processLine(line);
      }
      // Sengaja lebih toleran dari spesifikasi (yang membuang event tanpa baris
      // kosong penutup): lebih baik event terakhir (mis. `done`) tetap terbaca
      // kalau proxy memotong "\n\n" terakhir. Data rusak akan gagal di JSON.parse.
      dispatch();
    },
  };
}
