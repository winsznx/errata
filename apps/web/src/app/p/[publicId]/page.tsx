import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicReport, type PublicReportData } from "@/components/public-report";
import { NotFound, runtimeGet } from "@/lib/server-api";

export const dynamic = "force-dynamic";

async function load(publicId: string): Promise<PublicReportData> {
  try {
    return await runtimeGet<PublicReportData>(`/api/v1/public/reports/${encodeURIComponent(publicId)}`);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ publicId: string }> }): Promise<Metadata> {
  const { publicId } = await params;
  const data = await load(publicId);
  return { title: data.report.title, robots: { index: false } };
}

export default async function PublicReportPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicReport data={await load(publicId)} historical={false} />;
}
