"use client";

import { TriangleAlert } from "lucide-react";
import { cx } from "./ui";

type Props = {
  /** Nomor urut sitasi unik di pesan ini (1, 2, 3, ...). */
  number: number;
  filename: string;
  chunkIndex: number;
  /** false = chunk yang disebut model TIDAK ada di hasil retrieval jawaban ini. */
  verified: boolean;
  /** "inline" = angka kecil di dalam kalimat; "chip" = chip di bawah pesan. */
  variant: "inline" | "chip";
  onOpen: () => void;
};

/**
 * Sitasi `[nama_file, chunk #n]` yang bisa diklik untuk membuka potongan
 * dokumen aslinya di panel samping (spec §3.7 & §6).
 *
 * Sitasi yang tidak cocok dengan chunk mana pun yang diambil saat retrieval
 * ditandai garis putus-putus "tidak terverifikasi": model mungkin salah
 * menyebut sumber (halusinasi sitasi) — user perlu tahu, bukan disembunyikan.
 */
export function CitationBadge({ number, filename, chunkIndex, verified, variant, onOpen }: Props) {
  const label = `Sumber ${number}: ${filename}, chunk #${chunkIndex}${verified ? "" : " (tidak terverifikasi)"}`;

  if (variant === "inline") {
    return (
      <button
        type="button"
        data-citation=""
        onClick={onOpen}
        aria-label={label}
        title={label}
        className={cx(
          "mx-0.5 inline-flex h-[1.125rem] min-w-[1.125rem] -translate-y-px items-center justify-center rounded-[0.3rem] px-1 align-middle text-[0.6875rem] leading-none font-semibold tabular-nums transition-colors",
          verified
            ? "bg-accent-50 text-accent-700 ring-1 ring-accent-200 ring-inset hover:bg-accent-100 dark:bg-accent-400/10 dark:text-accent-300 dark:ring-accent-400/25 dark:hover:bg-accent-400/20"
            : "border border-dashed border-zinc-400 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-500 dark:text-zinc-400 dark:hover:bg-zinc-800",
        )}
      >
        {number}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={verified ? `${filename}, chunk #${chunkIndex}` : "Tidak terverifikasi: chunk ini tidak ada di hasil pencarian untuk jawaban ini"}
      className={cx(
        "group inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition-colors",
        verified
          ? "border-zinc-200 bg-white text-zinc-700 hover:border-accent-300 hover:bg-accent-50/60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-accent-400/40 dark:hover:bg-accent-400/10"
          : "border-dashed border-zinc-300 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold tabular-nums",
          verified
            ? "bg-accent-50 text-accent-700 dark:bg-accent-400/15 dark:text-accent-300"
            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
        )}
      >
        {number}
      </span>
      <span className="min-w-0 truncate">{filename}</span>
      <span className="shrink-0 font-mono text-[0.6875rem] text-zinc-500 dark:text-zinc-400">#{chunkIndex}</span>
      {!verified && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] text-amber-700 dark:text-amber-400">
          <TriangleAlert aria-hidden="true" className="size-3" />
          <span className="hidden sm:inline">tidak terverifikasi</span>
        </span>
      )}
    </button>
  );
}
