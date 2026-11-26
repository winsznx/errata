import { and, eq } from "drizzle-orm";
import { reportWarning, researchReport } from "../db/schema.js";
import { guardEpoch, lockCase, type ActorContext } from "./cases.js";
import { scanNumericTokens } from "./document.js";
import { assert } from "./errors.js";
import { commit } from "./events.js";

/** Replaces the default reader explanation on an active warning with editor-drafted text. Figures are not allowed. */
export async function proposeWarningText(ctx: ActorContext, input: { caseId: string; reportId: string; text: string }) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const text = input.text.trim();
    assert(text.length >= 40 && text.length <= 700, "INVALID_INPUT", "write between 40 and 700 characters");
    const figures = scanNumericTokens([{ id: "w", kind: "paragraph", text }]);
    assert(figures.length === 0, "INVALID_INPUT", `warning text must not contain figures (${figures.map((f) => f.text).join(", ")})`);
    const report = await tx.query.researchReport.findFirst({ where: and(eq(researchReport.id, input.reportId), eq(researchReport.workspaceId, ctx.workspaceId)) });
    assert(report?.currentRevisionId, "NOT_FOUND", "report not found");
    const warning = await tx.query.reportWarning.findFirst({ where: and(eq(reportWarning.revisionId, report.currentRevisionId), eq(reportWarning.caseId, caseRow.id), eq(reportWarning.state, "ACTIVE")) });
    assert(warning, "NOT_FOUND", "no active warning on this note for the case");
    await tx.update(reportWarning).set({ detail: text }).where(eq(reportWarning.id, warning.id));
    await record({ workspaceId: ctx.workspaceId, type: "report.warning_text_updated", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { reportId: report.id, warningId: warning.id, text, agentRunId: ctx.agentRunId ?? null } });
    return { warningId: warning.id };
  });
}
