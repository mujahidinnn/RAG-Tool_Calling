"use client";

import { useEffect, useState } from "react";

// Catatan: hook ini memanggil Date.now() di initializer useState. Komponen
// pemakainya hanya dirender SETELAH data dari API tiba (di browser), tidak
// pernah saat prerender di server — jadi tidak ada mismatch hydration.

/** Waktu sekarang (ms) yang diperbarui tiap `intervalMs` — untuk label "5 mnt lalu". */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Sisa detik sampai `targetMs` (epoch ms), diperbarui tiap detik; 0 kalau
 * sudah lewat / tidak ada. Dipakai untuk tombol "Coba lagi (12 dtk)" setelah
 * rate limit, supaya user tidak menekan retry yang pasti ditolak lagi.
 */
export function useSecondsUntil(targetMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (targetMs === undefined) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [targetMs]);
  if (targetMs === undefined) return 0;
  return Math.max(0, Math.ceil((targetMs - now) / 1000));
}
