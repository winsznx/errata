"use client";

import { Activity, BookOpenText, FileStack, Gauge, Inbox, Landmark, Newspaper, Send, Settings, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { apiSend, ws } from "@/lib/api";
import { fmtDateTime, relative } from "@/lib/format";
import type { Role } from "@/lib/types";
import { useToast } from "./ui";
import { useWorkspace } from "./workspace-context";

const NAV = [
  { href: "", label: "Overview", icon: Gauge },
  { href: "/cases", label: "Cases", icon: ShieldAlert },
  { href: "/research", label: "Research", icon: BookOpenText },
  { href: "/publications", label: "Publications", icon: Newspaper },
  { href: "/distribution", label: "Distribution", icon: Send },
  { href: "/sources", label: "Evidence", icon: FileStack },
  { href: "/watchlist", label: "Watchlist", icon: Landmark },
  { href: "/runtime", label: "Agent runtime", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="wordmark" aria-label="Errata home">
      Errata
    </Link>
  );
}

function StreamIndicator() {
  const { stream, lastEventAt } = useWorkspace();
  if (stream === "live") return <span className="status status-live">Live</span>;
  if (stream === "connecting") return <span className="status status-warn">Connecting</span>;
  return (
    <span className="status status-bad" title={lastEventAt ? `Last update ${fmtDateTime(lastEventAt)}` : undefined}>
      {stream === "reconnecting" ? "Reconnecting" : "Offline"}, actions paused{lastEventAt ? `, data from ${relative(lastEventAt)}` : ""}
    </span>
  );
}

function RoleSwitch() {
  const { workspaceId, principal } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <label className="role-switch">
      <span className="visually-hidden">Demo role</span>
      <select
        className="select"
        value={principal.role}
        disabled={busy}
        onChange={async (event) => {
          setBusy(true);
          try {
            const next = await apiSend<{ displayName: string }>("POST", ws(workspaceId, "/demo/role"), { role: event.target.value as Role });
            toast(`Now acting as ${next.displayName}`);
            router.refresh();
            window.location.reload();
          } catch (error) {
            toast(error instanceof Error ? error.message : "Could not switch role", "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="editor">Editor (demo)</option>
        <option value="analyst">Analyst (demo)</option>
        <option value="operator">Operator (demo)</option>
      </select>
    </label>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { slug, overview } = useWorkspace();
  const pathname = usePathname();
  const base = `/w/${slug}`;
  const [navOpen, setNavOpen] = useState(false);
  const running = overview?.counts.runningAgents ?? 0;
  return (
    <div className="shell">
      <aside className={`rail ${navOpen ? "rail-open" : ""}`} aria-label="Workspace navigation">
        <div className="rail-top">
          <Wordmark href={base} />
          <span className="rail-sub">Correction desk</span>
        </div>
        <nav>
          <ul className="nav-list">
            {NAV.map(({ href, label, icon: Icon }) => {
              const target = `${base}${href}`;
              const active = href === "" ? pathname === base : pathname.startsWith(target);
              return (
                <li key={label}>
                  <Link href={target} className="nav-link" aria-current={active ? "page" : undefined} onClick={() => setNavOpen(false)}>
                    <Icon size={16} aria-hidden="true" />
                    {label}
                    {label === "Agent runtime" && running > 0 ? <span className="nav-count num">{running}</span> : null}
                    {label === "Cases" && (overview?.counts.activeCases ?? 0) > 0 ? <span className="nav-count num">{overview?.counts.activeCases}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="rail-foot small muted">
          <p>Synthetic publisher and recipients. Public SEC filings. Not financial advice.</p>
        </div>
      </aside>
      <div className="workspace">
        <div className="context-bar">
          <button type="button" className="btn btn-quiet btn-sm nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
            <Inbox size={16} aria-hidden="true" /> Menu
          </button>
          <div className="context-main">
            <span className="context-name">{overview?.workspace.name ?? "Workspace"}</span>
            {overview?.workspace.mode === "replay" ? (
              <span className="context-clock" title="Replay clock: filings become visible to agents only after this time">
                Historical replay, clock at <span className="num">{fmtDateTime(overview.workspace.logicalTime)}</span>
              </span>
            ) : (
              <span className="context-clock">Live monitor</span>
            )}
          </div>
          <div className="row context-right">
            <StreamIndicator />
            <RoleSwitch />
          </div>
        </div>
        <main id="main" className="content">
          {children}
        </main>
      </div>
    </div>
  );
}
