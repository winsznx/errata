import { RuntimeState, defineRuntime, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core";
import { ENV } from "../config/env.js";

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.queue.shift()?.();
    };
  }
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly code: "TIMEOUT" | "QUOTA_EXCEEDED" | "PROVIDER_ERROR" | "FAULT_INJECTED_TIMEOUT",
  ) {
    super(message);
  }
}

export interface CallContext {
  workspaceId: string;
  agentRunId: string;
  role: string;
  onUsage: (inputTokens: number, outputTokens: number) => void;
  onFailure: (error: ModelCallError) => void;
  forcedTimeout?: () => boolean;
}

/** Mozaik's own DefaultInferenceRunner, obtained from a throwaway runtime because its constructor dependencies are not exported. */
function defaultRunner(): InferenceRunner {
  class ProbeState extends RuntimeState {}
  const probe = defineRuntime<ProbeState>();
  probe.initializeRuntime({ state: new ProbeState() });
  return probe.resolveRuntime().getInferenceRunner();
}

const GLOBAL = new Semaphore(ENV.MODEL_CONCURRENCY_GLOBAL);
const perWorkspace = new Map<string, Semaphore>();
let dailyCalls = 0;
let dailyResetAt = Date.now() + 86_400_000;
const callsPerWorkspace = new Map<string, number>();

/**
 * Wraps the native runner with the controls the SDK leaves to the host: bounded concurrency, call deadlines,
 * budgets and failure reporting. Mozaik 4.x executes only the first function call of a turn, so any extra calls
 * are dropped here before they enter the context; the model sees one call and one result and issues the rest next turn.
 */
export class GuardedInferenceRunner implements InferenceRunner {
  private readonly inner = defaultRunner();
  private readonly contexts = new Map<string, CallContext>();

  register(contextId: string, call: CallContext): void {
    this.contexts.set(contextId, call);
  }

  release(contextId: string): void {
    this.contexts.delete(contextId);
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const call = this.contexts.get(input.context.id);
    if (!call) throw new ModelCallError("inference requested for an unregistered loop context", "PROVIDER_ERROR");
    if (Date.now() > dailyResetAt) {
      dailyCalls = 0;
      dailyResetAt = Date.now() + 86_400_000;
    }
    const used = callsPerWorkspace.get(call.workspaceId) ?? 0;
    if (dailyCalls >= ENV.MODEL_DAILY_BUDGET_CALLS || used >= ENV.MODEL_MAX_CALLS_PER_RUN) {
      const error = new ModelCallError("model call budget reached for this workspace or day", "QUOTA_EXCEEDED");
      call.onFailure(error);
      throw error;
    }
    if (call.forcedTimeout?.()) {
      const error = new ModelCallError("Fault injection: this model call was forced to time out", "FAULT_INJECTED_TIMEOUT");
      call.onFailure(error);
      throw error;
    }
    const semaphore = perWorkspace.get(call.workspaceId) ?? new Semaphore(ENV.MODEL_CONCURRENCY_WORKSPACE);
    perWorkspace.set(call.workspaceId, semaphore);
    const releaseGlobal = await GLOBAL.acquire();
    const releaseLocal = await semaphore.acquire();
    dailyCalls += 1;
    callsPerWorkspace.set(call.workspaceId, used + 1);
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([
        this.inner.run(input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ModelCallError(`model call exceeded ${ENV.MODEL_CALL_TIMEOUT_MS} ms`, "TIMEOUT")), ENV.MODEL_CALL_TIMEOUT_MS);
        }),
      ]);
      if (output.tokenUsage) call.onUsage(output.tokenUsage.inputTokens, output.tokenUsage.outputTokens);
      const firstCall = output.items.findIndex((item) => item.getType() === "function_call");
      const items = firstCall < 0 ? output.items : output.items.filter((item, index) => item.getType() !== "function_call" || index === firstCall);
      return { ...output, items };
    } catch (error) {
      const wrapped = error instanceof ModelCallError ? error : new ModelCallError(error instanceof Error ? error.message : String(error), "PROVIDER_ERROR");
      call.onFailure(wrapped);
      throw wrapped;
    } finally {
      clearTimeout(timer);
      releaseLocal();
      releaseGlobal();
    }
  }

  stream(input: InferenceInput): AsyncGenerator<import("@mozaik-ai/core").SemanticEvent> {
    return this.inner.stream(input);
  }

  resetWorkspaceBudget(workspaceId: string): void {
    callsPerWorkspace.delete(workspaceId);
  }
}

export const guardedRunner = new GuardedInferenceRunner();
