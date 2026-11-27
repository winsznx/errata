"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Wordmark } from "@/components/app-shell";
import { ProviderNotice } from "@/components/provider-notice";
import { ErrorBox, SkeletonRows } from "@/components/ui";
import { apiSend, fetcher, type ApiError } from "@/lib/api";

interface Scenario {
  id: string;
  label: string;
  description: string;
  events: { id: string; label: string }[];
  faults: { type: string; label: string }[];
}

const TITLES: Record<string, string> = {
  "nocera-q1-repair": "Nocera: from non-reliance to a reissued note",
  "nocera-q1-stale-evidence": "Nocera: new evidence while agents are working",
  "nocera-q1-conflict": "Nocera: a bad proposal and a failed check",
  "xencor-q1-repair": "Xencor: a second issuer, figures in thousands",
  "joint-q1-repair": "The Joint Corp.: one figure restated, one unchanged",
};

export default function DemoPage() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<Scenario[], ApiError>("/api/v1/scenarios", fetcher);
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const primary = data?.find((s) => s.id === "nocera-q1-repair");
  const others = data?.filter((s) => s.id !== "nocera-q1-repair") ?? [];

  const start = async (id: string) => {
    setStarting(id);
    setStartError(null);
    try {
      const result = await apiSend<{ route: string }>("POST", "/api/v1/demo/sessions", { scenarioId: id });
      router.push(result.route);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Could not start the workspace");
      setStarting(null);
    }
  };

  return (
    <div className="landing">
      <header className="site-nav">
        <Wordmark />
        <span className="muted small" style={{ marginLeft: "auto" }}>
          Demo workspaces are private to this browser and expire after a day
        </span>
      </header>
      <main id="main" className="demo-main">
        <div className="stack" style={{ maxWidth: 760 }}>
          <h1 className="serif demo-title">Start a demo workspace</h1>
          <p className="lede">
            Each workspace replays real SEC filings in the order they became public. The research notes, publisher and recipients are synthetic. The four agents run live on a language model every time; nothing is pre-recorded.
          </p>
        </div>
        <ProviderNotice />
        {startError ? <div className="error-box" role="alert"><strong>Could not start the workspace</strong><span>{startError}</span></div> : null}
        {error ? <ErrorBox error={error} retry={() => void mutate()} /> : null}
        {isLoading || !data ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            {primary ? (
              <section className="scenario scenario-primary">
                <div className="stack-sm">
                  <span className="small muted">Recommended first run</span>
                  <h2 className="serif">{TITLES[primary.id] ?? primary.label}</h2>
                  <p>{primary.description}</p>
                  <ol className="plain-list small muted scenario-events">
                    {primary.events.map((e) => (
                      <li key={e.id}>{e.label}</li>
                    ))}
                  </ol>
                </div>
                <button type="button" className="btn btn-primary btn-lg" disabled={starting !== null} aria-busy={starting === primary.id} onClick={() => void start(primary.id)}>
                  {starting === primary.id ? "Preparing workspace" : "Start this workspace"}
                </button>
              </section>
            ) : null}
            <section className="stack">
              <h2 className="serif" style={{ fontSize: 22 }}>
                Other scenarios
              </h2>
              <div className="scenario-list">
                {others.map((s) => (
                  <article key={s.id} className="scenario">
                    <div className="stack-sm">
                      <h3>{TITLES[s.id] ?? s.label}</h3>
                      <p className="small">{s.description}</p>
                      {s.faults.length ? (
                        <ul className="plain-list small">
                          {s.faults.map((f) => (
                            <li key={f.type} className="fault-label">
                              {f.label}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <button type="button" className="btn" disabled={starting !== null} aria-busy={starting === s.id} onClick={() => void start(s.id)}>
                      {starting === s.id ? "Preparing" : "Start"}
                    </button>
                  </article>
                ))}
                <article className="scenario">
                  <div className="stack-sm">
                    <h3>Live EDGAR monitor</h3>
                    <p className="small">Watches Nocera, The Joint Corp. and Xencor on SEC EDGAR from the moment you start it, and treats only filings accepted after that as new. Add any issuer by CIK and any note through intake. Requests to sec.gov are rate limited and declare a contact as SEC asks.</p>
                  </div>
                  <button type="button" className="btn" disabled={starting !== null} aria-busy={starting === "live-monitor"} onClick={() => void start("live-monitor")}>
                    {starting === "live-monitor" ? "Preparing" : "Start"}
                  </button>
                </article>
              </div>
            </section>
          </>
        )}
        <p className="small muted" style={{ maxWidth: "70ch" }}>
          Agent runs use a hosted model on Errata&apos;s key within a demo budget. Not financial advice. Links to sec.gov open the public copies of the filings.
        </p>
      </main>
    </div>
  );
}
