"use client";

import { useSearchParams } from "next/navigation";
import { FidelityView } from "@/components/fidelity-view";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { ScenarioSectionNav } from "@/components/scenario-section-nav";
import { api, useApi } from "@/lib/api";

export default function FidelityPage() {
  const query = useSearchParams();
  const selection = { scenario: query.get("scenario") ?? undefined, section: query.get("section") ?? undefined };
  const { report, scenarios, baseline } = useApi(["page.fidelity"], () => api.page.fidelity.query());

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow" className="space-y-6">
        <PageHeader
          title="Scenarios"
          description="Role-play scenarios and evidence-backed fidelity evaluation."
        />
        <ScenarioSectionNav active="fidelity" />
        <div>
          <h2 className="text-xl font-semibold">Fidelity</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Synthetic conversations compared with the trainer persona baseline.
          </p>
          {report && (
            <p className="mt-2 text-xs text-muted-foreground">
              Evaluated {new Date(report.createdAt).toLocaleString()} with {report.evaluationModel}
            </p>
          )}
        </div>
        {report ? (
          <FidelityView
            report={report}
            scenarios={scenarios}
            baseline={baseline}
            selectedScenario={selection.scenario}
            selectedSection={selection.section}
          />
        ) : (
          <div className="rounded-xl border border-dashed px-6 py-20 text-center">
            <p className="font-medium">No fidelity report yet</p>
            <p className="mt-2 text-sm text-muted-foreground">Run and publish a simulation to see evidence-backed results here.</p>
          </div>
        )}
      </PageContainer>
    </main>
  );
}
