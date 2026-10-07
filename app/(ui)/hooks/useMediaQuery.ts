"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * true kalau media query cocok, ikut berubah saat ukuran layar berubah.
 * Saat render di server dianggap false (layout HP); komponen pemakainya
 * hanya dirender di browser, jadi tidak ada mismatch hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
