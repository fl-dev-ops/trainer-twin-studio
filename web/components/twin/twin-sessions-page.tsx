"use client";

import { useState } from "react";
import { DATE_RANGES, FilterDropdown, inDateRange } from "@/components/filter-dropdown";
import { SessionsIcon } from "@/components/icons";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { TwinSessionItem, type TwinSessionItemData } from "@/components/twin/twin-session-item";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/page-container";

/** Options from the sessions themselves, "All …" first. */
function optionsOf(all: string, pairs: [string, string][]) {
  return [{ value: "all", label: all }, ...[...new Map(pairs)].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
}

export function TwinSessionsPage({ sessions }: { sessions: TwinSessionItemData[] }) {
  const [botFilter, setBotFilter] = useState("all");
  const [learnerFilter, setLearnerFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("30");

  const agentOptions = optionsOf("All twin agents", sessions.map((s) => [s.agentSlug, s.agentName]));
  const learnerOptions = optionsOf("All learners", sessions.map((s) => [s.learnerEmail, s.learner]));
  const filteredSessions = sessions.filter((s) => {
    if (botFilter !== "all" && s.agentSlug !== botFilter) return false;
    if (learnerFilter !== "all" && s.learnerEmail !== learnerFilter) return false;
    return inDateRange(s.at, dateFilter);
  });

  return (
    <PageContainer>
      <PageHeader
        icon={SessionsIcon}
        title="Twin sessions"
        actions={
          <>
            <FilterDropdown value={botFilter} onChange={setBotFilter} options={agentOptions} />
            <FilterDropdown value={learnerFilter} onChange={setLearnerFilter} options={learnerOptions} />
            <FilterDropdown value={dateFilter} onChange={setDateFilter} options={DATE_RANGES} />
          </>
        }
      />

      <SectionHeader title="Sessions" note="Questions your learners asked your twins" className="mt-10" />

      {/* Reference sess-list */}
      <Card size="lg" className="mt-4 gap-0 py-0">
      <ul className="m-0 flex list-none flex-col p-0">
        {filteredSessions.length === 0 ? (
          <li className="p-8 text-center text-sm text-muted-foreground">No sessions match these filters.</li>
        ) : (
          filteredSessions.map((c, idx) => (
            <TwinSessionItem
              key={c.id}
              session={c}
              divider={idx > 0}
            />
          ))
        )}
      </ul>
      </Card>
    </PageContainer>
  );
}
