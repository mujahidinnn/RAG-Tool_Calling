"use client";

import { ArrowDown, ArrowUp, FileSearch, MessagesSquare, RotateCcw, Square, TriangleAlert, Upload } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isAbortError, isApiClientError, streamChat } from "@/lib/client/api";
import {
  buildHistory,
  chatReducer,
  createAssistantTurn,
  isStreaming,
  type AssistantTurn,
  type ChatErrorInfo,
  type ChatTurn,
} from "@/lib/client/chat";
import { formatNumber } from "@/lib/client/format";
import { MAX_QUESTION_CHARS } from "@/lib/config";
import type { DocumentDTO, ProviderInfo, ProviderName } from "@/lib/types";
import type { SourcesView } from "./ChunkPanel";
import { AssistantMessage, UserMessage } from "./MessageBubble";
import { ProviderSelect } from "./ProviderSelect";
import { Button, IconButton, cx, focusIfKeyboardUser } from "./ui";

type Props = {
  providers: ProviderInfo[];
  defaultProvider: ProviderName;
  documents: DocumentDTO[] | null;
  onUnauthorized: () => void;
  onOpenSources: (view: SourcesView) => void;
  onRequestUpload: () => void;
};

let turnCounter = 0;
function nextTurnId(prefix: "u" | "a"): string {
  turnCounter += 1;
  return `${prefix}-${turnCounter}`;
}

/** Jarak (px) dari bawah yang masih dianggap "sedang di bawah" → auto-scroll aktif. */
const STICK_THRESHOLD_PX = 80;

function toChatError(err: unknown): ChatErrorInfo {
  if (isApiClientError(err)) {
    return {
      code: err.code === "aborted" ? "network" : err.code,
      message: err.message,
      retryable: err.retryable,
      provider: err.provider,
      // Date.now() di sini aman: dipanggil dari event handler, bukan saat render.
      retryAt: err.retryAfterSec ? Date.now() + err.retryAfterSec * 1000 : undefined,
    };
  }
  return { code: "internal", message: "Terjadi kesalahan tak terduga di browser.", retryable: true };
}

export function ChatPanel({ providers, defaultProvider, documents, onUnauthorized, onOpenSources, onRequestUpload }: Props) {
  const [turns, dispatch] = useReducer(chatReducer, [] as ChatTurn[]);
  const [provider, setProvider] = useState<ProviderName>(defaultProvider);
  const [input, setInput] = useState("");
  const [showJump, setShowJump] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  // Salinan `turns` terbaru untuk dibaca di callback. Dengan ini `run`/`retry`
  // tidak berganti identitas tiap token masuk, jadi pesan lama (yang di-memo)
  // tidak ikut dirender ulang selama streaming.
  const turnsRef = useRef<ChatTurn[]>(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const busy = turns.some((turn) => turn.role === "assistant" && isStreaming(turn));
  const readyCount = documents?.filter((doc) => doc.status === "ready").length ?? 0;
  const processingCount = documents?.filter((doc) => doc.status === "processing").length ?? 0;
  const selectedProvider = providers.find((p) => p.name === provider);
  const trimmed = input.trim();
  const canSend = !busy && trimmed.length > 0 && trimmed.length <= MAX_QUESTION_CHARS;

  // Hentikan stream yang masih berjalan kalau panel dilepas (mis. logout).
  useEffect(() => () => abortRef.current?.abort(), []);

  // Auto-scroll ke bawah saat konten bertambah — HANYA kalau user memang
  // sedang di bawah. Kalau user menggulir ke atas untuk membaca, jangan ditarik paksa.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Tinggi textarea mengikuti isi (maks ~8 baris, sisanya scroll).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stickToBottom.current = atBottom;
    setShowJump(!atBottom);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  /**
   * Kirim pertanyaan & konsumsi stream SSE. `retryOf` = jawaban gagal yang
   * diganti (riwayat yang dikirim = semua pesan SEBELUM pertanyaan itu).
   */
  const run = useCallback(
    async (question: string, providerName: ProviderName, retryOf?: AssistantTurn) => {
      const info = providers.find((p) => p.name === providerName);
      const userId = retryOf ? retryOf.replyTo : nextTurnId("u");
      const assistant = createAssistantTurn({
        id: nextTurnId("a"),
        replyTo: userId,
        question,
        provider: providerName,
        label: info?.label ?? providerName,
      });

      const current = turnsRef.current;
      const userIndex = current.findIndex((turn) => turn.id === userId);
      const history = buildHistory(retryOf && userIndex >= 0 ? current.slice(0, userIndex) : current);

      if (retryOf) {
        dispatch({ type: "retry", failedId: retryOf.id, assistant });
      } else {
        dispatch({ type: "ask", user: { id: userId, role: "user", content: question }, assistant });
      }
      stickToBottom.current = true;
      setShowJump(false);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of streamChat({ provider: providerName, question, history }, controller.signal)) {
          dispatch({ type: "event", id: assistant.id, event });
        }
        dispatch({ type: "finish", id: assistant.id, reason: "ended" });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          dispatch({ type: "finish", id: assistant.id, reason: "aborted" });
          return;
        }
        if (isApiClientError(err) && err.code === "unauthorized") onUnauthorized();
        dispatch({ type: "fail", id: assistant.id, error: toChatError(err) });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [providers, onUnauthorized],
  );

  const ask = (question: string) => {
    const text = question.trim();
    if (busy || text.length === 0 || text.length > MAX_QUESTION_CHARS) return;
    setInput("");
    void run(text, provider);
  };

  const retry = useCallback(
    (failed: AssistantTurn, providerName: ProviderName) => {
      const stillBusy = turnsRef.current.some((turn) => turn.role === "assistant" && isStreaming(turn));
      if (stillBusy) return;
      // Kalau user memilih provider lain dari tombol error ("Tanya pakai X"),
      // dropdown ikut berubah supaya pertanyaan berikutnya konsisten dengan
      // pilihan itu. "Coba lagi" (provider sama) tidak menyentuh dropdown.
      if (providerName !== failed.provider) setProvider(providerName);
      void run(failed.question, providerName, failed);
      // Kartu error (berisi tombol yang barusan ditekan) diganti jawaban baru.
      focusIfKeyboardUser(textareaRef.current);
    },
    [run],
  );

  const resetChat = () => {
    dispatch({ type: "reset" });
    // Tombol ini ikut hilang setelah reset → fokus jangan jatuh ke <body>.
    focusIfKeyboardUser(textareaRef.current);
  };

  const stop = () => abortRef.current?.abort();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    ask(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter = kirim, Shift+Enter = baris baru. Abaikan Enter saat IME sedang
    // menyusun karakter (input Jepang/Cina/dll.), kalau tidak pesan terkirim setengah jadi.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      ask(input);
    }
  };

  const latestReady = documents?.find((doc) => doc.status === "ready");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 sm:px-6 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Chat</h2>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            · {readyCount} dokumen siap
            {processingCount > 0 ? `, ${processingCount} diproses` : ""}
          </span>
        </div>
        {turns.length > 0 && (
          <Button variant="ghost" size="sm" onClick={resetChat} disabled={busy}>
            <RotateCcw aria-hidden="true" />
            <span className="hidden sm:inline">Percakapan baru</span>
            <span className="sm:hidden">Baru</span>
          </Button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto scroll-thin">
          {turns.length === 0 ? (
            <EmptyChat
              documents={documents}
              readyCount={readyCount}
              latestReadyName={latestReady?.filename}
              onAsk={ask}
              onRequestUpload={onRequestUpload}
            />
          ) : (
            <div
              role="log"
              aria-live="polite"
              aria-label="Percakapan"
              className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-8"
            >
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <UserMessage key={turn.id} turn={turn} />
                ) : (
                  <AssistantMessage
                    key={turn.id}
                    turn={turn}
                    providers={providers}
                    onOpenSources={onOpenSources}
                    onRetry={retry}
                  />
                ),
              )}
            </div>
          )}
        </div>

        {showJump && (
          <IconButton
            label="Gulir ke pesan terbaru"
            icon={ArrowDown}
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 animate-fade-in rounded-full border border-zinc-200 bg-white shadow-md hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          />
        )}
      </div>

      <div className="shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-5">
        <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl">
          {selectedProvider && !selectedProvider.configured && (
            <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-400/5 dark:text-amber-200">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                API key {selectedProvider.label} belum di-set di server — pertanyaan akan gagal dengan error yang jelas
                (sengaja tidak ada fallback diam-diam ke provider lain).
              </span>
            </p>
          )}
          <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent-400 focus-within:ring-4 focus-within:ring-accent-500/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-accent-400/60">
            <label htmlFor="chat-input" className="sr-only">
              Pertanyaan tentang dokumen
            </label>
            <textarea
              id="chat-input"
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tanya sesuatu tentang dokumenmu…"
              maxLength={MAX_QUESTION_CHARS}
              aria-describedby="chat-input-hint"
              className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[0.9375rem] leading-6 text-zinc-900 placeholder:text-zinc-500 focus-visible:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-400"
            />
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <ProviderSelect providers={providers} value={provider} onChange={setProvider} disabled={busy} />
              <div className="flex shrink-0 items-center gap-2">
                {input.length > MAX_QUESTION_CHARS * 0.8 && (
                  <span className="text-[0.6875rem] text-zinc-500 tabular-nums" aria-live="polite">
                    {formatNumber(input.length)}/{formatNumber(MAX_QUESTION_CHARS)}
                  </span>
                )}
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    aria-label="Hentikan jawaban"
                    title="Hentikan jawaban"
                    className="grid size-9 place-items-center rounded-xl bg-zinc-900 text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    <Square aria-hidden="true" className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!canSend}
                    aria-label="Kirim pertanyaan"
                    title="Kirim (Enter)"
                    className="grid size-9 place-items-center rounded-xl bg-accent-600 text-white shadow-sm transition-colors hover:bg-accent-500 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
                  >
                    <ArrowUp aria-hidden="true" className="size-4.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
          <p id="chat-input-hint" className="mt-2 hidden text-center text-[0.6875rem] text-zinc-500 sm:block dark:text-zinc-400">
            Enter untuk kirim · Shift+Enter untuk baris baru · Jawaban hanya dari dokumenmu — cek sitasinya.
          </p>
        </form>
      </div>
    </div>
  );
}

function EmptyChat({
  documents,
  readyCount,
  latestReadyName,
  onAsk,
  onRequestUpload,
}: {
  documents: DocumentDTO[] | null;
  readyCount: number;
  latestReadyName: string | undefined;
  onAsk: (question: string) => void;
  onRequestUpload: () => void;
}) {
  const hasDocuments = (documents?.length ?? 0) > 0;
  const suggestions = [
    "Dokumen apa saja yang sudah saya upload?",
    latestReadyName ? `Ringkas dokumen ${latestReadyName}` : "Ringkas dokumen yang saya upload",
    "Apa poin-poin terpenting dari dokumen ini?",
  ];

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center px-6 py-12 text-center">
      <div aria-hidden="true" className="relative">
        <span className="grid size-14 place-items-center rounded-2xl border border-zinc-200 bg-white text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {hasDocuments ? <MessagesSquare className="size-6" /> : <FileSearch className="size-6" />}
        </span>
        <span className="absolute -top-1 -right-1 size-3 rounded-full bg-accent-500 ring-4 ring-white dark:ring-zinc-950" />
      </div>

      {documents === null ? (
        <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">Memuat dokumen…</p>
      ) : !hasDocuments ? (
        <>
          <h3 className="mt-5 text-base font-semibold tracking-tight">Upload dokumen untuk mulai bertanya</h3>
          <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            Jawaban diambil dari isi dokumenmu (RAG), bukan dari pengetahuan umum model — lengkap dengan sitasi ke
            potongan aslinya.
          </p>
          <Button variant="primary" className="mt-6" onClick={onRequestUpload}>
            <Upload aria-hidden="true" />
            Upload dokumen
          </Button>
        </>
      ) : (
        <>
          <h3 className="mt-5 text-base font-semibold tracking-tight">Tanya apa saja tentang dokumenmu</h3>
          <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {readyCount > 0
              ? "Pilih pertanyaan contoh di bawah, atau ketik sendiri. Klik nomor sitasi untuk melihat potongan aslinya."
              : "Dokumen sedang diproses — sebentar lagi siap ditanya."}
          </p>
          <ul className="mt-6 flex w-full flex-col gap-2" aria-label="Contoh pertanyaan">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => onAsk(suggestion)}
                  disabled={readyCount === 0}
                  className={cx(
                    "w-full truncate rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm text-zinc-700 shadow-xs transition-colors",
                    "hover:border-accent-300 hover:bg-accent-50/50 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50",
                    "dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-accent-400/40 dark:hover:bg-accent-400/5 dark:hover:text-zinc-100",
                  )}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
