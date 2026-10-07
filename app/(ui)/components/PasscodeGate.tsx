"use client";

import { Eye, EyeOff, KeyRound, LockKeyhole, Quote, Sparkles, Wrench } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { isApiClientError, submitPasscode } from "@/lib/client/api";
import type { AuthStatusResponse } from "@/lib/types";
import { useSecondsUntil } from "../hooks/useNow";
import { BrandMark, Button, Spinner, cx } from "./ui";

type Props = {
  onUnlocked: (status: AuthStatusResponse) => void;
  /** Pesan saat sesi terkunci di tengah jalan (mis. cookie auth kedaluwarsa). */
  notice?: string;
};

/**
 * Gerbang passcode demo (spec §2). Ini BUKAN autentikasi penuh — hanya rem
 * supaya API key pribadi di balik demo publik tidak dipakai sembarang orang.
 * Pengecekan sebenarnya di server (/api/auth, timing-safe + rate limit);
 * halaman ini hanya formulirnya.
 */
export function PasscodeGate({ onUnlocked, notice }: Props) {
  const [passcode, setPasscode] = useState("");
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; retryAt?: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const secondsLeft = useSecondsUntil(error?.retryAt);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || passcode.length === 0 || secondsLeft > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const status = await submitPasscode(passcode);
      onUnlocked(status);
    } catch (err) {
      if (isApiClientError(err)) {
        setError({
          message: err.message,
          retryAt: err.retryAfterSec ? Date.now() + err.retryAfterSec * 1000 : undefined,
        });
        if (err.code === "invalid_passcode") setPasscode("");
      } else {
        setError({ message: "Terjadi kesalahan. Coba lagi." });
      }
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      {/* Cahaya aksen halus di atas — dekoratif. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(60%_70%_at_50%_0%,color-mix(in_oklab,var(--color-accent-500)_16%,transparent),transparent)]"
      />
      <div className="relative w-full max-w-sm animate-message-in">
        <div className="flex flex-col items-center text-center">
          <BrandMark size="lg" />
          <h1 className="mt-5 text-xl font-semibold tracking-tight">AI Docs Assistant</h1>
          <p className="mt-2 max-w-xs text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            Tanya jawab isi dokumen dengan RAG — jawaban streaming, bersitasi, dari Claude atau GPT.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="mt-8 rounded-2xl border border-zinc-200 bg-white/80 p-5 shadow-sm backdrop-blur sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/80"
        >
          <div className="flex items-center gap-2">
            <LockKeyhole aria-hidden="true" className="size-4 text-zinc-500" />
            <h2 className="text-sm font-semibold">Masukkan passcode demo</h2>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {notice ??
              "Demo publik ini memakai API key pribadi, jadi aksesnya dibatasi. Minta passcode ke pemilik demo."}
          </p>

          <label htmlFor={inputId} className="sr-only">
            Passcode
          </label>
          <div className="relative mt-4">
            <input
              ref={inputRef}
              id={inputId}
              type={visible ? "text" : "password"}
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoComplete="current-password"
              autoFocus
              placeholder="Passcode"
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              className={cx(
                "h-11 w-full rounded-xl border bg-white pr-11 pl-3.5 text-sm text-zinc-900 shadow-xs transition-[border-color,box-shadow] placeholder:text-zinc-400 focus-visible:outline-none dark:bg-zinc-950 dark:text-zinc-100",
                error
                  ? "border-red-300 focus:ring-4 focus:ring-red-500/10 dark:border-red-500/50"
                  : "border-zinc-300 focus:border-accent-400 focus:ring-4 focus:ring-accent-500/10 dark:border-zinc-700",
              )}
            />
            <button
              type="button"
              onClick={() => setVisible((value) => !value)}
              aria-label={visible ? "Sembunyikan passcode" : "Tampilkan passcode"}
              aria-pressed={visible}
              title={visible ? "Sembunyikan passcode" : "Tampilkan passcode"}
              className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              {visible ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>

          {error && (
            <p id={errorId} role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
              {error.message}
              {secondsLeft > 0 ? ` (${secondsLeft} dtk)` : ""}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="mt-4 w-full"
            disabled={submitting || passcode.length === 0 || secondsLeft > 0}
          >
            {submitting ? <Spinner /> : <KeyRound aria-hidden="true" />}
            {submitting ? "Memeriksa…" : "Masuk"}
          </Button>
        </form>

        <ul className="mt-6 grid grid-cols-3 gap-2 text-[0.6875rem] text-zinc-500 dark:text-zinc-400" aria-label="Fitur">
          {[
            { icon: Quote, label: "Sitasi sumber" },
            { icon: Wrench, label: "Tool calling" },
            { icon: Sparkles, label: "Claude & GPT" },
          ].map(({ icon: Icon, label }) => (
            <li
              key={label}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-zinc-200/80 px-2 py-3 dark:border-zinc-800"
            >
              <Icon aria-hidden="true" className="size-4 text-zinc-400" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
