CREATE TYPE "public"."agent_run_state" AS ENUM('STARTED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'STALE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."binding_state" AS ENUM('UNMAPPED', 'PROPOSED', 'BOUND', 'AMBIGUOUS');--> statement-breakpoint
CREATE TYPE "public"."candidate_state" AS ENUM('DRAFT', 'CHECKING', 'BLOCKED', 'READY', 'APPROVED', 'PUBLISHED', 'CHANGES_REQUESTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('DISCOVERED', 'INVESTIGATING', 'AWAITING_EVIDENCE', 'VERIFYING', 'NEEDS_REVIEW', 'READY_FOR_APPROVAL', 'PARTIALLY_REISSUED', 'RESOLVED', 'NOT_APPLICABLE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."claim_category" AS ENUM('DIRECT', 'DERIVED', 'QUALITATIVE', 'OTHER', 'UNRESOLVED');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('QUEUED', 'PROCESSING', 'SIMULATED_DELIVERED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."document_state" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."impact_state" AS ENUM('RELIABLE_AT_PUBLICATION', 'UNDER_REVIEW', 'INVALIDATED', 'REPLACEMENT_PROPOSED', 'VERIFIED_REPLACEMENT', 'REJECTED', 'UNRESOLVED', 'UNCHANGED_VERIFIED', 'UNAFFECTED');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."principal_role" AS ENUM('analyst', 'editor', 'operator', 'reader');--> statement-breakpoint
CREATE TYPE "public"."reliability_state" AS ENUM('CLEAR', 'UNDER_REVIEW', 'NON_RELIANCE', 'SUPERSEDED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."source_column" AS ENUM('as_reported', 'adjustment', 'as_restated', 'ordinary', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."workspace_mode" AS ENUM('replay', 'live');--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runtime_session_id" uuid NOT NULL,
	"native_agent_id" text NOT NULL,
	"native_loop_id" text,
	"cloud_session_url" text,
	"role" text NOT NULL,
	"case_id" uuid,
	"epoch" integer,
	"task_key" text NOT NULL,
	"trigger" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "agent_run_state" NOT NULL,
	"summary" text,
	"error_code" text,
	"error_message" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"model" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"revision_id" uuid,
	"notice_id" uuid,
	"overlay_version" text NOT NULL,
	"format" text NOT NULL,
	"filename" text NOT NULL,
	"storage_ref" text,
	"sha256" text,
	"bytes" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calculation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"claim_id" uuid,
	"proposal_id" uuid,
	"ast" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"exact_result" text,
	"unit" text,
	"rounding" text NOT NULL,
	"calc_version" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_source" (
	"case_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"evidence_epoch" integer NOT NULL,
	"linked_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_source_case_id_source_id_relation_pk" PRIMARY KEY("case_id","source_id","relation")
);
--> statement-breakpoint
CREATE TABLE "challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"raised_by" text NOT NULL,
	"reason_code" text NOT NULL,
	"explanation" text NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"category" "claim_category" NOT NULL,
	"text" text NOT NULL,
	"label" text NOT NULL,
	"material" boolean NOT NULL,
	"semantic_key" text,
	"binding_state" "binding_state" NOT NULL,
	"formula" jsonb,
	"display_precision" integer,
	"display_unit" text,
	"value_decimal" numeric(40, 10),
	"reason" text,
	"creation_method" text NOT NULL,
	"proposed_by" text NOT NULL,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_range" CHECK ("claim"."start_offset" >= 0 and "claim"."end_offset" > "claim"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "claim_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fact_id" uuid,
	"ref_claim_id" uuid,
	"justification" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_dependency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_node" text NOT NULL,
	"to_node" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_impact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"classification" text NOT NULL,
	"path" jsonb NOT NULL,
	"reason" text NOT NULL,
	"state" "impact_state" NOT NULL,
	"epoch" integer NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issuer_cik" text NOT NULL,
	"origin_event_id" uuid NOT NULL,
	"status" "case_status" NOT NULL,
	"evidence_epoch" integer DEFAULT 1 NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"scope" jsonb,
	"scope_confirmed" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_epoch_positive" CHECK ("correction_case"."evidence_epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE "correction_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"previous_revision_id" uuid NOT NULL,
	"replacement_revision_id" uuid,
	"case_ids" jsonb NOT NULL,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approval_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notice_id" uuid,
	"revision_id" uuid,
	"recipient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"logical_key" text NOT NULL,
	"status" "delivery_state" NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "demo_principal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "principal_role" NOT NULL,
	"display_name" text NOT NULL,
	"session_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disclosure_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"scope" jsonb,
	"evidence_locator_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_by" text,
	"confirmed_by" text,
	"reason" text,
	"event_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"case_id" uuid,
	"evidence_epoch" integer,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editorial_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_name" text NOT NULL,
	"decision" text NOT NULL,
	"content_hash" text NOT NULL,
	"epoch_vector" jsonb NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"notes" text,
	"valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" text NOT NULL,
	"workspace_id" uuid,
	"corpus_hash" text NOT NULL,
	"build_commit" text NOT NULL,
	"sdk_version" text NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"results" jsonb,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"locator_id" uuid NOT NULL,
	"issuer_cik" text NOT NULL,
	"concept_id" text NOT NULL,
	"label" text NOT NULL,
	"statement_type" text NOT NULL,
	"period_type" text NOT NULL,
	"period_start" text,
	"period_end" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text NOT NULL,
	"unit" text NOT NULL,
	"currency" text,
	"scale" integer NOT NULL,
	"raw_text" text NOT NULL,
	"value" numeric(40, 10),
	"source_column" "source_column" NOT NULL,
	"semantic_key" text NOT NULL,
	"extraction_method" text NOT NULL,
	"parse_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_period_type" CHECK ("financial_fact"."period_type" in ('instant','duration'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"workspace_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_workspace_id_operation_key_pk" PRIMARY KEY("workspace_id","operation","key")
);
--> statement-breakpoint
CREATE TABLE "issuer" (
	"cik" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "issuer_cik_10" CHECK ("issuer"."cik" ~ '^[0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"event_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"status" "job_state" DEFAULT 'PENDING' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_recipient" (
	"report_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"original_version" integer,
	CONSTRAINT "publication_recipient_report_id_recipient_id_pk" PRIMARY KEY("report_id","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "publication_status_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"revision_id" uuid,
	"type" text NOT NULL,
	"case_id" uuid,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replacement_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"proposer_agent" text NOT NULL,
	"agent_run_id" uuid,
	"kind" text NOT NULL,
	"fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"formula" jsonb,
	"value" numeric(40, 10),
	"rationale" text NOT NULL,
	"source_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_warning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"headline" text NOT NULL,
	"detail" text NOT NULL,
	"state" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"public_id" text NOT NULL,
	"title" text NOT NULL,
	"issuer_ciks" jsonb NOT NULL,
	"current_revision_id" uuid,
	"document_state" "document_state" DEFAULT 'DRAFT' NOT NULL,
	"reliability" "reliability_state" DEFAULT 'CLEAR' NOT NULL,
	"public_visible" boolean DEFAULT true NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"publisher_name" text NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_revision_id" uuid,
	"version" integer,
	"kind" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"epoch_vector" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_state" "candidate_state",
	"document_state" "document_state" DEFAULT 'DRAFT' NOT NULL,
	"approval_id" uuid,
	"case_id" uuid,
	"notice_draft" jsonb,
	"published_at" timestamp with time zone,
	"publication_label" text,
	"created_by" text NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sdk_version" text NOT NULL,
	"model" text NOT NULL,
	"lease_fence" bigint NOT NULL,
	"lease_holder" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cik" text NOT NULL,
	"accession" text NOT NULL,
	"form" text NOT NULL,
	"report_date" text,
	"filed_date" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"availability_precision" text NOT NULL,
	"url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"retrieval_mode" text NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"storage_ref" text NOT NULL,
	"parse_version" text,
	"conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_locator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" jsonb NOT NULL,
	"excerpt" text NOT NULL,
	"excerpt_hash" text NOT NULL,
	"xbrl_fact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "synthetic_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"organisation" text NOT NULL,
	"address" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipient_invalid_domain" CHECK ("synthetic_recipient"."address" like '%.invalid')
);
--> statement-breakpoint
CREATE TABLE "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"input_summary" text NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_attestation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"verifier_agent" text NOT NULL,
	"agent_run_id" uuid,
	"verdict" text NOT NULL,
	"independent_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"independent_value" numeric(40, 10),
	"comparison" jsonb NOT NULL,
	"source_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calc_version" text NOT NULL,
	"deterministic_checks" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"trace_id" text,
	"valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cik" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"forms" jsonb NOT NULL,
	"interval_seconds" integer DEFAULT 900 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_interval_min" CHECK ("watch_subscription"."interval_seconds" >= 300)
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"mode" "workspace_mode" NOT NULL,
	"scenario_id" text,
	"run_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"logical_time" timestamp with time zone,
	"replay_position" integer DEFAULT 0 NOT NULL,
	"is_reference" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_seq" bigint DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_source" (
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_source_workspace_id_source_id_pk" PRIMARY KEY("workspace_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_runtime_session_id_runtime_session_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "public"."runtime_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_export" ADD CONSTRAINT "artifact_export_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_export" ADD CONSTRAINT "artifact_export_revision_id_research_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_export" ADD CONSTRAINT "artifact_export_notice_id_correction_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."correction_notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculation" ADD CONSTRAINT "calculation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculation" ADD CONSTRAINT "calculation_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculation" ADD CONSTRAINT "calculation_proposal_id_replacement_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."replacement_proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_source" ADD CONSTRAINT "case_source_case_id_correction_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."correction_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_source" ADD CONSTRAINT "case_source_source_id_source_document_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_case_id_correction_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."correction_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_revision_id_research_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."research_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_binding" ADD CONSTRAINT "claim_binding_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_binding" ADD CONSTRAINT "claim_binding_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_binding" ADD CONSTRAINT "claim_binding_fact_id_financial_fact_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."financial_fact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_binding" ADD CONSTRAINT "claim_binding_ref_claim_id_claim_id_fk" FOREIGN KEY ("ref_claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_dependency" ADD CONSTRAINT "claim_dependency_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_impact" ADD CONSTRAINT "claim_impact_case_id_correction_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."correction_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_impact" ADD CONSTRAINT "claim_impact_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_impact" ADD CONSTRAINT "claim_impact_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_case" ADD CONSTRAINT "correction_case_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_case" ADD CONSTRAINT "correction_case_origin_event_id_disclosure_event_id_fk" FOREIGN KEY ("origin_event_id") REFERENCES "public"."disclosure_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notice" ADD CONSTRAINT "correction_notice_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notice" ADD CONSTRAINT "correction_notice_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notice" ADD CONSTRAINT "correction_notice_previous_revision_id_research_revision_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_notice" ADD CONSTRAINT "correction_notice_replacement_revision_id_research_revision_id_fk" FOREIGN KEY ("replacement_revision_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_notice_id_correction_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."correction_notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_revision_id_research_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_recipient_id_synthetic_recipient_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."synthetic_recipient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_delivery_id_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."delivery"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_principal" ADD CONSTRAINT "demo_principal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_event" ADD CONSTRAINT "disclosure_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_event" ADD CONSTRAINT "disclosure_event_source_id_source_document_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_review" ADD CONSTRAINT "editorial_review_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_review" ADD CONSTRAINT "editorial_review_candidate_id_research_revision_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_fact" ADD CONSTRAINT "financial_fact_source_id_source_document_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_fact" ADD CONSTRAINT "financial_fact_locator_id_source_locator_id_fk" FOREIGN KEY ("locator_id") REFERENCES "public"."source_locator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_job" ADD CONSTRAINT "outbox_job_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_recipient" ADD CONSTRAINT "publication_recipient_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_recipient" ADD CONSTRAINT "publication_recipient_recipient_id_synthetic_recipient_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."synthetic_recipient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_status_event" ADD CONSTRAINT "publication_status_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_status_event" ADD CONSTRAINT "publication_status_event_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_proposal" ADD CONSTRAINT "replacement_proposal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_proposal" ADD CONSTRAINT "replacement_proposal_case_id_correction_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."correction_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_proposal" ADD CONSTRAINT "replacement_proposal_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_warning" ADD CONSTRAINT "report_warning_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_warning" ADD CONSTRAINT "report_warning_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_warning" ADD CONSTRAINT "report_warning_revision_id_research_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."research_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_warning" ADD CONSTRAINT "report_warning_case_id_correction_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."correction_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_report" ADD CONSTRAINT "research_report_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_revision" ADD CONSTRAINT "research_revision_report_id_research_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_revision" ADD CONSTRAINT "research_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_session" ADD CONSTRAINT "runtime_session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_cik_issuer_cik_fk" FOREIGN KEY ("cik") REFERENCES "public"."issuer"("cik") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_locator" ADD CONSTRAINT "source_locator_source_id_source_document_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_recipient" ADD CONSTRAINT "synthetic_recipient_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attestation" ADD CONSTRAINT "verification_attestation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attestation" ADD CONSTRAINT "verification_attestation_proposal_id_replacement_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."replacement_proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_subscription" ADD CONSTRAINT "watch_subscription_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_subscription" ADD CONSTRAINT "watch_subscription_cik_issuer_cik_fk" FOREIGN KEY ("cik") REFERENCES "public"."issuer"("cik") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_source" ADD CONSTRAINT "workspace_source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_source" ADD CONSTRAINT "workspace_source_source_id_source_document_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_ws_idx" ON "agent_run" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_run_case_idx" ON "agent_run" USING btree ("case_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "export_key_uq" ON "artifact_export" USING btree ("workspace_id","revision_id","notice_id","format","overlay_version");--> statement-breakpoint
CREATE INDEX "challenge_case_idx" ON "challenge" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "claim_revision_idx" ON "claim" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "claim_lineage_idx" ON "claim" USING btree ("lineage_id");--> statement-breakpoint
CREATE INDEX "binding_claim_idx" ON "claim_binding" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "binding_fact_idx" ON "claim_binding" USING btree ("fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_edge_uq" ON "claim_dependency" USING btree ("workspace_id","from_node","to_node","type");--> statement-breakpoint
CREATE INDEX "dependency_to_idx" ON "claim_dependency" USING btree ("workspace_id","to_node");--> statement-breakpoint
CREATE INDEX "dependency_from_idx" ON "claim_dependency" USING btree ("workspace_id","from_node");--> statement-breakpoint
CREATE UNIQUE INDEX "impact_case_claim_uq" ON "claim_impact" USING btree ("case_id","claim_id");--> statement-breakpoint
CREATE INDEX "impact_case_state_idx" ON "claim_impact" USING btree ("case_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "case_origin_uq" ON "correction_case" USING btree ("workspace_id","origin_event_id");--> statement-breakpoint
CREATE INDEX "case_ws_status_idx" ON "correction_case" USING btree ("workspace_id","status","last_updated_at");--> statement-breakpoint
CREATE INDEX "notice_report_idx" ON "correction_notice" USING btree ("report_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_logical_key_uq" ON "delivery" USING btree ("logical_key");--> statement-breakpoint
CREATE INDEX "delivery_ws_status_idx" ON "delivery" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempt_uq" ON "delivery_attempt" USING btree ("delivery_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_principal_session_uq" ON "demo_principal" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "demo_principal_ws_idx" ON "demo_principal" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disclosure_event_key_uq" ON "disclosure_event" USING btree ("workspace_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_seq_uq" ON "domain_event" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "domain_event_case_idx" ON "domain_event" USING btree ("case_id","seq");--> statement-breakpoint
CREATE INDEX "fact_semantic_idx" ON "financial_fact" USING btree ("semantic_key","source_column");--> statement-breakpoint
CREATE INDEX "fact_source_idx" ON "financial_fact" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_locator_column_uq" ON "financial_fact" USING btree ("locator_id","source_column","concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_uq" ON "outbox_job" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox_job" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "pub_status_report_idx" ON "publication_status_event" USING btree ("report_id","occurred_at");--> statement-breakpoint
CREATE INDEX "proposal_case_claim_idx" ON "replacement_proposal" USING btree ("case_id","claim_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "warning_active_uq" ON "report_warning" USING btree ("revision_id","case_id","type");--> statement-breakpoint
CREATE INDEX "warning_report_idx" ON "report_warning" USING btree ("report_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "report_public_id_uq" ON "research_report" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "report_ws_idx" ON "research_report" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_report_version_uq" ON "research_revision" USING btree ("report_id","version");--> statement-breakpoint
CREATE INDEX "revision_report_idx" ON "research_revision" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "runtime_session_ws_idx" ON "runtime_session" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_accession_hash_uq" ON "source_document" USING btree ("accession","sha256");--> statement-breakpoint
CREATE INDEX "source_cik_form_idx" ON "source_document" USING btree ("cik","form","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "locator_source_hash_uq" ON "source_locator" USING btree ("source_id","kind","excerpt_hash");--> statement-breakpoint
CREATE INDEX "locator_source_idx" ON "source_locator" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_token_uq" ON "synthetic_recipient" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tool_call_run_idx" ON "tool_call" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "attestation_proposal_idx" ON "verification_attestation" USING btree ("proposal_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_ws_cik_uq" ON "watch_subscription" USING btree ("workspace_id","cik");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slug_uq" ON "workspace" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ws_source_avail_idx" ON "workspace_source" USING btree ("workspace_id","available_at");