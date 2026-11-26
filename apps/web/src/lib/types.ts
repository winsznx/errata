export type Role = "analyst" | "editor" | "operator" | "reader";

export interface Principal {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  role: Role;
  displayName: string;
}

export interface DomainEventView {
  id: string;
  seq: string;
  type: string;
  actor: { kind: string; id: string };
  caseId: string | null;
  evidenceEpoch: number | null;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  committedAt: string;
}

export interface Period {
  start: string | null;
  end: string;
  type: string;
  label: string;
}

export interface CaseRow {
  id: string;
  title: string;
  issuerCik: string;
  status: string;
  evidenceEpoch: number;
  scopeConfirmed: boolean;
  periods: Period[];
  openedAt: string;
  lastUpdatedAt: string;
  affectedClaims?: number;
  affectedReports?: number;
  openChallenges?: number;
}

export interface ReportRow {
  id: string;
  publicId: string;
  title: string;
  issuerCiks: string[];
  documentState: string;
  reliability: string;
  synthetic: boolean;
  publisherName: string;
  updatedAt: string;
}

export interface Overview {
  workspace: { id: string; slug: string; name: string; mode: string; logicalTime: string | null; isReference: boolean; expiresAt: string | null; eventSeq: string };
  scenario: { id: string; label: string; description: string; position: number; total: number; next: { label: string } | null; faults: { type: string; label: string }[] } | null;
  counts: { activeCases: number; reportsAtRisk: number; activeWarnings: number; pendingApprovals: number; runningAgents: number; publishedReports: number };
  cases: CaseRow[];
  reports: ReportRow[];
  watchlist: { cik: string; name: string; active: boolean; lastCheckedAt: string | null; lastSuccessAt: string | null; lastError: string | null }[];
  recentEvents: DomainEventView[];
  runtime: { sessionId: string; sdkVersion: string; model: string; heartbeatAt: string; status: string } | null;
  principal: Principal;
}

export interface Block {
  id: string;
  kind: "heading" | "paragraph" | "table" | "list";
  text: string;
  level?: number;
  rows?: string[][];
}

export interface ClaimSource {
  accession: string;
  form: string;
  url: string;
  concept: string;
  periodEnd: string;
  column: string;
  printed: string;
  locatorId: string;
}

export interface ClaimView {
  id: string;
  blockId: string;
  start: number;
  end: number;
  category: string;
  label: string;
  text: string;
  material: boolean;
  bindingState?: string;
  creationMethod?: string;
  value: string | null;
  sources: ClaimSource[];
  derivedFrom: { claimId: string | null; kind: string }[];
  formula: unknown;
}

export interface Warning {
  id: string;
  type: string;
  severity: string;
  headline: string;
  detail: string;
  caseId?: string;
  appliedAt: string;
}

export interface NoticeChange {
  claimId: string;
  label: string;
  previous: string;
  replacement: string;
  delta: string;
  kind: string;
  sources: { accession: string; form: string; url: string; column: string }[];
}

export interface RevisionView {
  id: string;
  reportId: string;
  version: number | null;
  kind: string;
  documentState: string;
  candidateState: string | null;
  asOf: string;
  publishedAt: string | null;
  publicationLabel: string | null;
  contentHash: string;
  blocks: Block[];
  warnings: Warning[];
  sources: { id: string; accession: string; form: string; filedDate: string; url: string }[];
  claims: ClaimView[];
  epochVector?: { caseId: string; epoch: number }[];
  notice?: { notice?: { whatChanged: string; why: string; conclusions: string }; changes?: NoticeChange[]; blockers?: string[]; patchedBlockIds?: string[] } | null;
  baseRevisionId?: string | null;
  caseId?: string | null;
  createdBy?: string;
}

export interface ImpactRow {
  impactId: string;
  claimId: string;
  reportId: string;
  reportTitle: string;
  publicId: string;
  label: string;
  category: string;
  classification: string;
  material: boolean;
  state: string;
  reason: string;
  path: string[];
  original: { text: string; value: string | null; unit: string | null; precision: number | null };
  replacement: {
    proposalId: string;
    kind: string;
    status: string;
    value: string | null;
    proposedValue: string | null;
    proposer: string;
    source: { accession: string; form: string; url: string; column: string; printed: string; label: string; locatorId: string } | null;
  } | null;
}

export interface AgentRunView {
  id: string;
  role: string;
  taskKey: string;
  trigger: { event?: string; kind?: string };
  status: string;
  outcome: string | null;
  summary: string | null;
  attempt: number;
  epoch: number | null;
  caseId: string | null;
  nativeAgentId: string;
  nativeLoopId: string | null;
  cloudSessionUrl: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  heartbeatAt: string;
}

export interface CaseDetail {
  case: CaseRow;
  logicalTime: string | null;
  origin: { disclosureEventId: string; status: string; proposedBy: string | null; confirmedBy: string | null; source: { id: string; accession: string; form: string; filedDate: string; acceptedAt: string | null; url: string }; locatorIds: string[] } | null;
  linkedSources: { relation: string; epoch: number; linkedBy: string; source: { id: string; accession: string; form: string; filedDate: string; acceptedAt: string | null; url: string } }[];
  impacts: ImpactRow[];
  proposals: { id: string; claimId: string; epoch: number; kind: string; value: string | null; status: string; statusReason: string | null; proposer: string; agentRunId: string | null; rationale: string; createdAt: string }[];
  attestations: { id: string; proposalId: string; epoch: number; verifier: string; agentRunId: string | null; verdict: string; valid: boolean; independentValue: string | null; checks: { name: string; ok: boolean; detail: string }[]; rationale: string; sourceHashes: string[]; createdAt: string }[];
  challenges: { id: string; targetKind: string; targetId: string; epoch: number; raisedBy: string; reasonCode: string; explanation: string; status: string; resolution: string | null; createdAt: string }[];
  candidates: { id: string; reportId: string; state: string; contentHash: string; epochVector: { caseId: string; epoch: number }[]; createdAt: string; blockers: string[] }[];
  reissued: { id: string; reportId: string; version: number | null; publishedAt: string | null }[];
  agentRuns: AgentRunView[];
  timeline: DomainEventView[];
}

export interface Excerpt {
  locatorId: string;
  kind: string;
  source: { accession: string; form: string; filedDate: string; url: string };
  where: string;
  text?: string | null;
  tableContext?: string | null;
  scaleNote?: string;
  rowLabel?: string | null;
  cells?: { column: string; printed: string }[];
}
