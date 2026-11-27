import { FunctionCallItem, FunctionCallOutputItem, type ModelContext, type Tool } from "@mozaik-ai/core";

const CHARS_PER_TOKEN = 3.2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function itemText(item: unknown): string {
  return JSON.stringify(item) ?? "";
}

export interface FitResult {
  fits: boolean;
  estimate: number;
  compacted: number;
}

/**
 * Keeps one model request under a provider's per-request token limit. Older tool results are replaced, oldest first,
 * with a short note that names the tool and says the result can be fetched again; the call and its output stay
 * paired so the conversation remains valid. Instructions, the task and the latest results are never touched.
 */
export function fitContext(context: ModelContext, tools: Tool[], limitTokens: number): FitResult {
  const toolTokens = estimateTokens(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))));
  const items = context.items;
  const total = () => toolTokens + items.reduce((sum, item) => sum + estimateTokens(itemText(item)), 0);
  let estimate = total();
  let compacted = 0;
  if (limitTokens <= 0 || estimate <= limitTokens) return { fits: true, estimate, compacted };
  const outputs = items.map((item, index) => ({ item, index })).filter(({ item }) => item instanceof FunctionCallOutputItem);
  for (const { item, index } of outputs.slice(0, -1)) {
    const output = item as FunctionCallOutputItem;
    if (output.output.text.startsWith("[omitted")) continue;
    const call = items.find((i) => i instanceof FunctionCallItem && i.callId === output.callId) as FunctionCallItem | undefined;
    const note = `[omitted to stay under the model's request size limit: the ${call?.name ?? "tool"} result was ${output.output.text.length} characters. Call the tool again if you still need it.]`;
    items[index] = FunctionCallOutputItem.create(output.callId, note);
    compacted += 1;
    estimate = total();
    if (estimate <= limitTokens) return { fits: true, estimate, compacted };
  }
  return { fits: estimate <= limitTokens, estimate, compacted };
}
