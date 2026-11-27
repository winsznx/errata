import {
  type Agent,
  DeveloperMessageItem,
  ModelContext,
  ModelMessageItem,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  createAgent,
  createHuman,
  defineRuntime,
  type ExecutableTransition,
  type Human,
  type InterceptionHandler,
  type SituationContext,
  type SituationHandler,
  type Tool,
} from "@mozaik-ai/core";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { ENV } from "../config/env.js";
import { db } from "../db/client.js";
import { agentRun, caseSource, challenge, toolCall, claim, claimImpact, correctionCase, disclosureEvent, replacementProposal, researchReport, researchRevision, runtimeSession, sourceDocument, workspace } from "../db/schema.js";
import { commit, eventBus, serializeEvent, type CommittedEvent } from "../domain/events.js";
import type { ScenarioFault } from "../domain/scenarios.js";
import { injectWrongPeriodProposal } from "../domain/faults.js";
import { fitContext } from "./context-budget.js";
import { guardedRunner, type ModelCallError } from "./model.js";
import { AGENT_CAPABILITIES, AGENT_ROLES, ROLE_INSTRUCTIONS, type AgentRole } from "./prompts.js";
import { buildTools } from "./tools.js";

export const SDK_VERSION = "@mozaik-ai/core 4.2.0";
const CLOUD_URL = /watching live:\s*(https:\/\/\S+)/;

interface CaseProjection {
  epoch: number;
  status: string;
  scopeConfirmed: boolean;
  issuerCik: string;
}

interface ActiveRun {
  role: AgentRole;
  task: string;
  caseId: string | null;
  epoch: number | null;
  startedAt: string;
  loopId: string | null;
}

/** Typed shared state every participant observes. The database stays the authority; this is the live coordination projection. */
export class ErrataRuntimeState extends RuntimeState {
  workspaceId = "";
  logicalTime: string | null = null;
  cases = new Map<string, CaseProjection>();
  activeRuns = new Map<string, ActiveRun>();
  lastEventSeq = "0";
  faults: ScenarioFault[] = [];

  projection(caseId?: string | null): Record<string, unknown> {
    const cases = caseId ? Object.fromEntries([...this.cases].filter(([id]) => id === caseId)) : Object.fromEntries(this.cases);
    return {
      logicalTime: this.logicalTime,
      lastEventSeq: this.lastEventSeq,
      cases,
      otherActiveWork: [...this.activeRuns.values()].filter((r) => !caseId || r.caseId === caseId).map((r) => `${r.role}: ${r.task}`),
    };
  }

  /** The same shared state with each active loop spelled out, for the runtime page. */
  snapshot() {
    return {
      logicalTime: this.logicalTime,
      lastEventSeq: this.lastEventSeq,
      cases: Object.fromEntries(this.cases),
      activeRuns: [...this.activeRuns].map(([agentRunId, r]) => ({ agentRunId, role: r.role, task: r.task, epoch: r.epoch })),
    };
  }
}

class OnEventTypes extends SituationSpecification {
  constructor(private readonly types: Set<string>) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext): boolean {
    return this.types.has(event.type);
  }
}

export interface Task {
  kind: string;
  key: string;
  caseId: string | null;
  epoch: number | null;
  message: string;
  trigger: string;
}

export function verifyTask(proposal: { id: string; kind: string; proposerAgent: string; caseId: string; epoch: number }, attempt: string, trigger: string, retried: boolean): Task {
  const how =
    proposal.kind === "formula"
      ? "Recompute it with compute_formula and submit verdict verified with the value it returns, copied in full. The figure printed in the note is the original one and is expected to differ; do not compare with it. Code compares your value with the proposal."
      : proposal.kind === "unaffected"
        ? "Read the claim and confirm it contains no figures and relies on none."
        : "Choose the cell for the claim's period end, read it with read_source_excerpt, check its column header says as restated, convert the printed value to base units using the scale note, and submit that value with that locator id.";
  return {
    kind: "verify_replacement",
    key: `verify:${proposal.id}:${attempt}`,
    caseId: proposal.caseId,
    epoch: proposal.epoch,
    trigger,
    message: `Verify proposal ${proposal.id} (kind ${proposal.kind}) from ${proposal.proposerAgent}.${retried ? " An earlier check of this proposal ended without a recorded verdict." : ""} Your check only counts once submit_verification succeeds. Use get_proposal to see the claim, its identity and the amendment cells that share it. ${how}`,
  };
}

/** The write each task exists to make. A loop that ends without it gets one reminder before it may finish. */
export const REQUIRED_TOOL: Record<string, string> = {
  classify_filing: "propose_disclosure_scope",
  link_amendment: "propose_amendment_link",
  check_scope: "check_disclosure_scope",
  verify_replacement: "submit_verification",
  review_conclusions: "review_draft_conclusions",
  propose_replacements: "propose_replacement",
  write_warning: "propose_warning_text",
  draft_revision: "propose_revision_patch",
  revise_draft: "propose_revision_patch",
  extract_claims: "propose_claim",
  verify_bindings: "confirm_binding",
};

const TRIGGERS: Record<AgentRole, string[]> = {
  "filing-monitor": ["filing.discovered", "filing.non_reliance_detected", "challenge.raised", "runtime.reconcile"],
  "financial-verifier": ["filing.scope_proposed", "claim.replacement_proposed", "verification.recheck_requested", "report.binding_check_requested", "report.revision_prepared", "runtime.reconcile"],
  "impact-analyst": ["report.extraction_requested", "filing.non_reliance_detected", "evidence.superseded", "claim.verified", "claim.rejected", "challenge.raised", "runtime.reconcile"],
  "publication-editor": ["report.warning_applied", "claim.verified", "case.status_changed", "report.changes_requested", "challenge.raised", "runtime.reconcile"],
};

export class WorkspaceRuntime {
  readonly state = new ErrataRuntimeState();
  private readonly rt = defineRuntime<ErrataRuntimeState>();
  private readonly agents = new Map<AgentRole, Agent>();
  private readonly roleByAgentId = new Map<string, AgentRole>();
  private host!: Human;
  private sessionId = "";
  private unsubscribe: (() => void) | null = null;
  private readonly loopToRun = new Map<string, string>();
  private readonly staleRuns = new Set<string>();
  private readonly launching = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private fault: { verifierTimeoutConsumed: boolean } = { verifierTimeoutConsumed: false };

  constructor(readonly workspaceId: string) {}

  async start(): Promise<void> {
    const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, this.workspaceId) });
    if (!ws) throw new Error(`workspace ${this.workspaceId} not found`);
    this.state.workspaceId = ws.id;
    this.state.logicalTime = ws.logicalTime?.toISOString() ?? null;
    this.state.lastEventSeq = ws.eventSeq.toString();
    this.state.faults = (ws.settings.faults as ScenarioFault[] | undefined) ?? [];
    this.fault.verifierTimeoutConsumed = ((ws.settings.consumedFaults as string[] | undefined) ?? []).includes("verifier_timeout_once");
    await this.refreshCases();

    this.rt.initializeRuntime({ state: this.state, inferenceRunnerConfig: { runner: guardedRunner } });
    this.host = createHuman({ name: "errata-host", capabilities: ["domain-events", "observer"], handlers: [this.observerHandler()] });
    this.rt.join(this.host);
    this.rt.join(createHuman({ name: "human-editor", capabilities: ["approve", "reissue", "withdraw"], handlers: [] }));
    for (const role of AGENT_ROLES) {
      const agent = createAgent({ name: role, capabilities: AGENT_CAPABILITIES[role], instruction: ROLE_INSTRUCTIONS[role], tools: [], handlers: ws.isReference ? [] : [this.roleHandler(role)] });
      this.agents.set(role, agent);
      this.roleByAgentId.set(agent.getId(), role);
      this.rt.join(agent);
    }
    // A reference workspace is a finished recorded run: its participants are shown, but nothing is written or planned.
    if (ws.isReference) return;

    const [fence] = await db.execute<{ next: number }>(sql`select coalesce(max(lease_fence), 0) + 1 as next from runtime_session where workspace_id = ${this.workspaceId}`);
    await db.update(runtimeSession).set({ status: "ENDED", endedAt: new Date() }).where(and(eq(runtimeSession.workspaceId, this.workspaceId), eq(runtimeSession.status, "ACTIVE")));
    const [session] = await db
      .insert(runtimeSession)
      .values({ workspaceId: this.workspaceId, sdkVersion: SDK_VERSION, model: ENV.MODEL_ID, leaseFence: Number(fence?.next ?? 1), leaseHolder: `pid:${process.pid}`, leaseUntil: new Date(Date.now() + 45_000), status: "ACTIVE" })
      .returning();
    this.sessionId = session!.id;
    const interrupted = await db
      .update(agentRun)
      .set({ status: "FAILED", errorCode: "RUNTIME_RESTARTED", errorMessage: "The runtime restarted while this loop was running; a fresh attempt replaces it", endedAt: new Date() })
      .where(and(eq(agentRun.workspaceId, this.workspaceId), eq(agentRun.status, "STARTED")))
      .returning({ id: agentRun.id, taskKey: agentRun.taskKey });

    this.unsubscribe = eventBus.onCommitted((event) => {
      if (event.workspaceId !== this.workspaceId) return;
      void this.forward(event);
    });
    this.sweepTimer = setInterval(() => void this.sweep(), 15_000);
    await commit(async (_tx, record) => {
      await record({ workspaceId: this.workspaceId, type: "runtime.started", actor: { kind: "system", id: "runtime" }, payload: { runtimeSessionId: this.sessionId, sdkVersion: SDK_VERSION, model: ENV.MODEL_ID, participants: [...this.agents.keys(), "errata-host", "human-editor"] } });
    });
    this.rt.sendEvent(SemanticEvent.create("runtime.reconcile", this.host.getId(), { reason: "runtime started" }), this.host.getId());
    for (const run of interrupted) {
      const restarts = await db.$count(agentRun, and(eq(agentRun.workspaceId, this.workspaceId), eq(agentRun.taskKey, run.taskKey), eq(agentRun.errorCode, "RUNTIME_RESTARTED")));
      if (restarts <= MAX_RESTARTS_PER_TASK) await this.retry(run.id);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async refreshCases(): Promise<void> {
    const cases = await db.select().from(correctionCase).where(eq(correctionCase.workspaceId, this.workspaceId));
    this.state.cases = new Map(cases.map((c) => [c.id, { epoch: c.evidenceEpoch, status: c.status, scopeConfirmed: c.scopeConfirmed, issuerCik: c.issuerCik }]));
  }

  /** Committed domain events enter the native bus as semantic events; agents react through their own situation handlers. */
  private async forward(event: CommittedEvent): Promise<void> {
    try {
      if (event.caseId || event.type.startsWith("case.") || event.type.startsWith("filing.")) await this.refreshCases();
      if (event.type === "replay.advanced") this.state.logicalTime = String((event.payload as { logicalTime?: string }).logicalTime ?? this.state.logicalTime);
      this.state.lastEventSeq = event.seq.toString();
      if (event.type === "filing.amendment_received" && event.caseId && this.state.faults.some((f) => f.type === "inject_wrong_period_proposal")) {
        await injectWrongPeriodProposal(this.workspaceId, event.caseId);
      }
      this.rt.sendEvent(SemanticEvent.create(event.type, this.host.getId(), serializeEvent(event)), this.host.getId());
    } catch (error) {
      console.error("[runtime] forward failed", error);
    }
  }

  private roleHandler(role: AgentRole): SituationHandler {
    return {
      specification: new OnEventTypes(new Set(TRIGGERS[role])),
      processor: {
        apply: ({ event, participant }) => {
          if (participant.getId() !== this.agents.get(role)?.getId()) return;
          this.decide(role, event).catch((error: unknown) => console.error(`[runtime] ${role} failed to react to ${event.type}`, error));
        },
      },
    };
  }

  private observerHandler(): SituationHandler {
    const loopTypes = new Set(["message_received.started", "model.answer", "function_call.completed"]);
    return {
      specification: new OnEventTypes(loopTypes),
      processor: {
        apply: ({ event }) => {
          const payload = event.payload as { loopId?: string; content?: string; answer?: { content?: { text?: string } } };
          if (!payload.loopId) return;
          if (event.type === "message_received.started") {
            const tag = /\[run:([0-9a-f-]{36})\]/.exec(payload.content ?? "");
            if (tag?.[1]) {
              this.loopToRun.set(payload.loopId, tag[1]);
              const active = this.state.activeRuns.get(tag[1]);
              if (active) active.loopId = payload.loopId;
              void db.update(agentRun).set({ nativeLoopId: payload.loopId, heartbeatAt: new Date() }).where(eq(agentRun.id, tag[1]));
            }
            return;
          }
          const runId = this.loopToRun.get(payload.loopId);
          if (!runId) return;
          if (event.type === "function_call.completed") {
            void db.update(agentRun).set({ heartbeatAt: new Date() }).where(eq(agentRun.id, runId));
            return;
          }
          void this.finishRun(runId, payload.answer?.content?.text ?? "");
        },
      },
    };
  }

  private async finishRun(runId: string, answer: string): Promise<void> {
    const active = this.state.activeRuns.get(runId);
    this.state.activeRuns.delete(runId);
    const row = await db.query.agentRun.findFirst({ where: eq(agentRun.id, runId) });
    if (row?.status !== "STARTED") return;
    const stale = this.staleRuns.has(runId) || row.outcome === "stale" || /STALE_EVIDENCE/.test(answer);
    const status = stale ? "STALE" : "COMPLETED";
    const outcome = row.outcome ?? (stale ? "stale" : /^Stopped by interception/.test(answer) ? "failed" : "done");
    await db.update(agentRun).set({ status, outcome, endedAt: new Date(), summary: row.summary ?? answer.slice(0, 600) }).where(eq(agentRun.id, runId));
    await commit(async (_tx, record) => {
      await record({ workspaceId: this.workspaceId, type: status === "STALE" ? "agent.stale" : "agent.completed", actor: { kind: "agent", id: row.role }, caseId: row.caseId, evidenceEpoch: row.epoch, payload: { agentRunId: runId, role: row.role, task: active?.task ?? row.taskKey, outcome: row.outcome, summary: (row.summary ?? answer).slice(0, 400), loopId: row.nativeLoopId } });
    });
  }

  private async failRun(runId: string, error: ModelCallError): Promise<void> {
    this.state.activeRuns.delete(runId);
    const row = await db.query.agentRun.findFirst({ where: eq(agentRun.id, runId) });
    if (row?.status !== "STARTED") return;
    const status = error.code === "TIMEOUT" || error.code === "FAULT_INJECTED_TIMEOUT" ? "TIMED_OUT" : "FAILED";
    await db.update(agentRun).set({ status, errorCode: error.code, errorMessage: error.message.slice(0, 500), endedAt: new Date() }).where(eq(agentRun.id, runId));
    await commit(async (_tx, record) => {
      await record({ workspaceId: this.workspaceId, type: status === "TIMED_OUT" ? "agent.timed_out" : "agent.failed", actor: { kind: "agent", id: row.role }, caseId: row.caseId, evidenceEpoch: row.epoch, payload: { agentRunId: runId, role: row.role, task: row.taskKey, attempt: row.attempt, errorCode: error.code, message: error.message.slice(0, 300) } });
    });
    if (row.attempt < 2 && error.code !== "QUOTA_EXCEEDED") {
      setTimeout(() => void this.retry(runId), 4000);
    }
  }

  async retry(runId: string): Promise<{ agentRunId: string } | null> {
    const row = await db.query.agentRun.findFirst({ where: eq(agentRun.id, runId) });
    if (!row || !["FAILED", "TIMED_OUT"].includes(row.status)) return null;
    const role = row.role as AgentRole;
    const trigger = row.trigger.startsWith("{") ? (JSON.parse(row.trigger) as { message?: string; kind?: string }) : {};
    const caseRow = row.caseId ? await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, row.caseId) }) : null;
    return this.launch(role, { kind: trigger.kind ?? "retry", key: row.taskKey, caseId: row.caseId, epoch: caseRow?.evidenceEpoch ?? row.epoch, message: trigger.message ?? "", trigger: "retry" }, row.attempt + 1);
  }

  private async sweep(): Promise<void> {
    try {
      await db.update(runtimeSession).set({ heartbeatAt: new Date(), leaseUntil: new Date(Date.now() + 45_000) }).where(eq(runtimeSession.id, this.sessionId));
      const stale = await db.select().from(agentRun).where(and(eq(agentRun.workspaceId, this.workspaceId), eq(agentRun.status, "STARTED"), lt(agentRun.heartbeatAt, new Date(Date.now() - ENV.TASK_DEADLINE_MS))));
      for (const run of stale) await this.failRun(run.id, Object.assign(new Error(`no progress for ${ENV.TASK_DEADLINE_MS / 1000} seconds`), { code: "TIMEOUT" as const }) as ModelCallError);
      this.rt.sendEvent(SemanticEvent.create("runtime.reconcile", this.host.getId(), { reason: "periodic sweep" }), this.host.getId());
    } catch (error) {
      console.error("[runtime] sweep failed", error);
    }
  }

  private async decide(role: AgentRole, event: SemanticEvent): Promise<void> {
    const payload = ((event.payload as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
    const caseId = ((event.payload as { caseId?: string | null }).caseId ?? null) as string | null;
    const eventId = ((event.payload as { id?: string }).id ?? "reconcile") as string;
    const tasks = await planTasks(this.workspaceId, role, event.type, payload, caseId, eventId);
    for (const task of tasks) await this.launch(role, task, 1);
  }

  private interception(runId: string, caseId: string | null, epoch: number | null, context: ModelContext, tools: Tool[], taskKind: string): InterceptionHandler {
    let functionCalls = 0;
    let nudges = 0;
    const requiredTool = REQUIRED_TOOL[taskKind];
    const stop = (text: string): ExecutableTransition => ({ nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text }) } });
    return {
      isSatisfiedBy: (transition) => transition.nextStateId === "inference" || transition.nextStateId === "function_call" || transition.nextStateId === "model_message",
      handle: async (transition) => {
        if (transition.nextStateId === "function_call") functionCalls += 1;
        if (transition.nextStateId === "model_message") {
          if (!requiredTool || nudges >= 1) return transition;
          const done = await db.$count(toolCall, and(eq(toolCall.agentRunId, runId), eq(toolCall.toolName, requiredTool), eq(toolCall.ok, true)));
          if (done) return transition;
          nudges += 1;
          const reminder = `Completion check: this task is only recorded when ${requiredTool} succeeds, and it has not been called successfully in this run. If the evidence supports it, call ${requiredTool} now. If you deliberately decided not to, reply with one sentence saying why.`;
          return { nextStateId: "message_received", input: { content: reminder, input: { model: ENV.MODEL_ID, maxOutputTokens: ENV.MODEL_MAX_OUTPUT_TOKENS, ...(ENV.MODEL_REASONING_EFFORT ? { reasoningEffort: ENV.MODEL_REASONING_EFFORT } : {}), tools, context } } };
        }
        const current = caseId ? this.state.cases.get(caseId) : undefined;
        if (current && epoch !== null && current.epoch > epoch) {
          this.staleRuns.add(runId);
          return stop(`Stopped by interception: the case moved from evidence revision ${epoch} to ${current.epoch} before this step, so this loop's remaining work is stale.`);
        }
        if (transition.nextStateId === "inference" && ENV.MODEL_REQUEST_TOKEN_LIMIT > 0) {
          const fit = fitContext(context, tools, ENV.MODEL_REQUEST_TOKEN_LIMIT);
          if (fit.compacted) await db.update(agentRun).set({ heartbeatAt: new Date() }).where(eq(agentRun.id, runId));
          if (!fit.fits) {
            await db.update(agentRun).set({ outcome: "failed", summary: `Stopped by interception: the request would be about ${fit.estimate} tokens, above the provider's ${ENV.MODEL_REQUEST_TOKEN_LIMIT} limit even after omitting older tool results` }).where(eq(agentRun.id, runId));
            return stop(`Stopped by interception: this loop's context no longer fits the provider's request size limit.`);
          }
        }
        if (functionCalls > ENV.MAX_TOOL_CALLS_PER_LOOP) {
          await db.update(agentRun).set({ outcome: "failed", summary: `Stopped by interception after ${ENV.MAX_TOOL_CALLS_PER_LOOP} tool calls` }).where(eq(agentRun.id, runId));
          return stop(`Stopped by interception: tool call budget of ${ENV.MAX_TOOL_CALLS_PER_LOOP} reached.`);
        }
        return transition;
      },
    };
  }

  async launch(role: AgentRole, task: Task, attempt: number): Promise<{ agentRunId: string } | null> {
    const lockKey = `${role}:${task.key}`;
    if (this.launching.has(lockKey)) return null;
    this.launching.add(lockKey);
    try {
      const prior = await db.select({ id: agentRun.id, status: agentRun.status, attempt: agentRun.attempt }).from(agentRun).where(and(eq(agentRun.workspaceId, this.workspaceId), eq(agentRun.role, role), eq(agentRun.taskKey, task.key)));
      if (attempt === 1 && prior.length) return null;
      if (prior.some((p) => p.status === "STARTED") || prior.some((p) => p.attempt >= attempt)) return null;
      if (task.kind !== "verify_replacement" && attempt === 1) {
        const sameWork = [...this.state.activeRuns.values()].some((r) => r.role === role && r.task === task.kind && r.caseId === task.caseId);
        if (sameWork) return null;
      }
      if (task.kind === "verify_replacement" && [...this.state.activeRuns.values()].filter((r) => r.role === role).length >= 4) return null;
      const agent = this.agents.get(role)!;
      const now = new Date();
      const [run] = await db
        .insert(agentRun)
        .values({ workspaceId: this.workspaceId, runtimeSessionId: this.sessionId, nativeAgentId: agent.getId(), role, caseId: task.caseId, epoch: task.epoch, taskKey: task.key, trigger: JSON.stringify({ event: task.trigger, kind: task.kind, message: task.message }).slice(0, 8000), attempt, status: "STARTED", model: ENV.MODEL_ID, startedAt: now, heartbeatAt: now })
        .returning();
      const runId = run!.id;
      this.state.activeRuns.set(runId, { role, task: task.kind, caseId: task.caseId, epoch: task.epoch, startedAt: now.toISOString(), loopId: null });
      const context = ModelContext.rehydrate({ id: crypto.randomUUID(), items: [DeveloperMessageItem.create(agent.getDeveloperMessage())] });
      const forceTimeout = role === "financial-verifier" && this.state.faults.some((f) => f.type === "verifier_timeout_once") && !this.fault.verifierTimeoutConsumed;
      guardedRunner.register(context.id, {
        workspaceId: this.workspaceId,
        agentRunId: runId,
        role,
        onUsage: (input, output) =>
          void db
            .update(agentRun)
            .set({ inputTokens: sql`coalesce(${agentRun.inputTokens}, 0) + ${Math.trunc(input)}::int`, outputTokens: sql`coalesce(${agentRun.outputTokens}, 0) + ${Math.trunc(output)}::int`, heartbeatAt: new Date() })
            .where(eq(agentRun.id, runId))
            .catch((error: unknown) => console.error("[runtime] token usage update failed", error)),
        onFailure: (error) => void this.failRun(runId, error),
        onWaiting: () =>
          void db
            .update(agentRun)
            .set({ heartbeatAt: new Date() })
            .where(and(eq(agentRun.id, runId), eq(agentRun.status, "STARTED")))
            .catch((error: unknown) => console.error("[runtime] heartbeat update failed", error)),
        forcedTimeout: () => {
          if (!forceTimeout || this.fault.verifierTimeoutConsumed) return false;
          this.fault.verifierTimeoutConsumed = true;
          void db.execute(sql`update workspace set settings = jsonb_set(settings, '{consumedFaults}', coalesce(settings->'consumedFaults', '[]'::jsonb) || '["verifier_timeout_once"]'::jsonb) where id = ${this.workspaceId}`);
          return true;
        },
      });
      const tools = buildTools({ workspaceId: this.workspaceId, role, taskKind: task.kind, agentRunId: runId, caseId: task.caseId, epoch: task.epoch, faults: this.state.faults });
      const message = [
        `[run:${runId}] Task: ${task.kind}${task.caseId ? ` for case ${task.caseId}` : ""}. Evidence revision: ${task.epoch ?? "n/a"}. Attempt ${attempt}.`,
        task.message,
        `Shared runtime state (read only): ${JSON.stringify(this.state.projection(task.caseId))}`,
      ].join("\n\n");

      let cloudSessionUrl: string | null = null;
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        const match = typeof args[0] === "string" ? CLOUD_URL.exec(args[0]) : null;
        if (match?.[1]) cloudSessionUrl = match[1];
        originalLog(...args);
      };
      try {
        this.rt.runLoop(agent.getId(), message, { model: ENV.MODEL_ID, maxOutputTokens: ENV.MODEL_MAX_OUTPUT_TOKENS, ...(ENV.MODEL_REASONING_EFFORT ? { reasoningEffort: ENV.MODEL_REASONING_EFFORT } : {}), tools, context }, this.interception(runId, task.caseId, task.epoch, context, tools, task.kind));
      } finally {
        console.log = originalLog;
      }
      if (cloudSessionUrl) await db.update(agentRun).set({ cloudSessionUrl }).where(eq(agentRun.id, runId));
      await commit(async (_tx, record) => {
        await record({ workspaceId: this.workspaceId, type: "agent.started", actor: { kind: "agent", id: role }, caseId: task.caseId, evidenceEpoch: task.epoch, payload: { agentRunId: runId, role, task: task.kind, trigger: task.trigger, attempt, cloudSessionUrl } });
      });
      return { agentRunId: runId };
    } finally {
      this.launching.delete(lockKey);
    }
  }

  async recordHumanAction(type: string, payload: Record<string, unknown>): Promise<void> {
    const humanEditor = this.rt.resolveRuntime().state.getParticipants().find((p) => p.getManifest().name === "human-editor");
    if (humanEditor) this.rt.sendEvent(SemanticEvent.create(type, humanEditor.getId(), payload), humanEditor.getId());
  }

  participants(): { id: string; name: string; role: string; capabilities: readonly string[] }[] {
    return this.state.getParticipants().map((p) => ({ id: p.getId(), name: p.getManifest().name, role: p.getManifest().role, capabilities: p.getManifest().capabilities ?? [] }));
  }
}

async function caseEpoch(caseId: string): Promise<number | null> {
  const row = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) });
  return row?.evidenceEpoch ?? null;
}

/** Deterministic decision of which tasks a role should start for an event. The model decides how to do the work, not whether evidence changed. */
async function planTasks(workspaceId: string, role: AgentRole, type: string, payload: Record<string, unknown>, caseId: string | null, eventId: string): Promise<Task[]> {
  const tasks: Task[] = [];
  if (role === "impact-analyst" && type === "report.extraction_requested") {
    tasks.push({ kind: "extract_claims", key: `extract:${String(payload.revisionId)}:${eventId}`, caseId: null, epoch: null, trigger: type, message: `Map every figure in draft ${String(payload.revisionId)} to evidence. Read it with get_draft. For each numeric token, find the matching reported fact with search_facts (check the period and that the printed figure, after the note's units such as "thousand", equals the fact value) and call propose_claim with its exact block id and offsets. Propose DERIVED claims with a formula over the claim ids you already proposed, QUALITATIVE claims for conclusions that rely on figures (material), and OTHER for dates or labels that are not financial figures (not material, with a reason). Leave a figure unmapped if no fact matches; never guess.` });
  }
  if (role === "financial-verifier" && type === "report.binding_check_requested") {
    tasks.push({ kind: "verify_bindings", key: `bindings:${String(payload.revisionId)}:${eventId}`, caseId: null, epoch: null, trigger: type, message: `Check every PROPOSED claim mapping in draft ${String(payload.revisionId)} that another participant proposed. Read it with get_draft. For DIRECT claims, use list_source_sections on the cited source and read_source_excerpt on the row yourself, then call confirm_binding with the locator and the value you read. For DERIVED claims, compute the value from the confirmed inputs and confirm or reject. Confirm QUALITATIVE claims only when every claim they rely on is confirmed.` });
  }
  const openCases = await db.select().from(correctionCase).where(and(eq(correctionCase.workspaceId, workspaceId), sql`${correctionCase.status} not in ('RESOLVED','NOT_APPLICABLE')`));

  if (role === "filing-monitor") {
    const unclassified = await db
      .select({ disclosure: disclosureEvent, source: sourceDocument })
      .from(disclosureEvent)
      .innerJoin(sourceDocument, eq(sourceDocument.id, disclosureEvent.sourceId))
      .where(and(eq(disclosureEvent.workspaceId, workspaceId), eq(disclosureEvent.status, "DISCOVERED")));
    for (const { disclosure, source } of unclassified) {
      const relatedCases = openCases.filter((c) => c.issuerCik === source.cik);
      const isAmendment = source.form.endsWith("/A");
      if (isAmendment && !relatedCases.some((c) => c.scopeConfirmed)) continue;
      tasks.push({
        kind: isAmendment ? "link_amendment" : "classify_filing",
        key: `filing:${disclosure.id}${isAmendment ? `:${relatedCases.map((c) => c.id).join(",")}` : ""}`,
        caseId: isAmendment ? (relatedCases.find((c) => c.scopeConfirmed)?.id ?? null) : null,
        epoch: null,
        trigger: type,
        message: isAmendment
          ? `A new amended filing is public: ${source.form} ${source.accession} filed ${source.filedDate} for CIK ${source.cik} (sourceId ${source.id}). Open cases for this issuer: ${JSON.stringify(relatedCases.map((c) => ({ caseId: c.id, title: c.title, periods: c.scope?.periods, scopeConfirmed: c.scopeConfirmed })))}. Call list_source_sections on it with the case's period ends and rowLabel "total current" to see the restatement rows. If it restates a period in a case's scope, link it with propose_amendment_link citing one or two as_restated cell locators.`
          : `A new filing is public: ${source.form} ${source.accession} filed ${source.filedDate} for CIK ${source.cik} (sourceId ${source.id}). Read its Item sections with list_source_sections and read_source_excerpt. If Item 4.02 says financial statements should no longer be relied upon, call propose_disclosure_scope with classification NON_RELIANCE, every named period, and the locators of the paragraphs that name them. Otherwise classify it UNRELATED with a reason.`,
      });
    }
    if (type === "challenge.raised" && payload.targetKind === "disclosure_scope" && caseId) {
      tasks.push({ kind: "respond_scope_challenge", key: `scope-challenge:${String(payload.challengeId)}`, caseId: null, epoch: null, trigger: type, message: `Your proposed scope for case ${caseId} was challenged: ${String(payload.explanation)}. Proposed periods ${JSON.stringify(payload.proposedPeriods)}, checked periods ${JSON.stringify(payload.checkedPeriods)}. Re-read the excerpts. If the text supports a different scope, propose it again with propose_disclosure_scope; otherwise say that you stand by it.` });
    }
  }

  if (role === "financial-verifier") {
    const pendingScopes = await db
      .select({ disclosure: disclosureEvent, caseRow: correctionCase })
      .from(disclosureEvent)
      .innerJoin(correctionCase, eq(correctionCase.originEventId, disclosureEvent.id))
      .where(and(eq(disclosureEvent.workspaceId, workspaceId), eq(disclosureEvent.status, "SCOPE_PROPOSED")));
    for (const { disclosure, caseRow } of pendingScopes) {
      tasks.push({ kind: "check_scope", key: `scope-check:${caseRow.id}:${disclosure.updatedAt.getTime()}`, caseId: caseRow.id, epoch: caseRow.evidenceEpoch, trigger: type, message: `The Filing Monitor proposed a non-reliance scope for case ${caseRow.id} from source ${disclosure.sourceId}. Read the 8-K Item 4.02 paragraphs yourself (list_source_sections, read_source_excerpt), work out every period the issuer says should no longer be relied upon, and submit check_disclosure_scope with your own periods and the locators you read. Confirm only if your periods match what you read.` });
    }
    const pendingProposals = await db
      .select({ proposal: replacementProposal })
      .from(replacementProposal)
      .innerJoin(correctionCase, eq(correctionCase.id, replacementProposal.caseId))
      .where(and(eq(replacementProposal.workspaceId, workspaceId), eq(replacementProposal.status, "PROPOSED"), eq(replacementProposal.epoch, correctionCase.evidenceEpoch)));
    for (const { proposal } of pendingProposals) {
      if (proposal.proposerAgent === "financial-verifier") continue;
      if (type === "verification.recheck_requested" && payload.proposalId === proposal.id) {
        tasks.push(verifyTask(proposal, `requested:${eventId}`, type, true));
        continue;
      }
      const checks = await db.$count(agentRun, and(eq(agentRun.workspaceId, workspaceId), sql`${agentRun.taskKey} like ${`verify:${proposal.id}%`}`, eq(agentRun.status, "COMPLETED")));
      if (checks >= 2) continue;
      tasks.push(verifyTask(proposal, `${checks + 1}`, type, checks > 0));
    }
  }

  if (role === "financial-verifier") {
    const drafts = await db.select().from(researchRevision).where(and(eq(researchRevision.workspaceId, workspaceId), eq(researchRevision.kind, "candidate"), inArray(researchRevision.candidateState, ["READY", "BLOCKED", "CHECKING"])));
    for (const draft of drafts) {
      const meta = (draft.noticeDraft ?? {}) as { rewrittenQualitative?: string[]; conclusionReview?: unknown };
      if (!meta.rewrittenQualitative?.length || meta.conclusionReview || !draft.caseId) continue;
      tasks.push({ kind: "review_conclusions", key: `conclusions:${draft.id}`, caseId: draft.caseId, epoch: await caseEpoch(draft.caseId), trigger: type, message: `The Publication Editor drafted correction ${draft.id}. Read it with get_draft_for_review. Check every rewritten sentence and the notice text against the verified figures: signs, which side is larger, and any statement about coverage or financing need. Then call review_draft_conclusions. Say inconsistent if any sentence contradicts the figures, quoting it.` });
    }
  }

  if (role === "impact-analyst") {
    for (const caseRow of openCases.filter((c) => c.scopeConfirmed)) {
      const impacts = await db.select({ impact: claimImpact, claim }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(eq(claimImpact.caseId, caseRow.id));
      const proposals = await db.select().from(replacementProposal).where(and(eq(replacementProposal.caseId, caseRow.id), eq(replacementProposal.epoch, caseRow.evidenceEpoch)));
      const amendments = await db.$count(caseSource, and(eq(caseSource.caseId, caseRow.id), eq(caseSource.relation, "amendment")));
      const hasLive = (claimId: string) => proposals.some((p) => p.claimId === claimId && (p.status === "PROPOSED" || p.status === "VERIFIED"));
      const candidates = impacts.filter((i) => i.impact.classification === "candidate" && i.impact.state === "UNDER_REVIEW" && !hasLive(i.claim.id));
      const direct = amendments ? impacts.filter((i) => i.claim.category === "DIRECT" && ["INVALIDATED", "REJECTED"].includes(i.impact.state) && !hasLive(i.claim.id)) : [];
      const verified = new Set(proposals.filter((p) => p.status === "VERIFIED").map((p) => p.claimId));
      const derivedReady = amendments
        ? impacts.filter((i) => {
            if (i.claim.category !== "DERIVED" || !["INVALIDATED", "REJECTED"].includes(i.impact.state) || hasLive(i.claim.id)) return false;
            const refs = [...JSON.stringify(i.claim.formula).matchAll(/"ref":"([0-9a-f-]{36})"/g)].map((m) => m[1]!);
            return refs.length > 0 && refs.every((r) => verified.has(r));
          })
        : [];
      const work = [...candidates, ...direct, ...derivedReady];
      if (!work.length) continue;
      const rounds = await db.$count(agentRun, and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.role, "impact-analyst"), eq(agentRun.caseId, caseRow.id), eq(agentRun.epoch, caseRow.evidenceEpoch), eq(agentRun.status, "COMPLETED"), sql`${agentRun.taskKey} like 'replace:%'`));
      const roundKeys = await db.$count(agentRun, and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.role, "impact-analyst"), eq(agentRun.caseId, caseRow.id), eq(agentRun.epoch, caseRow.evidenceEpoch), sql`${agentRun.taskKey} like 'replace:%'`));
      if (rounds >= 3) continue;
      tasks.push({
        kind: "propose_replacements",
        key: `replace:${caseRow.id}:${caseRow.evidenceEpoch}:round${roundKeys + 1}`,
        caseId: caseRow.id,
        epoch: caseRow.evidenceEpoch,
        trigger: type,
        message: `Case ${caseRow.id} needs replacement proposals on evidence revision ${caseRow.evidenceEpoch}. Claims to handle: ${JSON.stringify(work.map((w) => ({ claimId: w.claim.id, label: w.claim.label, category: w.claim.category, classification: w.impact.classification, state: w.impact.state, text: w.claim.text })))}. Rejected proposals and open challenges are listed in get_case; address them. For DIRECT claims call find_fact_candidates once with all their claim ids, then propose the as-restated fact from the linked amendment (or "unchanged" if the amended value is the same). For DERIVED claims propose kind "formula". For candidate claims propose "unaffected" only if the text has no figures and relies on none.`,
      });
    }
  }

  if (role === "publication-editor") {
    if (type === "report.warning_applied" && payload.warningType === "NON_RELIANCE" && caseId) {
      tasks.push({ kind: "write_warning", key: `warning:${String(payload.reportId)}:${caseId}`, caseId, epoch: await caseEpoch(caseId), trigger: type, message: `A non-reliance warning was applied to report ${String(payload.reportId)} (case ${caseId}). Read the case with get_case and write a short reader-facing explanation with propose_warning_text: what the issuer disclosed, that corrected figures are not yet available if no amendment is linked, and that the original text stays visible. No figures.` });
    }
    const conclusionChallenges = await db
      .select({ challenge, draft: researchRevision })
      .from(challenge)
      .innerJoin(researchRevision, sql`${researchRevision.id}::text = ${challenge.targetId}`)
      .where(and(eq(challenge.workspaceId, workspaceId), eq(challenge.targetKind, "candidate_conclusion"), eq(challenge.status, "OPEN"), inArray(researchRevision.candidateState, ["READY", "BLOCKED", "CHECKING"])));
    const blockedDrafts = await db
      .select()
      .from(researchRevision)
      .where(and(eq(researchRevision.workspaceId, workspaceId), eq(researchRevision.kind, "candidate"), eq(researchRevision.candidateState, "BLOCKED")));
    for (const draft of blockedDrafts) {
      const meta = (draft.noticeDraft ?? {}) as { blockers?: string[] };
      const unwritten = (meta.blockers ?? []).filter((b) => b.includes("has not been rewritten"));
      if (!unwritten.length || !draft.caseId) continue;
      const epoch = await caseEpoch(draft.caseId);
      const draftsThisRevision = await db.$count(researchRevision, and(eq(researchRevision.reportId, draft.reportId), eq(researchRevision.kind, "candidate"), eq(researchRevision.caseId, draft.caseId), sql`${researchRevision.epochVector} @> ${JSON.stringify([{ caseId: draft.caseId, epoch }])}::jsonb`));
      if (draftsThisRevision >= 3) continue;
      tasks.push({ kind: "revise_draft", key: `revise-unwritten:${draft.id}`, caseId: draft.caseId, epoch, trigger: type, message: `Your draft ${draft.id} for report ${draft.reportId} is blocked: ${unwritten.join("; ")}. Read the note with get_report_for_editing and submit a revised propose_revision_patch that keeps your earlier changes and also rewrites those blocks so they are true on the verified figures.` });
    }
    for (const { challenge: raised, draft } of conclusionChallenges) {
      tasks.push({ kind: "revise_draft", key: `revise-conclusion:${raised.id}`, caseId: raised.caseId, epoch: await caseEpoch(raised.caseId), trigger: type, message: `The Financial Verifier found the conclusions in your draft ${draft.id} for report ${draft.reportId} inconsistent with the verified figures: "${raised.explanation}". Read the figures with get_draft_for_review and the note with get_report_for_editing, then submit a corrected propose_revision_patch whose conclusions and notice follow from the verified values.` });
    }
    if (type === "report.changes_requested") {
      tasks.push({ kind: "revise_draft", key: `revise:${String(payload.reviewId)}`, caseId, epoch: caseId ? await caseEpoch(caseId) : null, trigger: type, message: `A human editor requested changes to draft ${String(payload.candidateId)} for report ${String(payload.reportId)}: "${String(payload.notes ?? "")}". Read the report with get_report_for_editing and submit a revised propose_revision_patch that addresses the notes.` });
    }
    for (const caseRow of openCases.filter((c) => c.scopeConfirmed)) {
      const impacts = await db.select({ impact: claimImpact, claim }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(eq(claimImpact.caseId, caseRow.id));
      const reportIds = [...new Set(impacts.filter((i) => i.claim.material && i.impact.classification !== "candidate").map((i) => i.impact.reportId))];
      for (const reportId of reportIds) {
        const forReport = impacts.filter((i) => i.impact.reportId === reportId && i.claim.material);
        const ready = forReport.filter((i) => i.claim.category !== "QUALITATIVE").every((i) => ["VERIFIED_REPLACEMENT", "UNCHANGED_VERIFIED"].includes(i.impact.state));
        if (!ready) continue;
        const report = await db.query.researchReport.findFirst({ where: eq(researchReport.id, reportId) });
        const live = await db.$count(researchRevision, and(eq(researchRevision.reportId, reportId), eq(researchRevision.caseId, caseRow.id), eq(researchRevision.baseRevisionId, report!.currentRevisionId!), inArray(researchRevision.candidateState, ["CHECKING", "READY", "APPROVED", "BLOCKED", "CHANGES_REQUESTED"])));
        const published = await db.$count(researchRevision, and(eq(researchRevision.reportId, reportId), eq(researchRevision.caseId, caseRow.id), eq(researchRevision.documentState, "PUBLISHED")));
        if (live || published) continue;
        tasks.push({ kind: "draft_revision", key: `draft:${reportId}:${caseRow.id}:${caseRow.evidenceEpoch}`, caseId: caseRow.id, epoch: caseRow.evidenceEpoch, trigger: type, message: `Every affected figure in report ${reportId} ("${report!.title}") now has a verified replacement on evidence revision ${caseRow.evidenceEpoch} of case ${caseRow.id}. Read it with get_report_for_editing, then draft the corrected version with propose_revision_patch: rewrite only blocks that hold affected claims, use {{claim:<id>}} for corrected figures and {{previous:<id>}} for original ones, rewrite any affected conclusion so it is true on the restated figures, and write the correction notice.` });
      }
    }
  }
  return tasks;
}

const runtimes = new Map<string, Promise<WorkspaceRuntime>>();

/**
 * A loop interrupted by a restart is relaunched as its next attempt. Only restarts count toward this cap, since a
 * restart is not the loop's failure, and the cap stops a loop that keeps crashing the process from restarting forever.
 */
const MAX_RESTARTS_PER_TASK = 3;

/** Brings back the runtime of every unexpired workspace that had a loop running when the process stopped. */
export async function resumeInterruptedWorkspaces(): Promise<number> {
  const rows = await db
    .selectDistinct({ id: workspace.id })
    .from(agentRun)
    .innerJoin(workspace, eq(workspace.id, agentRun.workspaceId))
    .where(and(eq(agentRun.status, "STARTED"), or(isNull(workspace.expiresAt), gt(workspace.expiresAt, new Date()))));
  for (const row of rows) await runtimeFor(row.id);
  return rows.length;
}

export async function runtimeFor(workspaceId: string): Promise<WorkspaceRuntime> {
  let pending = runtimes.get(workspaceId);
  if (!pending) {
    pending = (async () => {
      const runtime = new WorkspaceRuntime(workspaceId);
      await runtime.start();
      return runtime;
    })();
    runtimes.set(workspaceId, pending);
    pending.catch(() => runtimes.delete(workspaceId));
  }
  return pending;
}

export function activeRuntimes(): number {
  return runtimes.size;
}

