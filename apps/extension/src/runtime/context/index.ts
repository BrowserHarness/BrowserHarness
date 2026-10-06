// The Context Compiler: one way for every entry point to decide what goes with a request.
import { compileContext, type CompileInput } from "./compiler";
import { recordContextDiagnostics } from "./diagnostics";
import { renderContext } from "./render";
import type { CompiledContext } from "./types";

export { compileContext, type ChatTurn, type CompileInput } from "./compiler";
export { renderContext } from "./render";
export { budgetFor, contextWindowFor, estimateTokens } from "./budget";
export { BrowserHarnessLocalMemorySource, localMemorySource, type MemorySource, type CurrentMemory } from "./memory-source";
export { CONTEXT_DIAGNOSTICS_KEY, loadContextDiagnostics, recordContextDiagnostics } from "./diagnostics";
export * from "./types";

/** Compiles, keeps the diagnostics, and gives back the compiled context with its text. */
export async function contextFor(input: CompileInput): Promise<{ compiled: CompiledContext; text: string }> {
  const compiled = await compileContext(input);
  void recordContextDiagnostics(compiled.diagnostics);
  return { compiled, text: renderContext(compiled) };
}
