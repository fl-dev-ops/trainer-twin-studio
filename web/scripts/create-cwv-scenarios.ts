/**
 * Create the remaining 6 careerwithvasanth interview scenarios (Interview 2:
 * Fundamentals & Depth, Interview 3: Real-World Problem Solving & System Design)
 * from careerwithvasanth/scenarios.md. Interview 1's three rounds already exist.
 *
 * Clones the shape of the published "project-experience-deep-dive" scenario
 * (persona, voice, kb, actions, rendering) and creates Domain + Agent rows the
 * same way publishSpecDraft does, minus intro videos (provisioned operationally;
 * the runtime starts the greeting immediately when none is set).
 *
 * Idempotent: skips scenarios/domains that already exist.
 * Run: bun scripts/create-cwv-scenarios.ts
 */
import "dotenv/config";
import { db } from "../lib/db";

const ORG_ID = "699ffaba-70fa-4fd1-a4ed-d80da8f06bff"; // Acme
const TEMPLATE_SLUG = "project-experience-deep-dive";
const VOICE_ID = "cmtl8nn7x0004i9sevdlbb03n";

type EvidenceDef = Record<string, string>;

type ScenarioInput = {
  slug: string;
  name: string;
  objective: string;
  instruction: string;
  stageOpening: string;
  claimHandling: string;
  contextMode: string;
  contextRequired: boolean;
  evidenceKeys: string[];
  evidenceDefinitions: EvidenceDef;
  grounding: { tags: string[]; purpose: string; queryGuidance: string };
  domain: { slug: string; name: string; principles: string[] };
};

const CLASSIFICATIONS = {
  vague: "Plausible language lacks a concrete mechanism or example.",
  strong: "Relevant and concrete evidence satisfies the targeted lane.",
  partial: "A valid core is present but an important mechanism or condition is missing.",
  unknown: "The candidate clearly does not know or remember.",
  unsupported: "A material claim lacks evidence or justification.",
  contradictory: "The answer conflicts with a prior answer or explicit resume claim.",
  role_violation: "The candidate attempts to make the interviewer answer as the candidate.",
};

const SCENARIOS: ScenarioInput[] = [
  {
    slug: "fundamental-knowledge",
    name: "Fundamental Knowledge",
    objective: "Establish whether the candidate has the foundational knowledge required to reason about more advanced concepts.",
    instruction: `Focus: Establish whether the candidate has strong fundamentals.

Start with concepts relevant to the candidate's role and resume. Questions should begin at a basic level and gradually cover the breadth of important fundamentals.

For a frontend candidate, this could include:

- JavaScript fundamentals
- Browser and web fundamentals
- HTML/CSS
- React fundamentals
- Networking basics
- APIs and HTTP
- Basic performance concepts

The interviewer should avoid simply asking definitions. Instead, questions should check whether the candidate can explain a concept clearly and correctly.

Example:

"You mentioned that you built a payment system." — for fundamentals, a button click in a web application:

→ What happens in the browser?

→ How does JavaScript execute?

→ How does an event reach the handler?

→ What happens if the handler makes an API call?

The interviewer can use the candidate's answer to decide where to drill deeper.

Goal: Identify whether the candidate has the foundational knowledge required to reason about more advanced concepts.`,
    stageOpening: "Let's start with the fundamentals. Can you walk me through what happens in the browser from the moment you click a button in a web application?",
    claimHandling: "conceptual",
    contextMode: "resume_topics_only",
    contextRequired: false,
    evidenceKeys: [
      "concept_explanation",
      "mechanism_walkthrough",
      "terminology_accuracy",
      "breadth_of_fundamentals",
      "follow_up_correctness",
    ],
    evidenceDefinitions: {
      concept_explanation: "A clear, correct explanation of the concept rather than a recited definition.",
      mechanism_walkthrough: "An end-to-end account of what actually happens in the system for the concept in question.",
      terminology_accuracy: "Correct, precise use of technical terms.",
      breadth_of_fundamentals: "Coverage across the fundamental areas relevant to the candidate's role and resume.",
      follow_up_correctness: "The explanation stays correct when the interviewer drills into a follow-up.",
    },
    grounding: {
      tags: ["fundamentals", "javascript", "browser", "react", "networking", "http"],
      purpose: "Provide authoritative definitions and correct mental models for the fundamentals being probed.",
      queryGuidance: "When the candidate explains a fundamental concept, consult this knowledge base to verify the explanation is accurate and complete.",
    },
    domain: {
      slug: "domain-fundamentals-depth",
      name: "Software Engineering Fundamentals Assessment",
      principles: [
        "Depth is demonstrated by the ability to explain how and why, not by reciting definitions.",
        "Correct mental models matter more than memorized interview answers.",
        "The interviewer should follow the candidate's answers and drill wherever the answer invites depth.",
        "A strong candidate should naturally be taken deeper; shallow knowledge should be exposed through follow-ups.",
        "The objective is to discover how deep the candidate's understanding goes, not to ask the hardest possible questions.",
      ],
    },
  },
  {
    slug: "conceptual-understanding",
    name: "Conceptual Understanding",
    objective: "Distinguish candidates who have memorized concepts from candidates who have built a correct mental model of how the system works.",
    instruction: `Focus: Move beyond "what" and test whether the candidate understands how and why things work.

Once a fundamental concept is identified, progressively ask questions that expose the candidate's mental model.

Questions should explore:

- Why does something work this way?
- How does it work internally?
- What happens in different scenarios?
- What are the trade-offs?
- When would you use one approach over another?
- What happens at the edge cases?

Example:

"You mentioned that JavaScript is asynchronous."

→ What exactly is asynchronous?

→ Is JavaScript itself asynchronous?

→ What role does the event loop play?

→ What is the call stack?

→ Where do promises execute?

→ How are microtasks different from macrotasks?

→ What happens when there are many microtasks?

The interviewer should follow the candidate's answers rather than rigidly following a predefined question list.

Goal: Distinguish between candidates who have memorized concepts and candidates who have built a correct mental model of how the system works.`,
    stageOpening: "Let's go one level deeper on one of the concepts you just mentioned. How does it actually work internally, and why is it designed that way?",
    claimHandling: "conceptual",
    contextMode: "resume_topics_only",
    contextRequired: false,
    evidenceKeys: [
      "mental_model_accuracy",
      "why_not_what",
      "internal_mechanics",
      "tradeoff_awareness",
      "edge_case_behavior",
    ],
    evidenceDefinitions: {
      mental_model_accuracy: "The candidate's description of the concept matches how the system actually works.",
      why_not_what: "The candidate explains why something works the way it does, not just what it does.",
      internal_mechanics: "Knowledge of the internal mechanism (event loop, call stack, reconciliation, and similar).",
      tradeoff_awareness: "Articulated trade-offs and when one approach would be chosen over another.",
      edge_case_behavior: "Correct reasoning about what happens in edge cases or unusual scenarios.",
    },
    grounding: {
      tags: ["event-loop", "async-javascript", "react-internals", "rendering", "trade-offs"],
      purpose: "Provide the internal mechanics and edge-case behavior needed to verify the candidate's mental model.",
      queryGuidance: "When the candidate explains how or why a mechanism works, consult this knowledge base to check the internal details and edge cases.",
    },
    domain: {
      slug: "domain-fundamentals-depth",
      name: "Software Engineering Fundamentals Assessment",
      principles: [],
    },
  },
  {
    slug: "depth-reasoning-application",
    name: "Depth & Application",
    objective: "Determine the candidate's depth of knowledge and ability to reason from first principles, rather than their ability to recall prepared interview answers.",
    instruction: `Focus: Push the candidate beyond theoretical knowledge and test whether they can apply fundamentals to unfamiliar situations.

The interviewer should take a concept the candidate appears comfortable with and introduce increasingly complex scenarios.

Questions can involve:

- Debugging
- Performance problems
- Unexpected behaviour
- Architecture decisions
- Edge cases
- Trade-offs
- Hypothetical scenarios
- Combining multiple fundamental concepts

Example:

"Your React application is becoming slow when rendering a large list. What would you investigate?"

→ How would you identify the bottleneck?

→ What happens during rendering?

→ What causes a component to re-render?

→ How does reconciliation work?

→ When would memoization help?

→ When would it not help?

→ What if the data itself changes frequently?

→ Would virtualization solve the problem?

The interviewer should continue drilling until the candidate reaches the boundary of their understanding.

Goal: Determine the candidate's depth of knowledge and ability to reason from first principles, rather than their ability to recall prepared interview answers.`,
    stageOpening: "Let's stress-test one of your fundamentals with a real problem. Your application has become noticeably slow when rendering a large list — how would you start investigating?",
    claimHandling: "conceptual",
    contextMode: "resume_topics_only",
    contextRequired: false,
    evidenceKeys: [
      "bottleneck_identification",
      "debugging_methodology",
      "first_principles_reasoning",
      "concept_integration",
      "depth_boundary_honesty",
    ],
    evidenceDefinitions: {
      bottleneck_identification: "A systematic way of locating the actual cause of a performance or behavior problem.",
      debugging_methodology: "An ordered, hypothesis-driven investigation rather than guessing at fixes.",
      first_principles_reasoning: "Reasoning from fundamentals to unfamiliar or complex problems.",
      concept_integration: "Combining multiple fundamental concepts coherently within one scenario.",
      depth_boundary_honesty: "Recognizing and stating the boundary of their own understanding rather than bluffing.",
    },
    grounding: {
      tags: ["debugging", "performance", "virtualization", "memoization", "reconciliation"],
      purpose: "Provide the technical detail needed to judge the candidate's applied reasoning in unfamiliar scenarios.",
      queryGuidance: "When the candidate reasons through a debugging or performance scenario, consult this knowledge base for the relevant mechanisms and best practices.",
    },
    domain: {
      slug: "domain-fundamentals-depth",
      name: "Software Engineering Fundamentals Assessment",
      principles: [],
    },
  },
  {
    slug: "problem-understanding-requirements",
    name: "Problem Understanding & Requirements",
    objective: "Evaluate whether the candidate can understand the actual problem before attempting to solve it.",
    instruction: `Focus: Evaluate how the candidate approaches an unfamiliar problem before jumping into a solution.

The interviewer should present a realistic problem with intentionally incomplete requirements.

The candidate should be expected to:

- Clarify the problem statement.
- Identify functional requirements.
- Identify non-functional requirements.
- Ask relevant questions about users, scale, traffic, data, and constraints.
- Identify assumptions.
- Define what is in scope and out of scope.
- Break the problem into smaller components.

The interviewer should avoid giving all requirements upfront. Important information can be revealed based on the candidate's questions.

Example:

"Design a system that allows users to upload and share large files."

A strong candidate should start asking:

→ Who are the users?

→ How large can files be?

→ How many users do we expect?

→ Are uploads resumable?

→ Can multiple users access the same file?

→ Do we need real-time progress?

→ What are the security requirements?

→ How long should files be retained?

Goal: Evaluate whether the candidate can understand the actual problem before attempting to solve it.`,
    stageOpening: "I'd like to work through a design problem together. Here is the situation: we need a system that allows users to upload and share large files. Before designing anything, what would you want to know?",
    claimHandling: "hypothetical_design",
    contextMode: "scenario_only",
    contextRequired: false,
    evidenceKeys: [
      "clarifying_questions",
      "functional_requirements",
      "nonfunctional_requirements",
      "explicit_assumptions",
      "scope_definition",
      "problem_decomposition",
    ],
    evidenceDefinitions: {
      clarifying_questions: "Relevant questions about users, scale, traffic, data, and constraints before designing.",
      functional_requirements: "Concrete functional requirements identified from the problem statement.",
      nonfunctional_requirements: "Scale, latency, availability, security, and cost requirements surfaced.",
      explicit_assumptions: "Assumptions stated explicitly rather than silently baked into the design.",
      scope_definition: "A clear in-scope versus out-of-scope boundary.",
      problem_decomposition: "Breaking the problem into smaller, addressable components.",
    },
    grounding: {
      tags: ["system-design", "requirements-gathering", "scoping", "scale", "constraints"],
      purpose: "Provide design-interview norms and requirement categories so the interviewer can reveal constraints progressively.",
      queryGuidance: "When the candidate asks about users, scale, or constraints, consult this knowledge base for realistic values and requirement categories to reveal.",
    },
    domain: {
      slug: "domain-real-world-system-design",
      name: "Real-World System Design Assessment",
      principles: [
        "The signal is how the candidate thinks: clarify, break down, design, explain trade-offs, identify weaknesses, adapt.",
        "The perfect architecture is not required; coherent reasoning under constraints is.",
        "New constraints should be introduced progressively and earlier decisions should be revisited when the situation changes.",
        "Assumptions, trade-offs, and priorities must be made explicit.",
        "Evaluate the reasoning process, not only the final architecture.",
      ],
    },
  },
  {
    slug: "system-design-solution-development",
    name: "System Design & Solution",
    objective: "Evaluate whether the candidate can create a coherent end-to-end system, rather than listing technologies or drawing disconnected boxes.",
    instruction: `Focus: Evaluate how the candidate converts requirements into a practical technical solution.

Once the requirements are established, the candidate should design the system progressively.

The discussion can cover:

- High-level architecture
- Major components
- Data flow
- APIs
- Data storage
- Caching
- Communication between services
- Frontend/backend responsibilities
- Error handling
- Security
- Performance considerations
- Technology choices

The interviewer should ask the candidate to explain why each major decision was made.

Example, continuing the file-upload system:

→ How would the frontend upload the file?

→ Would the file go through the backend?

→ How would you handle large files?

→ How would resumable uploads work?

→ Where would files be stored?

→ How would another user download the file?

→ How would you prevent unauthorized access?

→ How would the frontend show upload progress?

Goal: Evaluate whether the candidate can create a coherent end-to-end system, rather than listing technologies or drawing disconnected boxes.`,
    stageOpening: "Now that we've clarified the requirements, walk me through your design for this system end to end.",
    claimHandling: "hypothetical_design",
    contextMode: "scenario_only",
    contextRequired: false,
    evidenceKeys: [
      "coherent_architecture",
      "data_flow",
      "api_and_storage",
      "decision_justification",
      "error_handling_security",
      "frontend_backend_split",
    ],
    evidenceDefinitions: {
      coherent_architecture: "A coherent end-to-end architecture with identifiable major components.",
      data_flow: "A clear description of how data moves through the system.",
      api_and_storage: "Concrete API surface and storage choices that fit the requirements.",
      decision_justification: "Why each major decision was made, including alternatives considered.",
      error_handling_security: "Failure handling and access control addressed concretely.",
      frontend_backend_split: "A clear division of responsibilities between frontend and backend.",
    },
    grounding: {
      tags: ["architecture", "apis", "storage", "caching", "security", "uploads"],
      purpose: "Provide standard architecture patterns and their trade-offs so the interviewer can probe design choices.",
      queryGuidance: "When the candidate describes a component or technology choice, consult this knowledge base for the standard pattern, alternatives, and failure modes to probe.",
    },
    domain: {
      slug: "domain-real-world-system-design",
      name: "Real-World System Design Assessment",
      principles: [],
    },
  },
  {
    slug: "scale-tradeoffs-evolution",
    name: "Scale, Trade-offs & Evolution",
    objective: "Determine whether the candidate can reason under changing constraints, understand trade-offs, and evolve a system rather than presenting a pre-prepared architecture.",
    instruction: `Focus: Test how the candidate reacts when the initial design is challenged.

Once the candidate has proposed a solution, the interviewer should introduce new constraints and unexpected scenarios.

For example:

"Your system is now being used by 10 million users."

Then progressively introduce challenges:

- Traffic increases 10x.
- A critical service becomes unavailable.
- Database performance degrades.
- A particular API becomes a bottleneck.
- Users experience high latency in certain regions.
- A large number of users perform the same operation simultaneously.
- Data consistency becomes an issue.
- Infrastructure costs become too high.
- A security vulnerability is discovered.

The candidate should explain:

- What breaks first?
- How would they identify the bottleneck?
- How would they modify the architecture?
- What trade-offs are introduced?
- What would they prioritize?
- What would they monitor?
- How would they handle failure?
- What would they deliberately not optimize?

The interviewer can also challenge previous decisions:

"Earlier you chose approach A. Now that traffic has increased 10x, would you still choose it?"

Goal: Determine whether the candidate can reason under changing constraints, understand trade-offs, and evolve a system rather than simply presenting a pre-prepared architecture.`,
    stageOpening: "Your design just went live and jumped from thousands to 10 million users. What breaks first, and how would you handle it?",
    claimHandling: "hypothetical_design",
    contextMode: "scenario_only",
    contextRequired: false,
    evidenceKeys: [
      "failure_first_identification",
      "bottleneck_diagnosis",
      "architecture_adaptation",
      "tradeoff_articulation",
      "prioritization",
      "decision_revisiting",
    ],
    evidenceDefinitions: {
      failure_first_identification: "A reasoned answer to what breaks first under the new constraint.",
      bottleneck_diagnosis: "How they would identify and verify the actual bottleneck.",
      architecture_adaptation: "A concrete, coherent modification of the design rather than a list of buzzwords.",
      tradeoff_articulation: "Trade-offs named explicitly, including what they would deliberately not optimize.",
      prioritization: "What they would fix first and why, under constrained resources.",
      decision_revisiting: "Willingness to revisit earlier decisions when constraints change, with honest reasoning.",
    },
    grounding: {
      tags: ["scaling", "trade-offs", "failures", "consistency", "monitoring", "cost"],
      purpose: "Provide scale numbers, failure modes, and evolution patterns so the interviewer can introduce challenges progressively.",
      queryGuidance: "When introducing a new constraint or challenge, consult this knowledge base for realistic failure modes and scaling patterns to press on.",
    },
    domain: {
      slug: "domain-real-world-system-design",
      name: "Real-World System Design Assessment",
      principles: [],
    },
  },
];

const template = await db.agent.findUnique({ where: { slug: TEMPLATE_SLUG } });
if (!template) throw new Error(`Template scenario ${TEMPLATE_SLUG} not found`);
const tpl = template.data as Record<string, any>;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

let created = 0;
for (const input of SCENARIOS) {
  const domain = input.domain;
  const existingDomain = await (db as any).domain.findUnique({ where: { slug: domain.slug } });
  if (!existingDomain) {
    await (db as any).domain.create({
      data: {
        slug: domain.slug,
        name: domain.name,
        version: 1,
        orgId: ORG_ID,
        data: {
          id: domain.slug,
          name: domain.name,
          version: 1,
          principles: domain.principles,
          classifications: CLASSIFICATIONS,
          knowledge_bases: ["acme-knowledge"],
        },
      },
    });
    console.log(`+ domain ${domain.slug}`);
  }

  if (await db.agent.findUnique({ where: { slug: input.slug } })) {
    console.log(`= scenario ${input.slug} already exists, skipping`);
    continue;
  }

  const stageConfig = clone(tpl.stages[0].config);
  stageConfig.claim_handling = input.claimHandling;
  stageConfig.context.mode = input.contextMode;
  stageConfig.evidence.keys = input.evidenceKeys;
  stageConfig.evidence.definitions = input.evidenceDefinitions;

  const data: Record<string, unknown> = {
    id: input.slug,
    name: input.name,
    config: {
      ...clone(tpl.config),
      claim_handling: input.claimHandling,
      context: { mode: input.contextMode, required: input.contextRequired },
    },
    domain: domain.slug,
    stages: [
      {
        id: input.slug,
        name: input.name,
        config: stageConfig,
        opening: input.stageOpening,
        objective: input.objective,
      },
    ],
    opening: tpl.opening,
    version: 2,
    voiceId: VOICE_ID,
    objective: input.objective,
    instruction: input.instruction,
    knowledgeBase: tpl.knowledgeBase,
    knowledge_grounding: [
      {
        tags: input.grounding.tags,
        source: "trainer_provided",
        purpose: input.grounding.purpose,
        stageIds: [input.slug],
        knowledgeBase: tpl.knowledgeBase,
        queryGuidance: input.grounding.queryGuidance,
      },
    ],
  };

  await db.agent.create({
    data: {
      slug: input.slug,
      name: input.name,
      version: 1,
      domainSlug: domain.slug,
      personaId: template.personaId,
      visibility: "public",
      orgId: ORG_ID,
      data,
    },
  });
  created += 1;
  console.log(`+ scenario ${input.slug}`);
}

console.log(`Done: ${created} scenarios created`);
await db.$disconnect();
