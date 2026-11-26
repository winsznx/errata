import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ToastProvider } from "@/components/ui";
import { WorkspaceProvider } from "@/components/workspace-context";

export const metadata: Metadata = { title: "Workspace", robots: { index: false } };

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <ToastProvider>
      <WorkspaceProvider slug={slug}>
        <AppShell>{children}</AppShell>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
