"use client";

import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { ProviderInfo, ProviderName } from "@/lib/types";
import { cx } from "./ui";

type Props = {
  providers: ProviderInfo[];
  value: ProviderName;
  onChange: (value: ProviderName) => void;
  disabled?: boolean;
};

/** Warna titik kecil pembeda provider (bukan aksen utama, hanya penanda). */
export const PROVIDER_DOT: Record<ProviderName, string> = {
  anthropic: "bg-orange-500",
  openai: "bg-emerald-500",
};

/**
 * Dropdown provider PER PERTANYAAN. Provider yang API key-nya belum di-set
 * tetap bisa dipilih (diberi tanda) — sengaja, supaya demo "error jelas,
 * tanpa fallback diam-diam ke provider lain" bisa dicoba langsung dari UI.
 *
 * Pakai <select> native: aksesibel & nyaman di HP tanpa kode tambahan.
 */
export function ProviderSelect({ providers, value, onChange, disabled }: Props) {
  const id = useId();
  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="sr-only">
        Model AI untuk pertanyaan ini
      </label>
      <span
        aria-hidden="true"
        className={cx("pointer-events-none absolute top-1/2 left-2.5 size-2 -translate-y-1/2 rounded-full", PROVIDER_DOT[value])}
      />
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = providers.find((provider) => provider.name === event.target.value);
          if (next) onChange(next.name);
        }}
        className="h-8 max-w-full cursor-pointer appearance-none truncate rounded-lg border border-transparent bg-zinc-100 pr-7 pl-6.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-200/70 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
      >
        {providers.map((provider) => (
          <option key={provider.name} value={provider.name}>
            {provider.label} · {provider.model}
            {provider.configured ? "" : " (API key belum di-set)"}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-zinc-500"
      />
    </div>
  );
}
