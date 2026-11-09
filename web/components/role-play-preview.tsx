"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Pencil,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AssignComposer } from "@/components/assign-composer";
import { useOrgCopy } from "@/components/org-type-provider";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export type OrganizationUser = {
  id: string;
  name: string;
  email: string;
};

export type AssignmentSummary = {
  id: string;
  status: string;
  assignedAt: string;
  expiresAt: string;
  userName: string;
  userEmail: string;
};

export type RolePlayData = {
  slug: string;
  name: string;
  objective?: string;
  instruction?: string;
  opening?: string;
  voiceId?: string;
  voiceName?: string;
  knowledgeBase?: string;
  knowledgeBaseName?: string;
  status?: "draft" | "published";
  version?: number;
  draftRevision?: number;
  stages?: Array<{
    id: string;
    name: string;
    objective: string;
    opening?: string;
    config?: {
      knowledge?: { tags?: string[] };
      claim_handling?: string;
      evidence?: {
        definitions?: Record<string, string>;
        keys?: string[];
        completion_keys?: string[];
      };
      turns?: { minimum?: number; maximum?: number };
    };
  }>;
  config?: {
    claim_handling?: string;
    context?: { mode?: string; required?: boolean; prompt?: string };
    actions?: {
      allowed?: string[];
      default?: string;
      max_probes_per_lane?: number;
    };
    evidence?: { statuses?: string[] };
    turns?: { maximum?: number };
    rendering?: {
      maximum_words?: number;
      maximum_question_marks?: number;
      one_focal_ask?: boolean;
      deterministic_closing?: boolean;
    };
  };
};

const STATUS_META: Record<string, { label: string; badge: "error" | "success" | "outline" }> = {
  pending: { label: "Not started", badge: "error" },
  used: { label: "Started", badge: "success" },
  expired: { label: "Expired", badge: "outline" },
  cancelled: { label: "Cancelled", badge: "outline" },
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Not started" },
  { value: "used", label: "Started" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

const formatDay = (iso: string) => iso.slice(0, 10);

function AvatarInitial({ name }: { name: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function RolePlayPreview({
  rolePlay,
  availableUsers = [],
  assignments = [],
  overview: overviewContent,
}: {
  rolePlay: RolePlayData;
  availableUsers?: OrganizationUser[];
  assignments?: AssignmentSummary[];
  /** Replaces the default overview (instructions, first message, documents). */
  overview?: ReactNode;
}) {
  const router = useRouter();
  const copy = useOrgCopy();
  const canAssign = rolePlay.status === "published";

  // Assignments list state
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [removingId, setRemovingId] = useState<string | null>(null);

  const visibleAssignments = assignments
    .filter((a) => statusFilter === "all" || a.status === statusFilter)
    .filter((a) => {
      const query = search.trim().toLowerCase();
      return (
        !query ||
        a.userName.toLowerCase().includes(query) ||
        a.userEmail.toLowerCase().includes(query)
      );
    });

  async function removeAssignment(id: string) {
    setRemovingId(id);
    try {
      const response = await fetch(
        `/api/role-play/${encodeURIComponent(rolePlay.slug)}/assignments`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentId: id }),
        },
      );
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(result?.error ?? "Assignment could not be removed");
      }
      toast.success("Assignment removed");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Assignment could not be removed");
    } finally {
      setRemovingId(null);
    }
  }

  const overview = (
    <>
      <section>
        <h2 className="text-lg font-semibold">Instructions</h2>
        <MessageResponse className="mt-3 max-h-[35rem] overflow-y-auto rounded-xl border bg-muted/50 p-4 text-base leading-relaxed">
          {rolePlay.instruction || rolePlay.objective || "No instructions captured for this scenario yet."}
        </MessageResponse>
      </section>

      {rolePlay.opening && (
        <section>
          <h2 className="text-lg font-semibold">First message</h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">{rolePlay.opening}</p>
        </section>
      )}

      {rolePlay.config?.context?.prompt && (
        <section>
          <h2 className="text-lg font-semibold">Documents</h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            {rolePlay.config.context.prompt}
          </p>
        </section>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 sm:p-8">
      <PageContainer size="wide">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> All {copy.scenariosLower}
        </Link>

        <PageHeader
          className="mt-4 border-b pb-6"
          title={
            <span className="flex flex-wrap items-center gap-2.5 break-words">
              {rolePlay.name}
              {rolePlay.status === "draft" ? (
                <Badge variant="outline">Draft</Badge>
              ) : (
                <Badge variant="success">Published</Badge>
              )}
            </span>
          }
          description={`${rolePlay.slug} · ${rolePlay.status === "draft" ? `draft revision ${rolePlay.version}` : `published version ${rolePlay.version}`}`}
          actions={
            <>
              <Button variant="outline" nativeButton={false} render={<Link href={`/agents/${encodeURIComponent(rolePlay.slug)}/edit`} />}>
                <Pencil data-icon="inline-start" /> Edit {copy.scenarioLower}
              </Button>
              {rolePlay.status === "published" ? (
                <Button nativeButton={false} render={<Link href={`/talk?agent=${encodeURIComponent(rolePlay.slug)}`} />}>
                  <Play data-icon="inline-start" /> Test {copy.scenarioLower}
                </Button>
              ) : (
                <Button disabled>
                  <Play data-icon="inline-start" /> Publish to test
                </Button>
              )}
            </>
          }
        />

        {rolePlay.draftRevision && (
          <div className="mt-6 flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Unpublished changes</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Draft revision {rolePlay.draftRevision} is newer than the published {copy.scenarioLower} shown here.
              </p>
            </div>
            <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/agents/${encodeURIComponent(rolePlay.slug)}/edit`} />}>
              Continue editing
            </Button>
          </div>
        )}

        <Tabs defaultValue="overview" className="mt-6">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assign" disabled={!canAssign}>
              Assign
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-6 space-y-8">
            {overviewContent ?? overview}
          </TabsContent>

          <TabsContent value="assign" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Assignments</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Everyone this {copy.scenarioLower} has been assigned to.
                    </p>
                  </div>
                  <Badge variant="secondary" className="gap-1 text-[11px]">
                    {visibleAssignments.length}
                  </Badge>
                </div>
                <div className="mt-4 flex gap-2">
                  <div className="relative flex-1">
                    <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
                    <Input
                      placeholder="Search by name or email..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-8"
                    />
                  </div>
                  <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? "all")}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_FILTERS.map((filter) => (
                        <SelectItem key={filter.value} value={filter.value}>
                          {filter.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                  {assignments.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      No assignments yet. Add emails on the right to send practice links.
                    </p>
                  ) : visibleAssignments.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      No assignments match this search or filter.
                    </p>
                  ) : (
                    <ItemGroup>
                      {visibleAssignments.map((assignment) => {
                        const meta = STATUS_META[assignment.status] ?? {
                          label: assignment.status,
                          badge: "outline" as const,
                        };
                        return (
                          <Item key={assignment.id} variant="outline" size="sm">
                            <ItemMedia>
                              <AvatarInitial name={assignment.userName} />
                            </ItemMedia>
                            <ItemContent>
                              <ItemTitle>{assignment.userName}</ItemTitle>
                              <ItemDescription>{assignment.userEmail}</ItemDescription>
                            </ItemContent>
                            <ItemActions>
                              <span className="text-[11px] text-muted-foreground">
                                {formatDay(assignment.assignedAt)}
                              </span>
                              <Badge variant={meta.badge} size="sm">
                                {meta.label}
                              </Badge>
                              {assignment.status === "pending" && (
                                <button
                                  type="button"
                                  aria-label={`Remove assignment for ${assignment.userEmail}`}
                                  title="Remove assignment"
                                  disabled={removingId === assignment.id}
                                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                                  onClick={() => removeAssignment(assignment.id)}
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              )}
                            </ItemActions>
                          </Item>
                        );
                      })}
                    </ItemGroup>
                  )}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>New assignment</CardTitle>
                  <CardDescription>
                    Comma-separated emails. Each learner receives their practice link.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AssignComposer
                    slug={rolePlay.slug}
                    memberEmails={availableUsers.map((user) => user.email)}
                    pendingEmails={assignments
                      .filter((assignment) => assignment.status === "pending")
                      .map((assignment) => assignment.userEmail)}
                    disabled={!canAssign}
                  />
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </PageContainer>

    </div>
  );
}
