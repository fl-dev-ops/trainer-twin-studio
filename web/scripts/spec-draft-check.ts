import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { specDraftBundleSchema } from "../lib/spec-draft-schema";

const DATA = path.join(import.meta.dirname, "../data");

const [agentDocument, domainDocument] = await Promise.all([
  readFile(path.join(DATA, "agents/full-mock-interview.yaml"), "utf8"),
  readFile(path.join(DATA, "domains/software-engineering-full-interview.yaml"), "utf8"),
]);
const agent = (yaml.load(agentDocument) as { agent: Record<string, unknown> }).agent;
const domain = (yaml.load(domainDocument) as { domain: Record<string, unknown> }).domain;
const result = specDraftBundleSchema.safeParse({
  slug: agent.id,
  name: agent.name,
  personaSlug: "neutral-technical-interviewer",
  agent,
  domain: { ...domain, knowledge_bases: ["software-engineering"] },
  grounding: [{
    knowledgeBase: "software-engineering",
    source: "interviewing.md",
    stageIds: ["technical"],
    purpose: "Ground technical-depth evaluation",
    queryGuidance: "Retrieve assessor references for the active technical topic",
    tags: ["technical"],
  }],
  assumptions: [],
  gaps: [],
});
assert.equal(result.success, true, result.error?.message);
assert.equal(specDraftBundleSchema.safeParse({}).success, false);
if (result.success) {
  const invalidAction = structuredClone(result.data);
  invalidAction.agent.config.actions.allowed[0] = "ask_question" as never;
  assert.equal(specDraftBundleSchema.safeParse(invalidAction).success, false);

  const invalidKnowledgeTool = structuredClone(result.data);
  invalidKnowledgeTool.agent.config.tools = ["knowledge.search" as never];
  assert.equal(specDraftBundleSchema.safeParse(invalidKnowledgeTool).success, false);
}
console.log("spec draft schema checks passed");
