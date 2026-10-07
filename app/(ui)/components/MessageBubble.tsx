"use client";

import {
  CircleAlert,
  Clock,
  Coins,
  Gauge,
  Layers,
  RotateCcw,
  Search,
  Sparkles,
  SquareStop,
  WifiOff,
} from "lucide-react";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { citationKey, findSource, parseCitations, uniqueCitations, type Citation } from "@/lib/citations";
import { assistantText, isStreaming, type AssistantTurn, type ChatErrorInfo, type UserTurn } from "@/lib/client/chat";
import { formatNumber } from "@/lib/client/format";
import { formatUsd } from "@/lib/llm/pricing";
import type { ProviderInfo, ProviderName, Source } from "@/lib/types";
import { useSecondsUntil } from "../hooks/useNow";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { CitationBadge } from "./CitationBadge";
import type { SourcesView } from "./ChunkPanel";
import { PROVIDER_DOT } from "./ProviderSelect";
import { ToolResultCard } from "./ToolResultCard";
import { Button, cx } from "./ui";

export function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <div className="flex animate-message-in justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-[0.9375rem] leading-7 break-words whitespace-pre-wrap text-zinc-900 sm:max-w-[75%] dark:bg-zinc-800 dark:text-zinc-100">
        <span className="sr-only">Kamu: </span>
        {turn.content}
      </p>
    </div>
  );
}

type AssistantProps = {
  turn: AssistantTurn;
  providers: ProviderInfo[];
  onOpenSources: (view: SourcesView) => void;
  onRetry: (turn: AssistantTurn, provider: ProviderName) => void;
};

type ResolvedCitation = { citation: Citation; number: number; source: Source | undefined };

function AssistantMessageImpl({ turn, providers, onOpenSources, onRetry }: AssistantProps) {
  const streaming = isStreaming(turn);
  const fullText = assistantText(turn);
  const sources = turn.sources;
  const model = turn.model ?? providers.find((p) => p.name === turn.provider)?.model ?? null;

  // Sitasi unik (urut kemunculan) diberi nomor 1..n, lalu dicocokkan dengan
  // chunk hasil retrieval. Nomor yang sama dipakai di badge inline & chip.
  const resolved = useMemo(() => {
    const list: ResolvedCitation[] = uniqueCitations(parseCitations(fullText)).map((citation, index) => ({
      citation,
      number: index + 1,
      source: findSource(citation, sources ?? []),
    }));
    const byKey = new Map(list.map((item) => [citationKey(item.citation), item]));
    const citedNumbers: Record<string, number> = {};
    for (const item of list) {
      if (item.source && citedNumbers[item.source.id] === undefined) citedNumbers[item.source.id] = item.number;
    }
    return { list, byKey, citedNumbers };
  }, [fullText, sources]);

  const openCitation = useCallback(
    (item: ResolvedCitation) => {
      onOpenSources({
        sources: sources ?? [],
        citedNumbers: resolved.citedNumbers,
        focus: item.source
          ? { kind: "source", sourceId: item.source.id }
          : {
              kind: "unverified",
              filename: item.citation.filename,
              chunkIndex: item.citation.chunkIndex,
              number: item.number,
            },
      });
    },
    [onOpenSources, sources, resolved.citedNumbers],
  );

  const renderCitation = useCallback(
    (citation: Citation): ReactNode => {
      const item = resolved.byKey.get(citationKey(citation));
      if (!item) return citation.raw;
      return (
        <CitationBadge
          variant="inline"
          number={item.number}
          filename={item.citation.filename}
          chunkIndex={item.citation.chunkIndex}
          verified={item.source !== undefined}
          onOpen={() => openCitation(item)}
        />
      );
    },
    [resolved.byKey, openCitation],
  );

  const lastPart = turn.parts.at(-1);
  const hasVisibleContent = turn.parts.length > 0;

  return (
    <article className="flex animate-message-in gap-3" aria-label={`Jawaban ${turn.label}`}>
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        <Sparkles className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1 space-y-3">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            <span aria-hidden="true" className={cx("size-1.5 rounded-full", PROVIDER_DOT[turn.provider])} />
            {turn.label}
          </span>
          {model && <span className="font-mono text-[0.6875rem] text-zinc-400 dark:text-zinc-500">{model}</span>}
        </header>

        {turn.rewritten && turn.searchQuery && (
          <p
            className="flex items-start gap-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
            title="Pertanyaan follow-up digabung dengan riwayat chat jadi query mandiri sebelum di-embed"
          >
            <Search aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Dicari sebagai: <span className="text-zinc-700 italic dark:text-zinc-300">“{turn.searchQuery}”</span>
            </span>
          </p>
        )}

        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            <AnswerMarkdown
              key={`text-${index}`}
              text={part.text}
              // Kursor berkedip hanya di part teks TERAKHIR saat masih streaming.
              streaming={streaming && part === lastPart}
              renderCitation={renderCitation}
            />
          ) : (
            <ToolResultCard key={`tool-${part.id}`} name={part.name} result={part.result} />
          ),
        )}

        {streaming && !hasVisibleContent && <PendingStatus sources={sources} />}
        {/* Tool sudah selesai, model sedang menyusun lanjutan jawaban. */}
        {streaming && lastPart?.type === "tool" && lastPart.result !== null && (
          <span className="streaming-cursor" aria-hidden="true" />
        )}

        {turn.status === "error" && turn.error && (
          <ErrorCard turn={turn} error={turn.error} providers={providers} onRetry={onRetry} />
        )}

        {resolved.list.length > 0 && (
          <div>
            <p className="mb-1.5 text-[0.6875rem] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Sumber
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Sumber yang dikutip">
              {resolved.list.map((item) => (
                <li key={citationKey(item.citation)} className="max-w-full">
                  <CitationBadge
                    variant="chip"
                    number={item.number}
                    filename={item.citation.filename}
                    chunkIndex={item.citation.chunkIndex}
                    verified={item.source !== undefined}
                    onOpen={() => openCitation(item)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {!streaming && (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
            {turn.usage && (
              <>
                <span
                  className="inline-flex items-center gap-1 tabular-nums"
                  title="Total token pertanyaan ini: rewrite query, embedding, semua putaran chat & tool"
                >
                  <Gauge aria-hidden="true" className="size-3.5" />
                  {formatNumber(turn.usage.inputTokens)} in · {formatNumber(turn.usage.outputTokens)} out
                  <span className="sr-only">token</span>
                </span>
                <span
                  className="inline-flex items-center gap-1 tabular-nums"
                  title="Estimasi biaya dari map harga di lib/llm/pricing.ts"
                >
                  <Coins aria-hidden="true" className="size-3.5" />≈ {formatUsd(turn.usage.costUsd)}
                </span>
              </>
            )}
            {sources && sources.length > 0 && (
              <button
                type="button"
                onClick={() => onOpenSources({ sources, citedNumbers: resolved.citedNumbers, focus: null })}
                className="inline-flex items-center gap-1 rounded hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              >
                <Layers aria-hidden="true" className="size-3.5" />
                Lihat {sources.length} potongan yang diambil
              </button>
            )}
            {turn.status === "stopped" && (
              <span className="inline-flex items-center gap-1">
                <SquareStop aria-hidden="true" className="size-3.5" />
                Dihentikan
              </span>
            )}
          </footer>
        )}
      </div>
    </article>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);

/** Status sebelum token pertama: tahap pipeline RAG + kursor berkedip (bukan spinner). */
function PendingStatus({ sources }: { sources: Source[] | null }) {
  const text =
    sources === null
      ? "Mencari potongan dokumen yang relevan"
      : sources.length > 0
        ? `Menemukan ${sources.length} potongan relevan · menyusun jawaban`
        : "Tidak ada potongan yang relevan · menyusun jawaban";
  return (
    <p className="text-sm text-zinc-500 dark:text-zinc-400">
      {text}
      <span className="streaming-cursor" aria-hidden="true" />
    </p>
  );
}

function errorTitle(error: ChatErrorInfo, providerLabel: string): string {
  switch (error.code) {
    case "provider_error":
      return `${providerLabel} gagal menjawab`;
    case "rate_limited":
      return "Terlalu banyak pertanyaan";
    case "daily_limit":
      return "Limit harian demo tercapai";
    case "network":
      return "Koneksi bermasalah";
    case "config_error":
      return "Server belum dikonfigurasi lengkap";
    case "unauthorized":
      return "Sesi demo terkunci";
    default:
      return "Gagal mendapatkan jawaban";
  }
}

function ErrorCard({
  turn,
  error,
  providers,
  onRetry,
}: {
  turn: AssistantTurn;
  error: ChatErrorInfo;
  providers: ProviderInfo[];
  onRetry: (turn: AssistantTurn, provider: ProviderName) => void;
}) {
  const secondsLeft = useSecondsUntil(error.retryAt);
  const failedProvider = error.provider ?? turn.provider;
  const providerLabel = providers.find((p) => p.name === failedProvider)?.label ?? turn.label;
  const alternative = providers.find((p) => p.name !== failedProvider);
  // Budget harian habis = retry pasti ditolak sampai besok → tanpa tombol.
  const canRetry = error.code !== "daily_limit" && error.code !== "unauthorized";
  const isLimit = error.code === "daily_limit" || error.code === "rate_limited";
  const Icon = error.code === "network" ? WifiOff : isLimit ? Clock : CircleAlert;

  return (
    <div
      role="alert"
      className={cx(
        "rounded-xl border p-3.5",
        isLimit
          ? "border-amber-200 bg-amber-50/70 dark:border-amber-400/20 dark:bg-amber-400/5"
          : "border-red-200 bg-red-50/70 dark:border-red-500/20 dark:bg-red-500/5",
      )}
    >
      <div className="flex gap-3">
        <Icon
          aria-hidden="true"
          className={cx(
            "mt-0.5 size-4.5 shrink-0",
            isLimit ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cx(
              "text-sm font-medium",
              isLimit ? "text-amber-900 dark:text-amber-200" : "text-red-900 dark:text-red-200",
            )}
          >
            {errorTitle(error, providerLabel)}
          </p>
          <p
            className={cx(
              "mt-0.5 text-sm leading-6 break-words",
              isLimit ? "text-amber-800/90 dark:text-amber-200/80" : "text-red-800/90 dark:text-red-200/80",
            )}
          >
            {error.message}
          </p>
          {canRetry && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => onRetry(turn, failedProvider)} disabled={secondsLeft > 0}>
                <RotateCcw aria-hidden="true" />
                {secondsLeft > 0 ? `Coba lagi (${secondsLeft} dtk)` : "Coba lagi"}
              </Button>
              {/* Ganti provider = keputusan EKSPLISIT user, bukan fallback diam-diam. */}
              {error.code === "provider_error" && alternative && (
                <Button size="sm" variant="ghost" onClick={() => onRetry(turn, alternative.name)}>
                  Tanya pakai {alternative.label}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
