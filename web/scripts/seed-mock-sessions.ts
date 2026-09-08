/**
 * Seed realistic mock interview sessions for the careerwithvasanth org.
 * Idempotent: exits early when the mock learners already exist.
 * Run: bun scripts/seed-mock-sessions.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";

const ORG_ID = "2aaf04e6-3c63-460f-992a-be261adfd421"; // careerwithvasanth
const EXISTING_LEARNER_ID = "Yeiu3EIXiuhCX7mqOsxMafklu4TzOwSf"; // Surya Umapathy
const PERSONA = { slug: "vasanth", version: 3 };

const MOCK_LEARNERS = [
  { name: "Aarav Sharma", email: "aarav.sharma@example.com" },
  { name: "Neha Reddy", email: "neha.reddy@example.com" },
  { name: "Imran Khan", email: "imran.khan@example.com" },
];

type Turn = { role: "user" | "trainer"; text: string };

type Scenario = {
  slug: string;
  domainSlug: string;
  evidenceKeys: [string, boolean][];
  opening: string;
  rounds: { trainer: string; user: string }[];
  closing: string;
};

const SCENARIOS: Scenario[] = [
  {
    slug: "resume-mastery",
    domainSlug: "software-engineering-resume",
    evidenceKeys: [
      ["ownership-language", true],
      ["mechanism-for-quantified-claims", true],
      ["incident-awareness", false],
      ["calibrated-uncertainty", true],
    ],
    opening:
      "Let's start with the claim you're most confident about on your resume. Read it out, then tell me exactly what you did versus what your team did.",
    rounds: [
      {
        trainer:
          "You wrote 'reduced API latency by 40%'. Walk me through the mechanism — what specifically made it faster, and how did you measure the 40%?",
        user: "We had N+1 queries on the orders endpoint. I added a dataloader that batches lookups per request, and I measured p95 with a k6 load test before and after — 340ms down to 205ms over five runs.",
      },
      {
        trainer:
          "Was the 40% your work alone, or did teammates touch caching too? I'm probing ownership language, not doubting the number.",
        user: "The batching was mine end to end. A teammate added the Redis cache layer in the same sprint, so I'd say the headline number is shared — my isolated contribution was closer to 25%.",
      },
      {
        trainer:
          "Good calibration. Now, your resume mentions you 'handled production incidents'. Tell me about one incident where your initial diagnosis was wrong.",
        user: "Honestly, I was on-call support for two incidents but the root-cause analysis was led by my lead. I don't have an incident I personally misdiagnosed and fixed — I should rephrase that line.",
      },
      {
        trainer:
          "Exactly the honesty I want. If you keep the claim, what would make it defensible in an interview?",
        user: "I'd change it to 'triaged and escalated production incidents using Sentry traces', which I can defend with the actual runbooks I wrote for the on-call rotation.",
      },
    ],
    closing:
      "You defended your numbers with mechanisms and you downgraded a claim you couldn't support — that's precisely what this exercise builds. Rework the incident line before your next round.",
  },
  {
    slug: "real-world-system-design",
    domainSlug: "software-engineering-system-design",
    evidenceKeys: [
      ["clarify-requirements-first", true],
      ["coherent-data-flow", true],
      ["trade-off-explicit", false],
      ["failure-adaptation", true],
    ],
    opening:
      "Design a notification service that sends transactional email and push for a food-delivery app serving 200k orders a day. Start wherever you like.",
    rounds: [
      {
        trainer:
          "Before architecture — which of those notifications are latency-critical, and what does 'delivered' mean for a push that never gets opened?",
        user: "Order-status events are latency-critical, target under 5s. Delivery means accepted by FCM/APNs, not opened. Promotions can batch overnight, so I'd split the two paths entirely.",
      },
      {
        trainer:
          "Sketch the happy path: order placed, what components see that event and in what order?",
        user: "Order service emits to Kafka. A dispatcher consumer groups events per user, dedupes with a Redis set keyed by order-id-event-type, then fans out to an email worker and a push worker. Each worker marks sent in Postgres so retries are idempotent.",
      },
      {
        trainer:
          "Kafka partition for a user becomes slow and the consumer lag hits 60 seconds during a dinner rush. What breaks, and what do you change?",
        user: "Status notifications arrive late — the worst kind for us. I'd add a small inline publish for just the 'order confirmed' event type and let everything else lag, accepting eventual consistency for promotions. Cost: two code paths to maintain.",
      },
      {
        trainer:
          "You named a cost — good. What happens when a customer has three devices and one token is stale?",
        user: "FCM returns unregistered for that token. The push worker removes it from the device registry immediately and continues with the other two, so one bad token can't fail the batch.",
      },
    ],
    closing:
      "You asked for requirements before drawing boxes, adapted under a realistic failure, and named the trade-off. Next time, quantify the dispatcher's throughput ceiling.",
  },
  {
    slug: "fundamentals-depth",
    domainSlug: "software-engineering-fundamentals",
    evidenceKeys: [
      ["correct-mental-model", true],
      ["mechanism-over-definition", true],
      ["edge-case-prediction", true],
      ["trade-off-reasoning", false],
    ],
    opening:
      "Forget definitions for a moment. Two HTTP requests hit your server at the same millisecond. What actually happens?",
    rounds: [
      {
        trainer:
          "Take it a layer down — the OS received both packets. What decides which bytes your application sees first?",
        user: "The kernel accepts connections into a backlog queue, the event loop picks up readable sockets in registration order, and with Node each request's callback runs on the same thread until it hits I/O, so interleaving happens at await boundaries, not between requests.",
      },
      {
        trainer:
          "Now predict: if one request does a synchronous 200ms JSON parse of a 50MB payload, what does the second request experience?",
        user: "It waits. The event loop is blocked, so its response is delayed by the full 200ms even though its own work is trivial. That's why streaming parsers exist for large payloads.",
      },
      {
        trainer:
          "Why can't the kernel just schedule that parse on another core — where exactly does the 'one thread' story break?",
        user: "Because the parse happens in V8 on the main thread; the kernel only schedules threads the process creates. Worker threads exist, but you pay serialization cost to move 50MB across them, so for one-off requests it's usually a net loss.",
      },
      {
        trainer:
          "Last one: your API returns different results for the same GET request twice in a row. Is that a violation of REST?",
        user: "Not by itself — REST requires safe and idempotent semantics for GET, not deterministic responses. A 'GET' that triggers an email would be the violation.",
      },
    ],
    closing:
      "You predicted behavior instead of reciting definitions, and the worker-thread trade-off answer showed a real cost model. Solid depth session.",
  },
];

function daysAgo(days: number, hour: number, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function buildTranscript(scenario: Scenario, roundCount: number, status: string): Turn[] {
  const turns: Turn[] = [{ role: "trainer", text: scenario.opening }];
  for (const round of scenario.rounds.slice(0, roundCount)) {
    turns.push({ role: "user", text: round.user });
    turns.push({ role: "trainer", text: round.trainer });
  }
  if (status === "completed") {
    turns.push({ role: "user", text: "Thanks — this gave me a much clearer picture of what to tighten." });
    turns.push({ role: "trainer", text: scenario.closing });
  }
  // Abandoned/active sessions end mid-probe, awaiting the learner's reply.
  return turns;
}

function evidenceObject(scenario: Scenario, strong: boolean): Record<string, boolean> {
  return Object.fromEntries(scenario.evidenceKeys.map(([key, value]) => [key, strong ? value : false]));
}

async function main() {
  const org = await db.organization.findUnique({ where: { id: ORG_ID } });
  if (!org) throw new Error(`Org ${ORG_ID} not found`);

  // Idempotent re-run: learners are the marker; refresh their mock sessions.
  const learnerEmails = ["surya@gmail.com", ...MOCK_LEARNERS.map((l) => l.email)];
  const known = await db.user.findMany({
    where: { email: { in: learnerEmails } },
    select: { id: true },
  });
  if (known.length > 0) {
    const removed = await db.interviewSession.deleteMany({
      where: { orgId: ORG_ID, userId: { in: known.map((u) => u.id) } },
    });
    console.log(`Refreshed: removed ${removed.count} previous mock sessions.`);
  }

  const agents = await db.agent.findMany({ where: { orgId: ORG_ID } });
  const learnerIds = [EXISTING_LEARNER_ID];
  for (const learner of MOCK_LEARNERS) {
    let user = await db.user.findUnique({ where: { email: learner.email } });
    if (!user) {
      user = await db.user.create({
        data: {
          id: randomUUID().replace(/-/g, "").slice(0, 32).padEnd(30, "0"),
          name: learner.name,
          email: learner.email,
          emailVerified: true,
        },
      });
      await db.member.create({
        data: { id: randomUUID(), organizationId: ORG_ID, userId: user.id, role: "member", createdAt: new Date() },
      });
    }
    learnerIds.push(user.id);
  }

  // Session plan: [scenarioSlug, learnerIndex, daysAgo, hour, status, roundCount]
  const plan: Array<[string, number, number, number, "completed" | "abandoned" | "active", number]> = [
    ["fundamentals-depth", 0, 20, 10, "completed", 4],
    ["resume-mastery", 1, 18, 15, "completed", 4],
    ["fundamentals-depth", 1, 16, 11, "completed", 3],
    ["real-world-system-design", 2, 14, 16, "completed", 2],
    ["resume-mastery", 0, 12, 9, "completed", 4],
    ["fundamentals-depth", 3, 10, 14, "abandoned", 1],
    ["real-world-system-design", 1, 8, 17, "completed", 4],
    ["fundamentals-depth", 2, 6, 10, "completed", 2],
    ["resume-mastery", 2, 5, 12, "completed", 3],
    ["real-world-system-design", 0, 4, 11, "completed", 3],
    ["fundamentals-depth", 1, 3, 9, "abandoned", 1],
    ["resume-mastery", 3, 2, 15, "completed", 2],
    ["real-world-system-design", 3, 1, 10, "completed", 2],
    ["fundamentals-depth", 0, 0, 9, "active", 2],
  ];

  let created = 0;
  for (const [slug, learnerIndex, days, hour, status, roundCount] of plan) {
    const scenario = SCENARIOS.find((s) => s.slug === slug)!;
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) throw new Error(`Agent ${slug} not found in org`);
    const startedAt = daysAgo(days, hour, 10 + (created % 40));
    const durationMin = 8 + roundCount * 4;
    // Completed sessions get evidence coverage; in-flight/abandoned ones don't
    // (evaluation only happens when a session finalizes).
    await db.interviewSession.create({
      data: {
        orgId: ORG_ID,
        userId: learnerIds[learnerIndex],
        agentId: agent.id,
        shareCode: randomUUID().replaceAll("-", "").slice(0, 12),
        personaSlug: PERSONA.slug,
        personaVersion: PERSONA.version,
        agentSlug: agent.slug,
        agentVersion: agent.version,
        domainSlug: scenario.domainSlug,
        domainVersion: 1,
        status,
        startedAt,
        ...(status === "completed" || status === "abandoned"
          ? { endedAt: new Date(startedAt.getTime() + durationMin * 60_000) }
          : {}),
        transcript: buildTranscript(scenario, roundCount, status),
        ...(status === "completed" ? { evidence: evidenceObject(scenario, roundCount > 2) } : {}),
      },
    });
    created++;
  }
  console.log(`Seeded ${created} mock sessions for ${MOCK_LEARNERS.length + 1} learners in "${org.name}".`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
