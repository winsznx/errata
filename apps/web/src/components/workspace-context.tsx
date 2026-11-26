"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR, { useSWRConfig } from "swr";
import { apiGet, fetcher, ws, type ApiError } from "@/lib/api";
import type { DomainEventView, Overview, Principal } from "@/lib/types";

type StreamState = "connecting" | "live" | "reconnecting" | "offline";

interface WorkspaceValue {
  slug: string;
  workspaceId: string;
  principal: Principal;
  overview: Overview | undefined;
  stream: StreamState;
  lastEventAt: string | null;
  canAct: boolean;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

class EventLog {
  private events: DomainEventView[] = [];
  private listeners = new Set<() => void>();
  push(event: DomainEventView): void {
    if (this.events.some((e) => e.id === event.id)) return;
    this.events = [...this.events, event].slice(-300);
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): DomainEventView[] => this.events;
}

const EMPTY: DomainEventView[] = [];
const logs = new Map<string, EventLog>();
function logFor(workspaceId: string): EventLog {
  let log = logs.get(workspaceId);
  if (!log) {
    log = new EventLog();
    logs.set(workspaceId, log);
  }
  return log;
}

export function useLiveEvents(workspaceId: string | undefined): DomainEventView[] {
  const log = workspaceId ? logFor(workspaceId) : null;
  return useSyncExternalStore(log?.subscribe ?? (() => () => undefined), log?.snapshot ?? (() => EMPTY), () => EMPTY);
}

/** Keeps a live SSE connection to the runtime and revalidates cached views after every committed event. */
function useEventStream(workspaceId: string | undefined): { stream: StreamState; lastEventAt: string | null } {
  const { mutate } = useSWRConfig();
  const [stream, setStream] = useState<StreamState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let source: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lastSeq: string | null = null;
    const prefix = ws(workspaceId);
    const revalidate = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => void mutate((key) => typeof key === "string" && key.startsWith(prefix)), 250);
    };
    const connect = async () => {
      try {
        const { ticket } = await apiGet<{ ticket: string }>(ws(workspaceId, "/stream-ticket"));
        if (closed) return;
        const origin = process.env.NEXT_PUBLIC_EVENTS_ORIGIN ?? "";
        const resume = lastSeq ? `&lastEventId=${lastSeq}` : "";
        source = new EventSource(`${origin}${ws(workspaceId, "/events")}?ticket=${encodeURIComponent(ticket)}${resume}`);
        source.addEventListener("ready", () => setStream("live"));
        source.addEventListener("resync", revalidate);
        source.addEventListener("domain", (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as DomainEventView;
          lastSeq = event.seq;
          logFor(workspaceId).push(event);
          setLastEventAt(event.committedAt);
          setStream("live");
          revalidate();
        });
        source.onopen = () => {
          setStream("live");
          revalidate();
        };
        source.onerror = () => {
          setStream("reconnecting");
          source?.close();
          if (!closed) retry = setTimeout(() => void connect(), 2500);
        };
      } catch {
        setStream("offline");
        if (!closed) retry = setTimeout(() => void connect(), 5000);
      }
    };
    void connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [workspaceId, mutate]);

  return { stream, lastEventAt };
}

export function WorkspaceProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const session = useSWR<{ workspaceId: string; principal: Principal }, ApiError>(`/api/v1/workspaces/by-slug/${slug}`, fetcher, { shouldRetryOnError: false });
  const workspaceId = session.data?.workspaceId;
  const overview = useSWR<Overview>(workspaceId ? ws(workspaceId) : null, fetcher, { refreshInterval: 20_000 });
  const { stream, lastEventAt } = useEventStream(workspaceId);

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!session.data) return null;
    const principal = overview.data?.principal ?? session.data.principal;
    return { slug, workspaceId: session.data.workspaceId, principal, overview: overview.data, stream, lastEventAt, canAct: stream === "live" };
  }, [session.data, overview.data, slug, stream, lastEventAt]);

  if (session.error) {
    return (
      <main id="main" className="gate">
        <div className="gate-card stack">
          <h1 className="serif">This workspace is not open in this browser</h1>
          <p className="muted">Demo workspaces belong to the browser session that started them, and they expire after a day. Start a new one to continue.</p>
          <div className="row">
            <a className="btn btn-primary" href="/demo">
              Start a demo workspace
            </a>
            <a className="btn" href="/">
              Back to Errata
            </a>
          </div>
        </div>
      </main>
    );
  }
  if (!value) {
    return (
      <main id="main" className="gate" aria-busy="true">
        <div className="gate-card stack">
          <div className="skeleton" style={{ width: "60%", height: 24 }} />
          <div className="skeleton" style={{ width: "90%" }} />
          <div className="skeleton" style={{ width: "75%" }} />
        </div>
      </main>
    );
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

export function useWs<T>(path: string | null, options: { refreshInterval?: number } = {}) {
  const { workspaceId } = useWorkspace();
  return useSWR<T, ApiError>(path === null ? null : ws(workspaceId, path), fetcher, { keepPreviousData: true, ...options });
}
