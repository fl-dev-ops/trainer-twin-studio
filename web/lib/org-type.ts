import type { OrgType } from "@/lib/generated/prisma/enums";
import { getStoredRoleplay } from "@/lib/roleplay";

export type { OrgType };

/**
 * An organization's type decides two things only: which scenario configuration it
 * uses (role plays for sales, interview scenarios for technical interview) and
 * what those scenarios are called. Everything else in the UI is shared.
 */
export type OrgKey = "sales" | "technical";
export type ScenarioKind = "roleplay" | "twin";

export const ORG_TYPES = ["SALES", "TECHNICAL_INTERVIEW"] as const satisfies readonly OrgType[];

export const ORG_KEY: Record<OrgType, OrgKey> = {
  SALES: "sales",
  TECHNICAL_INTERVIEW: "technical",
};

export const SCENARIO_KIND: Record<OrgType, ScenarioKind> = {
  SALES: "roleplay",
  TECHNICAL_INTERVIEW: "twin",
};

export const ORG_COPY = {
  sales: {
    scenario: "Role play",
    scenarios: "Role plays",
    scenarioLower: "role play",
    scenariosLower: "role plays",
    newScenario: "New role play",
    exampleName: "Wait-and-see investor",
    trainer: "Sales trainer",
  },
  technical: {
    scenario: "Scenario",
    scenarios: "Scenarios",
    scenarioLower: "scenario",
    scenariosLower: "scenarios",
    newScenario: "New scenario",
    exampleName: "React mock interview",
    trainer: "Interview trainer",
  },
} as const satisfies Record<OrgKey, Record<string, string>>;

export type OrgCopy = (typeof ORG_COPY)[OrgKey];

export function isOrgType(value: unknown): value is OrgType {
  return typeof value === "string" && (ORG_TYPES as readonly string[]).includes(value);
}

export function orgCopy(type: OrgType): OrgCopy {
  return ORG_COPY[ORG_KEY[type]];
}

export function scenarioKindFor(type: OrgType): ScenarioKind {
  return SCENARIO_KIND[type];
}

/** The kind of a stored agent spec: role play when it carries `config.scenario.roleplay`, else a twin (interview). */
export function scenarioKindOf(agentData: unknown): ScenarioKind {
  return getStoredRoleplay(agentData) ? "roleplay" : "twin";
}

export function scenarioFitsOrg(type: OrgType, agentData: unknown): boolean {
  return scenarioKindOf(agentData) === SCENARIO_KIND[type];
}
