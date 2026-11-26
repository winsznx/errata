import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicReport, type PublicReportData } from "@/components/public-report";
import { NotFound, runtimeGet } from "@/lib/server-api";

export const dynamic = "force-dynamic";

async function load(publicId: string, version: string): Promise<PublicReportData> {
  if (!/^\d{1,4}$/.test(version)) notFound();
  try {
    return await runtimeGet<PublicReportData>(`/api/v1/public/reports/${encodeURIComponent(publicId)}/versions/${version}`);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ publicId: string; version: string }> }): Promise<Metadata> {
  const { publicId, version } = await params;
  const data = await load(publicId, version);
  return { title: `${data.report.title}, version ${version}`, robots: { index: false } };
}

export default async function PublicVersionPage({ params }: { params: Promise<{ publicId: string; version: string }> }) {
  const { publicId, version } = await params;
  return <PublicReport data={await load(publicId, version)} historical />;
}
