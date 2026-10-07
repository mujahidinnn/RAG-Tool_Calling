"use client";

// Kerangka aplikasi di client: cek status passcode → tampilkan gerbang
// passcode ATAU workspace (daftar dokumen + chat).
//
// Kenapa client component? Status auth bergantung pada cookie httpOnly per
// browser, dan semua data lain juga per-sesi. Dengan mengambilnya dari API di
// browser, page.tsx tetap statis (bisa di-prerender), dan cookie sesi sudah
// pasti ada karena proxy.ts memasangnya saat halaman diminta.

import { CircleAlert, Files, LogOut, MessagesSquare, RotateCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getAuthStatus, isApiClientError, logout } from "@/lib/client/api";
import { DOCUMENT_TTL_HOURS } from "@/lib/config";
import type { AuthStatusResponse } from "@/lib/types";
import { useDocuments } from "../hooks/useDocuments";
import { ChatPanel } from "./ChatPanel";
import { ChunkPanel, type SourcesView } from "./ChunkPanel";
import { DocumentList } from "./DocumentList";
import { PasscodeGate } from "./PasscodeGate";
import { BrandMark, Button, Spinner, cx } from "./ui";

type AuthState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "locked"; notice?: string }
  | { kind: "ready"; status: AuthStatusResponse };

const SESSION_LOCKED_NOTICE = "Sesi demo terkunci (passcode kedaluwarsa atau berubah). Masukkan passcode lagi.";

export function AppShell() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (cancelled) return;
        setAuth(status.authenticated ? { kind: "ready", status } : { kind: "locked" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = isApiClientError(err) ? err.message : "Gagal memuat status aplikasi.";
        setAuth({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Stabil (tanpa dependency) supaya hook & callback di bawahnya tidak ikut berganti.
  const handleUnauthorized = useCallback(() => {
    setAuth({ kind: "locked", notice: SESSION_LOCKED_NOTICE });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Gagal hapus cookie di server tetap dikunci di UI; cookie auth juga punya masa berlaku.
    }
    setAuth({ kind: "locked" });
  }, []);

  switch (auth.kind) {
    case "loading":
      return <AppSkeleton />;
    case "error":
      return (
        <FullPageError
          message={auth.message}
          onRetry={() => {
            setAuth({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      );
    case "locked":
      return (
        <PasscodeGate notice={auth.notice} onUnlocked={(status) => setAuth({ kind: "ready", status })} />
      );
    case "ready":
      return <Workspace status={auth.status} onUnauthorized={handleUnauthorized} onLogout={handleLogout} />;
  }
}

type Tab = "documents" | "chat";

function Workspace({
  status,
  onUnauthorized,
  onLogout,
}: {
  status: AuthStatusResponse;
  onUnauthorized: () => void;
  onLogout: () => void;
}) {
  const docs = useDocuments({ onUnauthorized });
  const [tab, setTab] = useState<Tab | null>(null);
  const [sourcesView, setSourcesView] = useState<SourcesView | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab awal di HP ditentukan SEKALI saat daftar dokumen pertama kali tiba:
  // belum ada dokumen → "Dokumen" (CTA upload), sudah ada → "Chat".
  // (Pola resmi React "menyesuaikan state saat render", tanpa effect tambahan.)
  if (tab === null && docs.documents !== null) {
    setTab(docs.documents.length > 0 ? "chat" : "documents");
  }
  const activeTab: Tab = tab ?? "documents";
  const documentCount = docs.documents?.length ?? 0;

  const openSources = useCallback((view: SourcesView) => setSourcesView(view), []);
  const closeSources = useCallback(() => setSourcesView(null), []);

  const requestUpload = useCallback(() => {
    setTab("documents");
    // Harus sinkron di dalam handler klik: browser hanya mengizinkan file
    // picker dibuka sebagai respons langsung atas aksi user.
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 sm:px-6 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark />
          <div className="min-w-0">
            <h1 className="truncate text-[0.9375rem] leading-5 font-semibold tracking-tight">AI Docs Assistant</h1>
            <p className="hidden truncate text-[0.6875rem] text-zinc-500 sm:block dark:text-zinc-400">
              RAG · sitasi sumber · tool calling · Claude &amp; GPT
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-[0.6875rem] text-zinc-500 md:inline-flex dark:border-zinc-800 dark:text-zinc-400">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            Demo publik · dokumen terhapus otomatis {DOCUMENT_TTL_HOURS} jam
          </span>
          <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Kunci demo (keluar)" title="Kunci demo (keluar)">
            <LogOut aria-hidden="true" />
            <span className="hidden sm:inline">Kunci</span>
          </Button>
        </div>
      </header>

      <MobileTabs active={activeTab} onChange={setTab} documentCount={documentCount} />

      <div className="flex min-h-0 flex-1">
        <aside
          id="panel-documents"
          role="tabpanel"
          aria-labelledby="tab-documents"
          className={cx(
            "min-h-0 w-full flex-col bg-zinc-50/70 lg:flex lg:w-[22rem] lg:shrink-0 lg:border-r lg:border-zinc-200 xl:w-96 dark:bg-zinc-900/30 lg:dark:border-zinc-800",
            activeTab === "documents" ? "flex" : "hidden",
          )}
        >
          <DocumentList state={docs} fileInputRef={fileInputRef} />
        </aside>
        <main
          id="panel-chat"
          role="tabpanel"
          aria-labelledby="tab-chat"
          className={cx("min-h-0 min-w-0 flex-1 flex-col lg:flex", activeTab === "chat" ? "flex" : "hidden")}
        >
          <ChatPanel
            providers={status.providers}
            defaultProvider={status.defaultProvider}
            documents={docs.documents}
            onUnauthorized={onUnauthorized}
            onOpenSources={openSources}
            onRequestUpload={requestUpload}
          />
        </main>
      </div>

      <ChunkPanel view={sourcesView} onClose={closeSources} />
    </div>
  );
}

const TABS: { id: Tab; label: string; icon: typeof Files }[] = [
  { id: "documents", label: "Dokumen", icon: Files },
  { id: "chat", label: "Chat", icon: MessagesSquare },
];

/** Tab untuk layar < 1024px (1 kolom). Pola ARIA tabs: panah kiri/kanan berpindah tab. */
function MobileTabs({
  active,
  onChange,
  documentCount,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
  documentCount: number;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = active === "documents" ? "chat" : "documents";
    onChange(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Tampilan"
      onKeyDown={handleKeyDown}
      className="flex shrink-0 gap-1 border-b border-zinc-200 px-2 lg:hidden dark:border-zinc-800"
    >
      {TABS.map(({ id, label, icon: Icon }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={cx(
              "relative flex h-11 flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors",
              selected
                ? "text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
            {id === "documents" && documentCount > 0 && (
              <span className="rounded-full bg-zinc-100 px-1.5 text-[0.6875rem] text-zinc-600 tabular-nums dark:bg-zinc-800 dark:text-zinc-300">
                {documentCount}
              </span>
            )}
            <span
              aria-hidden="true"
              className={cx(
                "absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-accent-500 transition-opacity duration-200",
                selected ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Skeleton saat status awal dimuat — juga yang di-prerender sebagai HTML statis. */
function AppSkeleton() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true">
      <span className="sr-only" role="status">
        Memuat aplikasi…
      </span>
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-zinc-200 px-4 sm:px-6 dark:border-zinc-800">
        <BrandMark />
        <div className="skeleton h-3.5 w-36" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[22rem] shrink-0 space-y-3 border-r border-zinc-200 bg-zinc-50/70 p-5 lg:block xl:w-96 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="skeleton h-14 w-full rounded-xl" />
          <div className="skeleton h-16 w-full rounded-xl" />
          <div className="skeleton h-16 w-full rounded-xl" />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <Spinner className="size-5 text-zinc-400" />
        </div>
      </div>
    </div>
  );
}

function FullPageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div role="alert" className="flex max-w-sm animate-message-in flex-col items-center text-center">
        <span className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
          <CircleAlert aria-hidden="true" className="size-6" />
        </span>
        <h1 className="mt-4 text-base font-semibold">Aplikasi gagal dimuat</h1>
        <p className="mt-1.5 text-sm leading-6 break-words text-zinc-500 dark:text-zinc-400">{message}</p>
        <Button variant="primary" className="mt-5" onClick={onRetry}>
          <RotateCcw aria-hidden="true" />
          Coba lagi
        </Button>
      </div>
    </main>
  );
}
