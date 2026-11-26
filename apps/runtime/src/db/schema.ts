import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" });

export const workspaceMode = pgEnum("workspace_mode", ["replay", "live"]);
export const principalRole = pgEnum("principal_role", ["analyst", "editor", "operator", "reader"]);
export const sourceColumn = pgEnum("source_column", ["as_reported", "adjustment", "as_restated", "ordinary", "unknown"]);
export const claimCategory = pgEnum("claim_category", ["DIRECT", "DERIVED", "QUALITATIVE", "OTHER", "UNRESOLVED"]);
export const bindingState = pgEnum("binding_state", ["UNMAPPED", "PROPOSED", "BOUND", "AMBIGUOUS"]);
export const caseStatus = pgEnum("case_status", [
  "DISCOVERED",
  "INVESTIGATING",
  "AWAITING_EVIDENCE",
  "VERIFYING",
  "NEEDS_REVIEW",
  "READY_FOR_APPROVAL",
  "PARTIALLY_REISSUED",
  "RESOLVED",
  "NOT_APPLICABLE",
  "FAILED",
]);
export const impactState = pgEnum("impact_state", [
  "RELIABLE_AT_PUBLICATION",
  "UNDER_REVIEW",
  "INVALIDATED",
  "REPLACEMENT_PROPOSED",
  "VERIFIED_REPLACEMENT",
  "REJECTED",
  "UNRESOLVED",
  "UNCHANGED_VERIFIED",
  "UNAFFECTED",
]);
export const documentState = pgEnum("document_state", ["DRAFT", "PUBLISHED", "SUPERSEDED", "WITHDRAWN"]);
export const reliabilityState = pgEnum("reliability_state", ["CLEAR", "UNDER_REVIEW", "NON_RELIANCE", "SUPERSEDED", "WITHDRAWN"]);
export const candidateState = pgEnum("candidate_state", [
  "DRAFT",
  "CHECKING",
  "BLOCKED",
  "READY",
  "APPROVED",
  "PUBLISHED",
  "CHANGES_REQUESTED",
  "EXPIRED",
]);
export const deliveryState = pgEnum("delivery_state", ["QUEUED", "PROCESSING", "SIMULATED_DELIVERED", "FAILED", "CANCELLED"]);
export const jobState = pgEnum("job_state", ["PENDING", "RUNNING", "DONE", "FAILED", "DEAD"]);
export const agentRunState = pgEnum("agent_run_state", ["STARTED", "COMPLETED", "FAILED", "TIMED_OUT", "STALE", "CANCELLED"]);

export const workspace = pgTable(
  "workspace",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    mode: workspaceMode("mode").notNull(),
    scenarioId: text("scenario_id"),
    runId: uuid("run_id").notNull().defaultRandom(),
    logicalTime: ts("logical_time"),
    replayPosition: integer("replay_position").notNull().default(0),
    isReference: boolean("is_reference").notNull().default(false),
    expiresAt: ts("expires_at"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull().default(sql`0`),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspace_slug_uq").on(t.slug)],
);

export const demoPrincipal = pgTable(
  "demo_principal",
  {
    id: id(),
    workspaceId: workspaceRef(),
    role: principalRole("role").notNull(),
    displayName: text("display_name").notNull(),
    sessionHash: text("session_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("demo_principal_session_uq").on(t.sessionHash), index("demo_principal_ws_idx").on(t.workspaceId)],
);

export const issuer = pgTable(
  "issuer",
  {
    cik: text("cik").primaryKey(),
    legalName: text("legal_name").notNull(),
    aliases: jsonb("aliases").$type<{ name: string; ticker?: string; from?: string; to?: string }[]>().notNull().default([]),
    verifiedAt: ts("verified_at"),
  },
  (t) => [check("issuer_cik_10", sql`${t.cik} ~ '^[0-9]{10}$'`)],
);

export const watchSubscription = pgTable(
  "watch_subscription",
  {
    id: id(),
    workspaceId: workspaceRef(),
    cik: text("cik")
      .notNull()
      .references(() => issuer.cik),
    active: boolean("active").notNull().default(true),
    forms: jsonb("forms").$type<string[]>().notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(900),
    lastCheckedAt: ts("last_checked_at"),
    lastSuccessAt: ts("last_success_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("watch_ws_cik_uq").on(t.workspaceId, t.cik), check("watch_interval_min", sql`${t.intervalSeconds} >= 300`)],
);

export const sourceDocument = pgTable(
  "source_document",
  {
    id: id(),
    cik: text("cik")
      .notNull()
      .references(() => issuer.cik),
    accession: text("accession").notNull(),
    form: text("form").notNull(),
    reportDate: text("report_date"),
    filedDate: text("filed_date").notNull(),
    acceptedAt: ts("accepted_at"),
    availabilityPrecision: text("availability_precision").notNull(),
    url: text("url").notNull(),
    retrievedAt: ts("retrieved_at").notNull(),
    retrievalMode: text("retrieval_mode").notNull(),
    contentType: text("content_type").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    storageRef: text("storage_ref").notNull(),
    parseVersion: text("parse_version"),
    conflict: boolean("conflict").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("source_accession_hash_uq").on(t.accession, t.sha256),
    index("source_cik_form_idx").on(t.cik, t.form, t.acceptedAt),
  ],
);

export const workspaceSource = pgTable(
  "workspace_source",
  {
    workspaceId: workspaceRef(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourceDocument.id),
    availableAt: ts("available_at").notNull(),
    eligible: boolean("eligible").notNull().default(false),
    eventId: uuid("event_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.sourceId] }), index("ws_source_avail_idx").on(t.workspaceId, t.availableAt)],
);

export const sourceLocator = pgTable(
  "source_locator",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourceDocument.id),
    kind: text("kind").notNull(),
    path: jsonb("path").$type<Record<string, unknown>>().notNull(),
    excerpt: text("excerpt").notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    xbrlFactId: text("xbrl_fact_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("locator_source_hash_uq").on(t.sourceId, t.kind, t.excerptHash), index("locator_source_idx").on(t.sourceId)],
);

export const financialFact = pgTable(
  "financial_fact",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourceDocument.id),
    locatorId: uuid("locator_id")
      .notNull()
      .references(() => sourceLocator.id),
    issuerCik: text("issuer_cik").notNull(),
    conceptId: text("concept_id").notNull(),
    label: text("label").notNull(),
    statementType: text("statement_type").notNull(),
    periodType: text("period_type").notNull(),
    periodStart: text("period_start"),
    periodEnd: text("period_end").notNull(),
    dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default({}),
    scope: text("scope").notNull(),
    unit: text("unit").notNull(),
    currency: text("currency"),
    scale: integer("scale").notNull(),
    rawText: text("raw_text").notNull(),
    value: numeric("value", { precision: 40, scale: 10 }),
    sourceColumn: sourceColumn("source_column").notNull(),
    semanticKey: text("semantic_key").notNull(),
    extractionMethod: text("extraction_method").notNull(),
    parseVersion: text("parse_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("fact_semantic_idx").on(t.semanticKey, t.sourceColumn),
    index("fact_source_idx").on(t.sourceId),
    uniqueIndex("fact_locator_column_uq").on(t.locatorId, t.sourceColumn, t.conceptId),
    check("fact_period_type", sql`${t.periodType} in ('instant','duration')`),
  ],
);

export const researchReport = pgTable(
  "research_report",
  {
    id: id(),
    workspaceId: workspaceRef(),
    publicId: text("public_id").notNull(),
    title: text("title").notNull(),
    issuerCiks: jsonb("issuer_ciks").$type<string[]>().notNull(),
    currentRevisionId: uuid("current_revision_id"),
    documentState: documentState("document_state").notNull().default("DRAFT"),
    reliability: reliabilityState("reliability").notNull().default("CLEAR"),
    publicVisible: boolean("public_visible").notNull().default(true),
    synthetic: boolean("synthetic").notNull().default(true),
    publisherName: text("publisher_name").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("report_public_id_uq").on(t.publicId), index("report_ws_idx").on(t.workspaceId, t.updatedAt)],
);

export type Block = { id: string; kind: "heading" | "paragraph" | "table" | "list"; text: string; level?: number; rows?: string[][] };

export const researchRevision = pgTable(
  "research_revision",
  {
    id: id(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    baseRevisionId: uuid("base_revision_id"),
    version: integer("version"),
    kind: text("kind").notNull(),
    blocks: jsonb("blocks").$type<Block[]>().notNull(),
    markdown: text("markdown").notNull(),
    contentHash: text("content_hash").notNull(),
    asOf: ts("as_of").notNull(),
    sourceRefs: jsonb("source_refs").$type<string[]>().notNull().default([]),
    epochVector: jsonb("epoch_vector").$type<{ caseId: string; epoch: number }[]>().notNull().default([]),
    candidateState: candidateState("candidate_state"),
    documentState: documentState("document_state").notNull().default("DRAFT"),
    approvalId: uuid("approval_id"),
    caseId: uuid("case_id"),
    noticeDraft: jsonb("notice_draft").$type<Record<string, unknown>>(),
    publishedAt: ts("published_at"),
    publicationLabel: text("publication_label"),
    createdBy: text("created_by").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("revision_report_version_uq").on(t.reportId, t.version),
    index("revision_report_idx").on(t.reportId, t.createdAt),
  ],
);

export const claim = pgTable(
  "claim",
  {
    id: id(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => researchRevision.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    lineageId: uuid("lineage_id").notNull(),
    blockId: text("block_id").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    category: claimCategory("category").notNull(),
    text: text("text").notNull(),
    label: text("label").notNull(),
    material: boolean("material").notNull(),
    semanticKey: text("semantic_key"),
    bindingState: bindingState("binding_state").notNull(),
    formula: jsonb("formula").$type<unknown>(),
    displayPrecision: integer("display_precision"),
    displayUnit: text("display_unit"),
    valueDecimal: numeric("value_decimal", { precision: 40, scale: 10 }),
    reason: text("reason"),
    creationMethod: text("creation_method").notNull(),
    proposedBy: text("proposed_by").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("claim_revision_idx").on(t.revisionId),
    index("claim_lineage_idx").on(t.lineageId),
    check("claim_range", sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`),
  ],
);

export const claimBinding = pgTable(
  "claim_binding",
  {
    id: id(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    kind: text("kind").notNull(),
    factId: uuid("fact_id").references(() => financialFact.id),
    refClaimId: uuid("ref_claim_id").references(() => claim.id),
    justification: text("justification").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("binding_claim_idx").on(t.claimId), index("binding_fact_idx").on(t.factId)],
);

export const claimDependency = pgTable(
  "claim_dependency",
  {
    id: id(),
    workspaceId: workspaceRef(),
    fromNode: text("from_node").notNull(),
    toNode: text("to_node").notNull(),
    type: text("type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("dependency_edge_uq").on(t.workspaceId, t.fromNode, t.toNode, t.type),
    index("dependency_to_idx").on(t.workspaceId, t.toNode),
    index("dependency_from_idx").on(t.workspaceId, t.fromNode),
  ],
);

export const disclosureEvent = pgTable(
  "disclosure_event",
  {
    id: id(),
    workspaceId: workspaceRef(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourceDocument.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown>>(),
    evidenceLocatorIds: jsonb("evidence_locator_ids").$type<string[]>().notNull().default([]),
    proposedBy: text("proposed_by"),
    confirmedBy: text("confirmed_by"),
    reason: text("reason"),
    eventKey: text("event_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("disclosure_event_key_uq").on(t.workspaceId, t.eventKey)],
);

export const correctionCase = pgTable(
  "correction_case",
  {
    id: id(),
    workspaceId: workspaceRef(),
    issuerCik: text("issuer_cik").notNull(),
    originEventId: uuid("origin_event_id")
      .notNull()
      .references(() => disclosureEvent.id),
    status: caseStatus("status").notNull(),
    evidenceEpoch: integer("evidence_epoch").notNull().default(1),
    rowVersion: integer("row_version").notNull().default(1),
    title: text("title").notNull(),
    scope: jsonb("scope").$type<{ periods: { start: string | null; end: string; type: string; label: string }[] } | null>(),
    scopeConfirmed: boolean("scope_confirmed").notNull().default(false),
    openedAt: ts("opened_at").notNull().defaultNow(),
    lastUpdatedAt: ts("last_updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("case_origin_uq").on(t.workspaceId, t.originEventId),
    index("case_ws_status_idx").on(t.workspaceId, t.status, t.lastUpdatedAt),
    check("case_epoch_positive", sql`${t.evidenceEpoch} >= 1`),
  ],
);

export const caseSource = pgTable(
  "case_source",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => correctionCase.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourceDocument.id),
    relation: text("relation").notNull(),
    evidenceEpoch: integer("evidence_epoch").notNull(),
    linkedBy: text("linked_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.sourceId, t.relation] })],
);

export const claimImpact = pgTable(
  "claim_impact",
  {
    id: id(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => correctionCase.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id),
    classification: text("classification").notNull(),
    path: jsonb("path").$type<string[]>().notNull(),
    reason: text("reason").notNull(),
    state: impactState("state").notNull(),
    epoch: integer("epoch").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("impact_case_claim_uq").on(t.caseId, t.claimId), index("impact_case_state_idx").on(t.caseId, t.state)],
);

export const reportWarning = pgTable(
  "report_warning",
  {
    id: id(),
    workspaceId: workspaceRef(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => researchRevision.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => correctionCase.id),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    headline: text("headline").notNull(),
    detail: text("detail").notNull(),
    state: text("state").notNull(),
    appliedAt: ts("applied_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    uniqueIndex("warning_active_uq").on(t.revisionId, t.caseId, t.type),
    index("warning_report_idx").on(t.reportId, t.state),
  ],
);

export const replacementProposal = pgTable(
  "replacement_proposal",
  {
    id: id(),
    workspaceId: workspaceRef(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => correctionCase.id),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id),
    epoch: integer("epoch").notNull(),
    proposerAgent: text("proposer_agent").notNull(),
    agentRunId: uuid("agent_run_id"),
    kind: text("kind").notNull(),
    factIds: jsonb("fact_ids").$type<string[]>().notNull().default([]),
    formula: jsonb("formula").$type<unknown>(),
    value: numeric("value", { precision: 40, scale: 10 }),
    rationale: text("rationale").notNull(),
    sourceHashes: jsonb("source_hashes").$type<string[]>().notNull().default([]),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("proposal_case_claim_idx").on(t.caseId, t.claimId, t.epoch)],
);

export const verificationAttestation = pgTable(
  "verification_attestation",
  {
    id: id(),
    workspaceId: workspaceRef(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => replacementProposal.id),
    epoch: integer("epoch").notNull(),
    verifierAgent: text("verifier_agent").notNull(),
    agentRunId: uuid("agent_run_id"),
    verdict: text("verdict").notNull(),
    independentFactIds: jsonb("independent_fact_ids").$type<string[]>().notNull().default([]),
    independentValue: numeric("independent_value", { precision: 40, scale: 10 }),
    comparison: jsonb("comparison").$type<Record<string, unknown>>().notNull(),
    sourceHashes: jsonb("source_hashes").$type<string[]>().notNull().default([]),
    calcVersion: text("calc_version").notNull(),
    deterministicChecks: jsonb("deterministic_checks").$type<{ name: string; ok: boolean; detail: string }[]>().notNull(),
    rationale: text("rationale").notNull(),
    traceId: text("trace_id"),
    valid: boolean("valid").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("attestation_proposal_idx").on(t.proposalId, t.epoch)],
);

export const challenge = pgTable(
  "challenge",
  {
    id: id(),
    workspaceId: workspaceRef(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => correctionCase.id),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    epoch: integer("epoch").notNull(),
    raisedBy: text("raised_by").notNull(),
    reasonCode: text("reason_code").notNull(),
    explanation: text("explanation").notNull(),
    refs: jsonb("refs").$type<string[]>().notNull().default([]),
    status: text("status").notNull(),
    resolution: text("resolution"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("challenge_case_idx").on(t.caseId, t.status)],
);

export const calculation = pgTable("calculation", {
  id: id(),
  workspaceId: workspaceRef(),
  claimId: uuid("claim_id").references(() => claim.id),
  proposalId: uuid("proposal_id").references(() => replacementProposal.id),
  ast: jsonb("ast").$type<unknown>().notNull(),
  inputs: jsonb("inputs").$type<{ ref: string; value: string; unit: string }[]>().notNull(),
  exactResult: text("exact_result"),
  unit: text("unit"),
  rounding: text("rounding").notNull(),
  calcVersion: text("calc_version").notNull(),
  error: text("error"),
  createdAt: createdAt(),
});

export const editorialReview = pgTable("editorial_review", {
  id: id(),
  workspaceId: workspaceRef(),
  candidateId: uuid("candidate_id")
    .notNull()
    .references(() => researchRevision.id),
  actorId: uuid("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  decision: text("decision").notNull(),
  contentHash: text("content_hash").notNull(),
  epochVector: jsonb("epoch_vector").$type<{ caseId: string; epoch: number }[]>().notNull(),
  baseRevisionId: uuid("base_revision_id").notNull(),
  notes: text("notes"),
  valid: boolean("valid").notNull().default(true),
  createdAt: createdAt(),
});

export const publicationStatusEvent = pgTable(
  "publication_status_event",
  {
    id: id(),
    workspaceId: workspaceRef(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id),
    revisionId: uuid("revision_id"),
    type: text("type").notNull(),
    caseId: uuid("case_id"),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("pub_status_report_idx").on(t.reportId, t.occurredAt)],
);

export const correctionNotice = pgTable(
  "correction_notice",
  {
    id: id(),
    workspaceId: workspaceRef(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id),
    previousRevisionId: uuid("previous_revision_id")
      .notNull()
      .references(() => researchRevision.id),
    replacementRevisionId: uuid("replacement_revision_id").references(() => researchRevision.id),
    caseIds: jsonb("case_ids").$type<string[]>().notNull(),
    type: text("type").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    approvalId: uuid("approval_id"),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [index("notice_report_idx").on(t.reportId, t.publishedAt)],
);

export const artifactExport = pgTable(
  "artifact_export",
  {
    id: id(),
    workspaceId: workspaceRef(),
    revisionId: uuid("revision_id").references(() => researchRevision.id),
    noticeId: uuid("notice_id").references(() => correctionNotice.id),
    overlayVersion: text("overlay_version").notNull(),
    format: text("format").notNull(),
    filename: text("filename").notNull(),
    storageRef: text("storage_ref"),
    sha256: text("sha256"),
    bytes: integer("bytes"),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("export_key_uq").on(t.workspaceId, t.revisionId, t.noticeId, t.format, t.overlayVersion)],
);

export const syntheticRecipient = pgTable(
  "synthetic_recipient",
  {
    id: id(),
    workspaceId: workspaceRef(),
    displayName: text("display_name").notNull(),
    organisation: text("organisation").notNull(),
    address: text("address").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenHint: text("token_hint").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("recipient_token_uq").on(t.tokenHash), check("recipient_invalid_domain", sql`${t.address} like '%.invalid'`)],
);

export const publicationRecipient = pgTable(
  "publication_recipient",
  {
    reportId: uuid("report_id")
      .notNull()
      .references(() => researchReport.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => syntheticRecipient.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    originalVersion: integer("original_version"),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.recipientId] })],
);

export const delivery = pgTable(
  "delivery",
  {
    id: id(),
    workspaceId: workspaceRef(),
    noticeId: uuid("notice_id").references(() => correctionNotice.id),
    revisionId: uuid("revision_id").references(() => researchRevision.id),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => syntheticRecipient.id),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    logicalKey: text("logical_key").notNull(),
    status: deliveryState("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    deliveredAt: ts("delivered_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("delivery_logical_key_uq").on(t.logicalKey), index("delivery_ws_status_idx").on(t.workspaceId, t.status)],
);

export const deliveryAttempt = pgTable(
  "delivery_attempt",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => delivery.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [uniqueIndex("delivery_attempt_uq").on(t.deliveryId, t.attempt)],
);

export const runtimeSession = pgTable(
  "runtime_session",
  {
    id: id(),
    workspaceId: workspaceRef(),
    sdkVersion: text("sdk_version").notNull(),
    model: text("model").notNull(),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull(),
    leaseHolder: text("lease_holder").notNull(),
    leaseUntil: ts("lease_until").notNull(),
    status: text("status").notNull(),
    heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("runtime_session_ws_idx").on(t.workspaceId, t.status)],
);

export const agentRun = pgTable(
  "agent_run",
  {
    id: id(),
    workspaceId: workspaceRef(),
    runtimeSessionId: uuid("runtime_session_id")
      .notNull()
      .references(() => runtimeSession.id),
    nativeAgentId: text("native_agent_id").notNull(),
    nativeLoopId: text("native_loop_id"),
    cloudSessionUrl: text("cloud_session_url"),
    role: text("role").notNull(),
    caseId: uuid("case_id"),
    epoch: integer("epoch"),
    taskKey: text("task_key").notNull(),
    trigger: text("trigger").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: agentRunState("status").notNull(),
    summary: text("summary"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    model: text("model").notNull(),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    heartbeatAt: ts("heartbeat_at").notNull(),
  },
  (t) => [index("agent_run_ws_idx").on(t.workspaceId, t.startedAt), index("agent_run_case_idx").on(t.caseId, t.status)],
);

export const toolCall = pgTable(
  "tool_call",
  {
    id: id(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRun.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    inputSummary: text("input_summary").notNull(),
    ok: boolean("ok").notNull(),
    errorCode: text("error_code"),
    sourceRefs: jsonb("source_refs").$type<string[]>().notNull().default([]),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at").notNull(),
  },
  (t) => [index("tool_call_run_idx").on(t.agentRunId)],
);

export const domainEvent = pgTable(
  "domain_event",
  {
    id: id(),
    workspaceId: workspaceRef(),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    caseId: uuid("case_id"),
    evidenceEpoch: integer("evidence_epoch"),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: ts("occurred_at").notNull(),
    committedAt: ts("committed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("domain_event_seq_uq").on(t.workspaceId, t.seq), index("domain_event_case_idx").on(t.caseId, t.seq)],
);

export const outboxJob = pgTable(
  "outbox_job",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    eventId: uuid("event_id"),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    dueAt: ts("due_at").notNull().defaultNow(),
    leaseUntil: ts("lease_until"),
    leaseToken: uuid("lease_token"),
    status: jobState("status").notNull().default("PENDING"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("outbox_dedupe_uq").on(t.dedupeKey), index("outbox_due_idx").on(t.status, t.dueAt)],
);

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    statusCode: integer("status_code").notNull(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.operation, t.key] })],
);

export const evaluationRun = pgTable("evaluation_run", {
  id: id(),
  scenarioId: text("scenario_id").notNull(),
  workspaceId: uuid("workspace_id"),
  corpusHash: text("corpus_hash").notNull(),
  buildCommit: text("build_commit").notNull(),
  sdkVersion: text("sdk_version").notNull(),
  model: text("model").notNull(),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  results: jsonb("results").$type<Record<string, unknown>>(),
  failures: jsonb("failures").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
});
