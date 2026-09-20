"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeft,
  Pencil,
  Play,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type EmailKind = "invalid" | "member" | "pending" | "unknown";

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

function parseEmails(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

const formatDay = (iso: string) => iso.slice(0, 10);

function AvatarInitial({ name }: { name: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function BadgeChip({
  email,
  kind,
  onRemove,
}: {
  email: string;
  kind: EmailKind;
  onRemove: () => void;
}) {
  const tone =
    kind === "invalid"
      ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
      : kind === "pending"
        ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
        : "border-border bg-muted/40 text-foreground";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span className="truncate">{email}</span>
      {kind === "invalid" && <span className="text-[10px] font-medium">invalid</span>}
      {kind === "pending" && <span className="text-[10px] font-medium">pending</span>}
      <button
        type="button"
        aria-label={`Remove ${email}`}
        className="shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

export function RolePlayPreview({
  rolePlay,
  availableUsers = [],
  assignments = [],
}: {
  rolePlay: RolePlayData;
  availableUsers?: OrganizationUser[];
  assignments?: AssignmentSummary[];
}) {
  const router = useRouter();
  const canAssign = rolePlay.status === "published";

  // Assignments list state
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Composer state
  const [draft, setDraft] = useState("");
  const [badges, setBadges] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const usersByEmail = new Map(
    availableUsers.map((user) => [user.email.toLowerCase(), user]),
  );
  const pendingEmailSet = new Set(
    assignments
      .filter((assignment) => assignment.status === "pending")
      .map((assignment) => assignment.userEmail.toLowerCase()),
  );

  function emailKind(email: string): EmailKind {
    if (!EMAIL_RE.test(email)) return "invalid";
    if (!usersByEmail.has(email)) return "unknown";
    return pendingEmailSet.has(email) ? "pending" : "member";
  }

  function commitDraft() {
    const parsed = parseEmails(draft);
    if (parsed.length === 0) return;
    setDraft("");
    setBadges((current) => [...current, ...parsed.filter((e) => !current.includes(e))]);
  }

  const submittedEmails = [...new Set([...badges, ...parseEmails(draft)])];
  const hasInvalid = submittedEmails.some((email) => emailKind(email) === "invalid");
  const pendingSelected = submittedEmails.filter((email) => emailKind(email) === "pending");

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

  async function submit(resendPending?: "send" | "ignore") {
    setSaving(true);
    try {
      const response = await fetch(
        `/api/role-play/${encodeURIComponent(rolePlay.slug)}/assignments`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: submittedEmails, resendPending: resendPending ?? "ignore" }),
        },
      );
      const result = await response.json().catch(() => null) as {
        added?: number;
        invited?: number;
        resent?: number;
        skipped?: number;
        emailFailures?: number;
        error?: string;
      } | null;
      if (!response.ok || !result || result.error) {
        throw new Error(result?.error ?? "Invites could not be sent");
      }

      setBadges([]);
      setDraft("");
      const parts: string[] = [];
      if (result.added) parts.push(`${result.added} learner${result.added === 1 ? "" : "s"} assigned`);
      if (result.invited) parts.push(`${result.invited} new invite${result.invited === 1 ? "" : "s"} sent`);
      if (result.resent) parts.push(`${result.resent} invite${result.resent === 1 ? "" : "s"} resent`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      if (parts.length === 0) {
        toast.info("Nothing to send");
      } else if (result.emailFailures) {
        toast.warning(`${parts.join(" · ")}, but ${result.emailFailures} email${result.emailFailures === 1 ? "" : "s"} could not be sent.`);
      } else {
        toast.success(parts.join(" · "));
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invites could not be sent");
    } finally {
      setSaving(false);
    }
  }

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
        throw new Error(result?.error ?? "Invite could not be removed");
      }
      toast.success("Invite removed");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invite could not be removed");
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
          <ArrowLeft className="size-4" /> All scenarios
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
                <Pencil data-icon="inline-start" /> Edit scenario
              </Button>
              {rolePlay.status === "published" ? (
                <Button nativeButton={false} render={<Link href={`/talk?agent=${encodeURIComponent(rolePlay.slug)}`} />}>
                  <Play data-icon="inline-start" /> Test scenario
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
                Draft revision {rolePlay.draftRevision} is newer than the published scenario shown here.
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
            {overview}
          </TabsContent>

          <TabsContent value="assign" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Assignments</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Everyone this scenario has been assigned to.
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
                      No assignments yet. Add emails on the right to send invites.
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
                                  aria-label={`Remove invite for ${assignment.userEmail}`}
                                  title="Remove invite"
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
                    Comma-separated emails. New learners get an invite to join first.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {badges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {badges.map((email) => (
                        <BadgeChip
                          key={email}
                          email={email}
                          kind={emailKind(email)}
                          onRemove={() =>
                            setBadges((current) => current.filter((item) => item !== email))
                          }
                        />
                      ))}
                    </div>
                  )}
                  <Textarea
                    placeholder="name@company.com, another@company.com"
                    value={draft}
                    disabled={saving || !canAssign}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.endsWith(",")) commitDraft();
                      else setDraft(value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitDraft();
                      }
                    }}
                    onBlur={commitDraft}
                  />
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={submittedEmails.length === 0 || hasInvalid || saving || !canAssign}
                    onClick={() =>
                      pendingSelected.length > 0 ? setConfirmOpen(true) : submit()
                    }
                  >
                    <Send data-icon="inline-start" /> {saving ? "Sending…" : "Send invites"}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </PageContainer>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Already invited</DialogTitle>
            <DialogDescription>
              {pendingSelected.length === 1
                ? "This learner already has a pending invite that hasn't been started."
                : `${pendingSelected.length} learners already have pending invites that haven't been started.`}{" "}
              Send the invite email again?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {pendingSelected.map((email) => (
              <span key={email} className="text-xs text-muted-foreground">
                {email}
              </span>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setConfirmOpen(false);
                  submit("ignore");
                }}
              >
                Ignore
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  setConfirmOpen(false);
                  submit("send");
                }}
              >
                {saving ? "Sending…" : "Yes, send invite"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
