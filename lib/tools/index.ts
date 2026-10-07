import "server-only";

// Registry tool: SATU-SATUNYA tempat daftar tool didefinisikan (format
// generik). Kedua adapter (lib/llm/anthropic.ts & openai.ts) menerjemahkan
// TOOLS ini ke schema masing-masing provider — tidak ada definisi ganda.

import type { Tool } from "@/lib/llm/types";

import { listDocumentsTool, runListDocuments } from "./listDocuments";
import { toolErrorResult, type ToolContext, type ToolExecutionResult } from "./shared";
import { runSummarizeDocument, summarizeDocumentTool } from "./summarizeDocument";

export type { ToolContext, ToolExecutionResult } from "./shared";

export const TOOLS: Tool[] = [listDocumentsTool, summarizeDocumentTool];

type ToolRunner = (input: unknown, ctx: ToolContext) => Promise<ToolExecutionResult>;

// Map (bukan objek biasa): nama tool datang dari MODEL. Dengan objek biasa,
// nama seperti "constructor" atau "__proto__" akan menemukan properti
// bawaan Object dan ikut "dieksekusi".
const RUNNERS = new Map<string, ToolRunner>([
  [listDocumentsTool.name, runListDocuments],
  [summarizeDocumentTool.name, runSummarizeDocument],
]);

/**
 * Jalankan tool yang diminta model. Tidak pernah throw untuk masalah level
 * tool: tool tak dikenal / error tak terduga dikembalikan sebagai hasil
 * error (string untuk model + card error untuk UI), supaya loop tool-call di
 * route chat tetap bisa lanjut dan model bisa menjelaskan ke user.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const run = RUNNERS.get(name);
  if (!run) {
    const shown = name.length > 64 ? `${name.slice(0, 64)}…` : name;
    const available = TOOLS.map((tool) => tool.name).join(", ");
    return toolErrorResult(`Tool "${shown}" tidak dikenal. Tool yang tersedia: ${available}.`);
  }
  try {
    return await run(input, ctx);
  } catch (err) {
    console.error(`[tools] ${name} error tak terduga:`, err);
    return toolErrorResult("Tool gagal dijalankan karena kesalahan di server.");
  }
}
