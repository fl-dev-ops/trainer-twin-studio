"use client";

import { Clock, Plus, Upload } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { KnowledgeStats } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "Never";
  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function KnowledgeHeader({
  stats,
  onOpenUpload,
}: {
  stats: KnowledgeStats | null;
  onOpenUpload: () => void;
}) {
  return (
    <PageHeader
      className="border-b pb-6"
      title="Knowledge"
      description="Upload and manage source material used to ground your scenarios."
      actions={
        <>
          {stats?.lastIndexedAt && (
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              <Clock className="size-3.5" />
              <span>Last indexed {formatRelativeTime(stats.lastIndexedAt)}</span>
            </div>
          )}
          <Button onClick={onOpenUpload}>
            <Plus data-icon="inline-start" /> Add source
          </Button>
        </>
      }
    />
  );
}
