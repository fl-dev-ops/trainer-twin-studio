import { defineDynamic, defineInstructions } from "eve/instructions";
import { callStudioAs, organizationId } from "../lib/studio";

type Organization = {
  name: string;
  type: "SALES" | "TECHNICAL_INTERVIEW";
};

const SALES = `## Organization: sales

This organization builds **role plays**. The AI plays a client (a buyer, investor, landlord, prospect and so on) and the learner practises a sales conversation with them. Always call them "role plays". Never offer interview scenarios, interview stages, question counts or topics.

- Do not load the \`spec-builder\` skill and never call \`save_spec_draft\`; the Studio rejects interview specs for this organization. Save with \`save_roleplay_draft\` instead.
- Gather the role play one focused question at a time, skipping anything the trainer already gave:
  1. A short name.
  2. The scenario: who the client is, what happened before the call, and what they say on the surface.
  3. What's really going on: the hidden fear or motive, revealed only when the learner earns it.
  4. The learner's role (for example "Agent calling a wait-and-see investor").
  5. Up to five learner goals. These are what the learner is scored on; each is one observable behaviour.
  6. How the call can end: when the client agrees and when they decline.
  7. Who the learner speaks with: a client persona from \`studio_inventory\` (\`client: true\`). If none fits, say so; do not invent one.
  8. The client's character: Warm & Open, Warm but Cautious, Curious & Probing, Skeptical & Reserved, or Direct & Challenging.
  9. Difficulty: easy, medium, hard or hardest.
  10. How they talk, what makes them more guarded, and what makes them open up.
  11. The opening line the client says.
  12. The scoring rubric: named criteria whose points add up to exactly 100. Offer a starting point (sales call, cold call, wait-and-see investor, options collector, fee push-back) and let the trainer edit it.
- Knowledge bases may inform realistic objections and market facts. The client is an invented character, never a twin of the trainer.
- Publish only when the trainer explicitly asks, with \`publish_spec_draft\`.`;

const TECHNICAL_INTERVIEW = `## Organization: technical interview

This organization builds **interview scenarios**: the AI is the interviewer and the learner is the candidate. Always call them "scenarios". Follow the product workflow and the \`spec-builder\` skill. Never create role plays and never call \`save_roleplay_draft\`; the Studio rejects them for this organization.`;

/** Tells the Copilot which kind of scenario this organization builds, at the start of each session. */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const org = await callStudioAs<Organization>({ action: "organization" }, organizationId(ctx.session));
        return defineInstructions({ content: org.type === "SALES" ? SALES : TECHNICAL_INTERVIEW });
      } catch {
        // Without the organization the static instructions apply; the Studio still rejects the wrong kind on save.
        return null;
      }
    },
  },
});
