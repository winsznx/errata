import type { DomainEventView } from "./types";
import { ROLE_LABEL } from "./format";

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** Plain-language status lines built only from committed event payloads. */
export function describeEvent(event: DomainEventView): string {
  const p = event.payload;
  const role = ROLE_LABEL[event.actor.id] ?? event.actor.id;
  switch (event.type) {
    case "workspace.created":
      return `Workspace created with ${str(p.reports)} synthetic notes`;
    case "runtime.started":
      return "Mozaik runtime started with four agents";
    case "replay.advanced":
      return `Replay clock moved to the next filing: ${str(p.label)}`;
    case "filing.discovered":
      return `New public filing: ${str(p.form)} ${str(p.accession)}`;
    case "filing.classified":
      return `${role} classified ${str(p.classification).toLowerCase()} filing`;
    case "filing.scope_proposed":
      return `${role} proposed the non-reliance scope: ${Array.isArray(p.periods) ? (p.periods as { label: string }[]).map((x) => x.label).join("; ") : ""}`;
    case "filing.non_reliance_detected":
      return `${role} independently confirmed the scope; warnings applied`;
    case "filing.amendment_received":
      return `${role} linked amended filing ${str(p.accession)}; evidence revision advanced`;
    case "evidence.superseded":
      return `Evidence revision ${str(p.previousEpoch)} replaced by ${str(p.newEpoch)}; older checks no longer count`;
    case "claim.affected":
      return `${Array.isArray(p.claimIds) ? p.claimIds.length : 0} claims put under review`;
    case "claim.invalidated":
      return `${Array.isArray(p.claimIds) ? p.claimIds.length : 0} claims marked unreliable`;
    case "case.reports_unaffected":
      return `Checked and left unaffected: ${Array.isArray(p.reports) ? (p.reports as { title: string }[]).map((r) => r.title).join("; ") : ""}`;
    case "report.warning_applied":
      return str(p.warningType) === "NON_RELIANCE" ? "Reader warning applied to a published note" : "Note marked under review";
    case "report.warning_cleared":
      return "Review finished: the note does not rely on the affected figures, warning removed";
    case "report.warning_text_updated":
      return `${role} wrote the reader explanation for a warning`;
    case "claim.replacement_proposed":
      return `${role} proposed a ${str(p.kind)} replacement for ${str(p.claimLabel)}`;
    case "claim.verified":
      return `${role} verified ${str(p.claimLabel)}`;
    case "claim.rejected":
      return `${role} rejected the proposal for ${str(p.claimLabel)}`;
    case "challenge.raised":
      return `${role} raised a challenge: ${str(p.reasonCode).toLowerCase().replace(/_/g, " ")}`;
    case "verification.recheck_requested":
      return `${str(p.actorName) || "Editor"} asked the Financial Verifier for another independent check`;
    case "challenge.resolved":
      return "Challenge resolved";
    case "report.revision_prepared":
      return Array.isArray(p.blockers) && p.blockers.length ? `${role} drafted a correction with ${p.blockers.length} blockers` : `${role} drafted a correction ready for review`;
    case "report.conclusions_reviewed":
      return str(p.verdict) === "consistent" ? `${role} checked the rewritten conclusions against the corrected figures` : `${role} found a rewritten conclusion that contradicts the corrected figures`;
    case "report.approved":
      return "Editor approved the exact draft";
    case "report.changes_requested":
      return "Editor requested changes";
    case "report.reissued":
      return `Version ${str(p.version)} reissued with a correction notice`;
    case "report.withdrawn":
      return "Note withdrawn";
    case "report.published":
      return `Version 1 published`;
    case "delivery.simulated":
      return "Correction delivered to a synthetic inbox";
    case "delivery.cancelled":
      return "Queued notice cancelled because a newer version exists";
    case "agent.started":
      return `${role} started ${str(p.task).replace(/_/g, " ")}`;
    case "agent.completed":
      return `${role} finished ${str(p.task).replace(/_/g, " ")}`;
    case "agent.stale":
      return `${role} stopped: evidence changed under it`;
    case "agent.failed":
      return `${role} failed: ${str(p.message)}`;
    case "agent.timed_out":
      return `${role} timed out: ${str(p.message)}`;
    case "agent.stale_result_rejected":
      return `${role} result from an older evidence revision was rejected`;
    case "fault.holding":
      return `Scheduling control holding one ${role} write (labelled fault injection)`;
    case "fault.released":
      return "Scheduling control released the held write";
    case "case.status_changed":
      return `Case moved to ${str(p.to).toLowerCase().replace(/_/g, " ")}`;
    case "report.draft_created":
      return "Draft created";
    case "claim.proposed":
      return `${role} mapped "${str(p.text)}"`;
    case "claim.binding_confirmed":
      return `${role} confirmed a mapping`;
    case "claim.binding_rejected":
      return `${role} rejected a mapping`;
    default:
      return event.type.replace(/[._]/g, " ");
  }
}

export function eventTone(type: string): "ok" | "warn" | "bad" | "neutral" {
  if (/(verified|reissued|confirmed|approved|completed|simulated|non_reliance_detected)$/.test(type)) return "ok";
  if (/(rejected|failed|timed_out|challenge.raised|warning_applied|invalidated)$/.test(type) || type === "agent.stale_result_rejected") return "bad";
  if (/(proposed|superseded|holding|affected|stale)$/.test(type)) return "warn";
  return "neutral";
}
