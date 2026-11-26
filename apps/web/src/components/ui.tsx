"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ApiError } from "@/lib/api";

type Tone = "ok" | "warn" | "bad" | "neutral" | "live";

const STATE_TONE: Record<string, [Tone, string]> = {
  CLEAR: ["ok", "Clear"],
  UNDER_REVIEW: ["warn", "Under review"],
  NON_RELIANCE: ["bad", "Unreliable"],
  SUPERSEDED: ["neutral", "Superseded"],
  WITHDRAWN: ["bad", "Withdrawn"],
  PUBLISHED: ["ok", "Published"],
  DRAFT: ["neutral", "Draft"],
  DISCOVERED: ["neutral", "Discovered"],
  INVESTIGATING: ["warn", "Investigating"],
  AWAITING_EVIDENCE: ["bad", "Awaiting corrected figures"],
  VERIFYING: ["warn", "Verifying"],
  NEEDS_REVIEW: ["bad", "Needs review"],
  READY_FOR_APPROVAL: ["live", "Ready for approval"],
  PARTIALLY_REISSUED: ["warn", "Partly reissued"],
  RESOLVED: ["ok", "Resolved"],
  NOT_APPLICABLE: ["neutral", "Not applicable"],
  FAILED: ["bad", "Failed"],
  RELIABLE_AT_PUBLICATION: ["ok", "Reliable at publication"],
  INVALIDATED: ["bad", "Unreliable"],
  REPLACEMENT_PROPOSED: ["warn", "Replacement proposed"],
  VERIFIED_REPLACEMENT: ["ok", "Verified replacement"],
  REJECTED: ["bad", "Rejected"],
  UNRESOLVED: ["bad", "Unresolved"],
  UNCHANGED_VERIFIED: ["ok", "Verified unchanged"],
  UNAFFECTED: ["ok", "Unaffected"],
  PROPOSED: ["warn", "Proposed"],
  VERIFIED: ["ok", "Verified"],
  CHECKING: ["warn", "Checking"],
  BLOCKED: ["bad", "Blocked"],
  READY: ["live", "Ready"],
  APPROVED: ["ok", "Approved"],
  CHANGES_REQUESTED: ["warn", "Changes requested"],
  EXPIRED: ["neutral", "Expired"],
  STARTED: ["live", "Running"],
  COMPLETED: ["ok", "Completed"],
  TIMED_OUT: ["bad", "Timed out"],
  STALE: ["neutral", "Stale, stopped"],
  QUEUED: ["neutral", "Queued"],
  PROCESSING: ["warn", "Processing"],
  SIMULATED_DELIVERED: ["ok", "Delivered (simulated)"],
  CANCELLED: ["neutral", "Cancelled"],
  BOUND: ["ok", "Verified"],
  UNMAPPED: ["neutral", "Not mapped"],
  AMBIGUOUS: ["bad", "Ambiguous"],
  OPEN: ["bad", "Open"],
  SUPERSEDED_PROPOSAL: ["neutral", "Superseded"],
};

export function Status({ value, label }: { value: string; label?: string }) {
  const [tone, text] = STATE_TONE[value] ?? ["neutral", value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ")];
  return <span className={`status status-${tone}`}>{label ?? text}</span>;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack-sm" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${92 - i * 9}%`, height: 16 }} />
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p className="muted">{children}</p> : null}
      {action ? <div className="row" style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: ApiError | Error; retry?: () => void }) {
  const status = (error as ApiError).status;
  return (
    <div className="error-box" role="alert">
      <strong>{status === 404 ? "Not found" : status === 403 ? "Not allowed" : status === 401 ? "Session ended" : "Could not load this view"}</strong>
      <span>{error.message}</span>
      {retry ? (
        <div>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div className="stack-sm">
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

const ToastContext = createContext<(text: string, tone?: "ok" | "error") => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    counter.current += 1;
    const id = counter.current;
    setToasts((all) => [...all, { id, text, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === "error" ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "toast-error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** A native dialog that states the effect of an action before it happens. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <div className="dialog-body">
        <h2 id="dialog-title" style={{ fontSize: 17 }}>
          {title}
        </h2>
        <div className="stack-sm">{children}</div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? "Working" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
