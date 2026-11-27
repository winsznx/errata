import { OpenAIChatCompletions, RuntimeState, defineRuntime, supportedModels, type Endpoint, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core";
import OpenAI, { APIConnectionError } from "openai";
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
    readonly code: "TIMEOUT" | "QUOTA_EXCEEDED" | "PROVIDER_ERROR" | "RATE_LIMITED" | "FAULT_INJECTED_TIMEOUT",
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
  /** Called while the call waits for a model slot or a provider retry window, so the run is not mistaken for a stalled one. */
  onWaiting: () => void;
  forcedTimeout?: () => boolean;
}

/** Billing and quota refusals are not transient; retrying them only repeats the failure. */
/** Reads the provider's own wait hint ("try again in 7.24s", "try again in 1m3.5s") so a rate-limited call waits exactly as long as asked. */
export function retryDelayMs(message: string): number | null {
  const match = /try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)/i.exec(message);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const value = Number(match[2]);
  return Math.ceil(minutes * 60_000 + (match[3] === "ms" ? value : value * 1000));
}

export function classifyProviderError(error: unknown): ModelCallError {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number }).status;
  if (/rate limit reached|try again in/i.test(message)) return new ModelCallError(message, "RATE_LIMITED");
  const billing = /(no credits|credit balance|insufficient_quota|exceeded your current quota|payment required)/i.test(message);
  if ((status === 402 || status === 429 || status === 400) && billing) return new ModelCallError(`The model provider refused the call for billing or quota reasons: ${message.slice(0, 200)}`, "QUOTA_EXCEEDED");
  return new ModelCallError(message, "PROVIDER_ERROR");
}

type ModelEntry = (typeof supportedModels)[number];

/**
 * Groq serves an OpenAI-compatible Chat Completions API. It is registered as a Mozaik model entry that reuses the
 * capability profile of the SDK's bundled Chat Completions models (tool calling, no structured output) and the
 * SDK's own Chat Completions request and response mapper, so the native validator and context mapping still apply.
 * Only the HTTP client is ours: the SDK's client keeps the OpenAI defaults of a ten minute request timeout and
 * silent retries, which let one stalled request hold the model slot for every agent in the process.
 */
function groqModel(name: string): ModelEntry {
  const template = supportedModels.find((m) => m.specification.provider === "deepseek");
  if (!template) throw new Error("the pinned Mozaik SDK has no Chat Completions model profile to base a Groq model on");
  const connection = { baseURL: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY };
  const sdkEndpoint = new OpenAIChatCompletions(undefined, connection);
  const client = new OpenAI({ ...connection, timeout: ENV.MODEL_ATTEMPT_TIMEOUT_MS, maxRetries: 0 });
  const endpoint: Endpoint = {
    endpointMapper: sdkEndpoint.endpointMapper,
    infer: async (input) => sdkEndpoint.endpointMapper.toResponse(await client.chat.completions.create(sdkEndpoint.endpointMapper.toRequest(input))),
    stream: (input) => sdkEndpoint.stream(input),
  };
  return { ...template, endpoint, specification: { ...template.specification, name, provider: "groq" } } as ModelEntry;
}

export function modelRegistry(): ModelEntry[] {
  if (ENV.MODEL_PROVIDER !== "groq") return [...supportedModels];
  return [...supportedModels.filter((m) => m.specification.name !== ENV.MODEL_ID), groqModel(ENV.MODEL_ID)];
}

/** Mozaik's own DefaultInferenceRunner, obtained from a throwaway runtime because its constructor dependencies are not exported. */
function defaultRunner(): InferenceRunner {
  class ProbeState extends RuntimeState {}
  const probe = defineRuntime<ProbeState>();
  probe.initializeRuntime({ state: new ProbeState(), inferenceRunnerConfig: { supportedModels: modelRegistry() } });
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
  constructor(private readonly inner: InferenceRunner = defaultRunner()) {}
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
    const { releaseGlobal, releaseLocal } = await whileWaiting(call, async () => ({ releaseGlobal: await GLOBAL.acquire(), releaseLocal: await semaphore.acquire() }));
    dailyCalls += 1;
    callsPerWorkspace.set(call.workspaceId, used + 1);
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([
        this.runWithBackoff(input, call),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ModelCallError(`model call exceeded ${ENV.MODEL_CALL_TIMEOUT_MS} ms`, "TIMEOUT")), ENV.MODEL_CALL_TIMEOUT_MS);
        }),
      ]);
      const usage = output.tokenUsage ?? (output.rowResponse as { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } } | undefined)?.usage;
      if (usage) {
        const inputTokens = "inputTokens" in usage ? usage.inputTokens : (usage.input_tokens ?? usage.prompt_tokens ?? 0);
        const outputTokens = "outputTokens" in usage ? usage.outputTokens : (usage.output_tokens ?? usage.completion_tokens ?? 0);
        call.onUsage(Number(inputTokens) || 0, Number(outputTokens) || 0);
      }
      const firstCall = output.items.findIndex((item) => item.getType() === "function_call");
      const items = firstCall < 0 ? output.items : output.items.filter((item, index) => item.getType() !== "function_call" || index === firstCall);
      return { ...output, items };
    } catch (error) {
      const wrapped = error instanceof ModelCallError ? error : classifyProviderError(error);
      call.onFailure(wrapped);
      throw wrapped;
    } finally {
      clearTimeout(timer);
      releaseLocal();
      releaseGlobal();
    }
  }

  /**
   * Retries provider rate limits, waiting as long as the provider asks, and up to two attempts that timed out or lost
   * their connection, all within the call deadline enforced by run().
   */
  private async runWithBackoff(input: InferenceInput, call: CallContext): Promise<InferenceOutput> {
    let connectionFailures = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.inner.run(input);
      } catch (error) {
        const classified = classifyProviderError(error);
        const connectionLost = error instanceof APIConnectionError;
        if (connectionLost) connectionFailures += 1;
        const retryable = (classified.code === "RATE_LIMITED" && attempt < 12) || (connectionLost && connectionFailures <= 2);
        if (!retryable) throw error;
        const wait = connectionLost ? 2000 : (retryDelayMs(classified.message) ?? Math.min(30_000, 2 ** attempt * 1000));
        console.warn(`[model] run ${call.agentRunId} attempt ${attempt} ${connectionLost ? "lost its connection or timed out" : "was rate limited"}; retrying in ${Math.round(wait / 1000)}s`);
        await whileWaiting(call, () => new Promise((r) => setTimeout(r, wait + 250 + Math.random() * 500)));
      }
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

async function whileWaiting<T>(call: CallContext, work: () => Promise<T>): Promise<T> {
  const beat = setInterval(call.onWaiting, 30_000);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
