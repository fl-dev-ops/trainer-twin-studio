import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { buildSpecs } from "@/lib/runtime/compiler";
import { initRuntimeState, currentSessionStyle } from "@/lib/runtime/runtime";
import { renderStyledSpeech, contentDraft } from "@/lib/runtime/openai";

const DATA_DIR = path.resolve(import.meta.dir, "../data");

function loadConfig(agentSlug = "resume-mastery", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA_DIR, `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA_DIR, `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainYaml = fs.readFileSync(path.join(DATA_DIR, `domains/${agentData.domain}.yaml`), "utf8");
  const domainData = (yaml.load(domainYaml) as any).domain;

  return {
    persona: { id: "vasanth", slug: personaSlug, version: 1, data: personaData },
    agent: { id: "test-agent", slug: agentSlug, version: 1, data: agentData },
    domain: { slug: agentData.domain, version: 1, data: domainData },
    knowledgeBases: [],
  };
}

// Typical Vasanth style exemplars from transcripts (fillers, rhythm, acknowledgements)
const vasanthStyleExamples = [
  {
    id: "style-1",
    text: "Got it, that makes sense. So when you say you handled the migration, which specific components were you personally writing versus what the rest of the team took on?",
    learnerState: "clarified",
    sessionPhase: "middle" as const,
    score: 0.92,
  },
  {
    id: "style-2",
    text: "Right, understood. Looking at that architecture, what was the biggest bottleneck you encountered when scaling that up, and how did you measure it?",
    learnerState: "vague",
    sessionPhase: "middle" as const,
    score: 0.88,
  },
  {
    id: "style-3",
    text: "Cool. So before we jump into the trade-offs, could you walk me through the numbers? What kind of throughput were you actually seeing under peak load?",
    learnerState: "supported",
    sessionPhase: "middle" as const,
    score: 0.85,
  },
];

async function runComparison() {
  const specs = buildSpecs(loadConfig());
  const state = initRuntimeState();
  const current = currentSessionStyle([], null);

  const testCases = [
    {
      title: "Scenario A: Technical Performance & Latency Metrics",
      learnerInput: "We scaled our system to handle 50,000 requests per second by deploying a Redis cluster that cut p99 latency by 70%.",
      contentContract: "Acknowledge the 50,000 requests per second and 70 percent latency reduction, then ask what specific caching policy or invalidation logic the learner personally implemented.",
    },
    {
      title: "Scenario B: Architecture & System Design Trade-offs",
      learnerInput: "I built our payment processing pipeline with Stripe webhooks, Redis deduplication locks, and Postgres idempotency keys.",
      contentContract: "Acknowledge the payment processing pipeline with Stripe webhooks and idempotency keys, then probe on how they handled network retries or duplicate webhook delivery.",
    },
  ];

  for (const tc of testCases) {
    console.log("===============================================================================");
    console.log(`TESTING: ${tc.title}`);
    console.log("===============================================================================\n");
    console.log("Learner Input:", tc.learnerInput);
    console.log("Content Contract:", tc.contentContract, "\n");

    const draft = await contentDraft(
      tc.contentContract,
      {
        name: "probe",
        evidence_key: specs.agent.phases[0].evidence_keys[0],
        reason: "Probe technical details",
        intent: tc.contentContract,
        close: false,
        expects_answer: true,
      },
      specs,
      state,
      [{ role: "user", text: tc.learnerInput }],
      null,
      [],
      [],
      null
    );

    console.log("[RAW CONTENT DRAFT]:");
    console.log(draft);

    const rendered = await renderStyledSpeech(
      draft,
      tc.learnerInput,
      state,
      specs,
      vasanthStyleExamples,
      current
    );

    console.log("\n[STYLED REWRITE]:");
    console.log(rendered.text);

    console.log("\n[RENDERER METADATA]:");
    console.log("Fallback Triggered:", rendered.fallback);
    console.log("Flags:", rendered.flags);
    console.log("Spoken Words:", `${rendered.text.split(/\s+/).length} words`);
    console.log("\n");
  }
}

runComparison().catch(console.error);
