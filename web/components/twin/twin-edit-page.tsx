"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";

type LearnerAssign = {
  id: string;
  name: string;
  email: string;
  phone: string;
  assigned: boolean;
  minutes: number;
};

const INITIAL_LEARNERS: LearnerAssign[] = [
  { id: "u-1", name: "Aisha Khan", email: "aisha.khan@gmail.com", phone: "+971 50 123 4567", assigned: true, minutes: 60 },
  { id: "u-2", name: "James Carter", email: "james.carter@outlook.com", phone: "+971 55 234 7788", assigned: true, minutes: 60 },
  { id: "u-3", name: "Nora Ali", email: "nora.ali@gmail.com", phone: "+44 7700 900 142", assigned: false, minutes: 30 },
  { id: "u-4", name: "Leo Martin", email: "leo@martinrealty.ae", phone: "+971 52 889 1023", assigned: false, minutes: 30 },
  { id: "u-5", name: "Priya Nair", email: "priya.nair@gmail.com", phone: "+91 98765 43210", assigned: true, minutes: 60 },
  { id: "u-6", name: "Omar Haddad", email: "omar.haddad@dubaihomes.com", phone: "+971 56 410 2291", assigned: false, minutes: 30 },
  { id: "u-7", name: "Sofia Rossi", email: "sofia.rossi@gmail.com", phone: "+39 345 123 4567", assigned: false, minutes: 30 },
  { id: "u-8", name: "Daniel Cho", email: "daniel.cho@outlook.com", phone: "+82 10 5555 1234", assigned: false, minutes: 30 },
];

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

function SwitchToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
        checked ? "bg-(--brand)" : "bg-(--tone-control)"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

export function TwinEditPage({ id }: { id: string }) {
  const twinTitle = id === "olga-twin" ? "Olga’s twin" : "The off-plan sales process";

  // General fields
  const [name, setName] = useState(twinTitle);
  const [description, setDescription] = useState(
    "First call, educational Zoom and presentation meeting. Every stage books the next one."
  );

  // Before conversation start
  const [preScreenshare, setPreScreenshare] = useState(true);
  const [preUpload, setPreUpload] = useState(true);

  // During conversation
  const [duringUpload, setDuringUpload] = useState(true);

  // Assign learners
  const [learners, setLearners] = useState(INITIAL_LEARNERS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);

  const assignedCount = learners.filter((l) => l.assigned).length;

  const filtered = learners.filter(
    (l) =>
      l.name.toLowerCase().includes(query.toLowerCase()) ||
      l.email.toLowerCase().includes(query.toLowerCase()) ||
      l.phone.includes(query)
  );

  function togglePick(learnerId: string) {
    setSelectedIds((prev) =>
      prev.includes(learnerId) ? prev.filter((i) => i !== learnerId) : [...prev, learnerId]
    );
  }

  function handleSave() {
    setLearners((prev) =>
      prev.map((l) => (selectedIds.includes(l.id) ? { ...l, assigned: true } : l))
    );
    setSelectedIds([]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 md:px-0 pt-5 pb-16">
        {/* Header Back navigation */}
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link
            href={`/twin/${id}`}
            className="inline-flex items-center gap-2 text-sm text-(--foreground) hover:text-muted-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>
        </header>

        {/* Combined Configure & Assign Card */}
        <article className="mt-6 flex flex-col gap-8 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <div>
            <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">
              Configure twin agent
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Set conversation permissions and manage learner access for this twin.
            </p>
          </div>

          {/* Section: Basic info */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bot-name" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Bot name
              </label>
              <input
                id="bot-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-10 rounded-lg border border-(--border) bg-transparent px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="bot-desc" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Description
              </label>
              <textarea
                id="bot-desc"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="rounded-lg border border-(--border) bg-transparent p-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>
          </div>

          {/* Section: Before conversation start */}
          <div className="flex flex-col gap-4 border-t border-(--border) pt-6">
            <div>
              <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                Before conversation start
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permissions and configuration presented to the learner before the call begins.
              </p>
            </div>

            <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable screenshare</span>
                  <span className="text-xs text-muted-foreground">
                    Allow learners to share their screen before starting the conversation.
                  </span>
                </div>
                <SwitchToggle
                  checked={preScreenshare}
                  onChange={setPreScreenshare}
                  label="Enable screenshare before conversation start"
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable upload or Upload file configuration</span>
                  <span className="text-xs text-muted-foreground">
                    Allow learners to upload documents or select files prior to the session.
                  </span>
                </div>
                <SwitchToggle
                  checked={preUpload}
                  onChange={setPreUpload}
                  label="Enable upload before conversation start"
                />
              </div>
            </div>
          </div>

          {/* Section: During a conversation */}
          <div className="flex flex-col gap-4 border-t border-(--border) pt-6">
            <div>
              <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                During a conversation
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                In-session controls available while the learner is speaking with the twin.
              </p>
            </div>

            <div className="flex flex-col divide-y divide-(--border) rounded-[12px] border border-(--border) bg-(--sidebar) px-4">
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Enable upload</span>
                  <span className="text-xs text-muted-foreground">
                    Learners can upload an image or a document for clarification during conversation.
                  </span>
                </div>
                <SwitchToggle
                  checked={duringUpload}
                  onChange={setDuringUpload}
                  label="Enable upload during conversation"
                />
              </div>
            </div>
          </div>

          {/* Section: Assign learners */}
          <div id="assign" className="flex flex-col gap-4 border-t border-(--border) pt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-(--foreground)">
                  Assign learners
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Give learners practice access to this twin agent.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                <span className="text-(--foreground) font-semibold">{assignedCount}</span> assigned
                {selectedIds.length > 0 && <span className="text-(--brand)"> · {selectedIds.length} newly selected</span>}
              </span>
            </div>

            {/* Search box */}
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search by name, email or number"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-10 w-full rounded-full border border-(--border) bg-(--sidebar) pl-10 pr-4 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
              />
            </div>

            {/* Learner checklist */}
            <div className="flex flex-col overflow-hidden rounded-[12px] border border-(--border)">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">No one matches that search.</p>
              ) : (
                filtered.map((u, i) => {
                  const isSelected = selectedIds.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      className={cn(
                        "flex items-center justify-between gap-3 p-3.5 px-4 cursor-pointer transition-colors hover:bg-(--sidebar)",
                        i > 0 && "border-t border-(--border)",
                        u.assigned && "opacity-80"
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={u.assigned || isSelected}
                          disabled={u.assigned}
                          onChange={() => togglePick(u.id)}
                          className="size-4 rounded accent-(--brand) cursor-pointer"
                        />
                        <span
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                            AVATAR_TONES[i % AVATAR_TONES.length]
                          )}
                          aria-hidden
                        >
                          {u.name.charAt(0)}
                        </span>
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-semibold truncate text-(--foreground)">{u.name}</span>
                          <span className="text-xs text-muted-foreground truncate">{u.email}</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {u.assigned ? (
                          <span className="inline-flex items-center rounded-full bg-(--sidebar) border border-(--border) px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                            Assigned · {u.minutes} min
                          </span>
                        ) : isSelected ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            Selected (30 min)
                          </span>
                        ) : null}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-2 flex items-center justify-end gap-3 border-t border-(--border) pt-5">
            <Link
              href={`/twin/${id}`}
              className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-muted-foreground hover:text-(--foreground)"
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-(--brand) px-5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              {saved && <Check className="size-4" />}
              <span>{saved ? "Saved" : "Save changes"}</span>
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
