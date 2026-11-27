import "dotenv/config";
import {
  Agent,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  createAgent,
  createHuman,
  defineRuntime,
  ModelContext,
  DeveloperMessageItem,
  type InterceptionHandler,
  type SituationContext,
  type SituationHandler,
} from "@mozaik-ai/core";
import { modelRegistry } from "../agents/model.js";

class SpikeState extends RuntimeState {
  epoch = 1;
  intervals = new Map<string, { agent: string; start: number; end?: number }>();
}

const { initializeRuntime, resolveRuntime, join, sendEvent, runLoop } = defineRuntime<SpikeState>();
initializeRuntime({ state: new SpikeState(), inferenceRunnerConfig: { supportedModels: modelRegistry() } });

class OnType extends SituationSpecification {
  constructor(private readonly type: string) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === this.type;
  }
}

const model = process.env.SPIKE_MODEL ?? process.env.MODEL_ID ?? "gpt-5.4";

function freshContext(agent: Agent): ModelContext {
  return ModelContext.rehydrate({
    id: crypto.randomUUID(),
    items: [DeveloperMessageItem.create(agent.getDeveloperMessage())],
  });
}

const staleGuard = (epochAtStart: number): InterceptionHandler => ({
  isSatisfiedBy: () => true,
  async handle(transition) {
    const state = resolveRuntime().state;
    if (state.epoch !== epochAtStart) console.log(`[guard] loop started at epoch ${epochAtStart} sees epoch ${state.epoch} before ${transition.nextStateId}`);
    return transition;
  },
});

const wakeOnEvidence: SituationHandler = {
  specification: new OnType("evidence.changed"),
  processor: {
    apply({ participant }) {
      if (!(participant instanceof Agent)) return;
      const state = resolveRuntime().state;
      const epoch = state.epoch;
      runLoop(
        participant.getId(),
        `Evidence epoch is now ${epoch}. In one short sentence, state what your role checks first.`,
        { model, maxOutputTokens: 200, context: freshContext(participant) },
        staleGuard(epoch),
      );
    },
  },
};

const recordLoops: SituationHandler = {
  specification: new OnType("message_received.started").or(new OnType("model.answer")),
  processor: {
    apply({ event, participant }) {
      if (participant.getManifest().role !== "human") return;
      const { loopId } = event.payload as { loopId: string };
      const intervals = resolveRuntime().state.intervals;
      const agent = resolveRuntime().getParticipant(event.producerId)?.getManifest().name ?? event.producerId;
      if (event.type === "message_received.started") intervals.set(loopId, { agent, start: performance.now() });
      else {
        const row = intervals.get(loopId);
        if (row) row.end = performance.now();
        const answer = (event.payload as { answer: { content: { text: string } } }).answer.content.text;
        console.log(`[answer] ${agent}: ${answer}`);
      }
    },
  },
};

process.on("unhandledRejection", (error) => console.error("[unhandled]", error));

const observer = createHuman({ name: "observer", capabilities: [], handlers: [recordLoops] });
const verifier = createAgent({ name: "financial-verifier", capabilities: ["inference"], instruction: "You are a financial evidence verifier.", tools: [], handlers: [wakeOnEvidence] });
const analyst = createAgent({ name: "impact-analyst", capabilities: ["inference"], instruction: "You are a research impact analyst.", tools: [], handlers: [wakeOnEvidence] });
join(observer);
join(verifier);
join(analyst);

sendEvent(SemanticEvent.create("evidence.changed", observer.getId(), { epoch: 1 }), observer.getId());
setTimeout(() => {
  resolveRuntime().state.epoch = 2;
  console.log("[spike] epoch advanced to 2");
}, 300);

const timer = setInterval(() => {
  const rows = [...resolveRuntime().state.intervals.values()];
  if (rows.length === 2 && rows.every((r) => r.end !== undefined)) {
    clearInterval(timer);
    const [a, b] = rows as [{ agent: string; start: number; end: number }, { agent: string; start: number; end: number }];
    const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    for (const r of rows) console.log(`[interval] ${r.agent} ${r.start.toFixed(0)}..${r.end!.toFixed(0)}ms`);
    console.log(`[overlap] ${overlap.toFixed(0)}ms`);
    setTimeout(() => process.exit(0), 2500);
  }
}, 100);
setTimeout(() => {
  console.error("[spike] timeout");
  process.exit(1);
}, 90_000);
