"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

interface Ready {
  model: { provider: string; limit: { window: "minute" | "day"; until: string } | null };
}

/** Says so plainly when the hosted model provider has refused calls for the rest of its daily budget. */
export function ProviderNotice() {
  const { data } = useSWR<Ready>("/api/v1/ready", fetcher, { refreshInterval: 60_000 });
  const limit = data?.model.limit;
  if (limit?.window !== "day") return null;
  return (
    <div className="banner banner-warn" role="status">
      <strong>The hosted model&apos;s daily token budget is used up</strong>
      <span>
        Agent calls wait until about {fmtDateTime(limit.until)}, then continue on their own. Nothing is lost while they wait. To watch the agents work now, run Errata locally with your own Groq key as the README describes.
      </span>
    </div>
  );
}
