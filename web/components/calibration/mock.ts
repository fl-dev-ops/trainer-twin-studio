import type { SourceKind } from "@/components/calibration/call-icons";

// shortcut: calibration UI runs on this mock data, replace with the live call + TurnRating API once the backend lands.

export type Rating = "like" | "off";
export type CalibrationTurn = { id: string; speaker: "you" | "twin"; text: string; rating?: Rating };
export type AnswerSource = { title: string; kind: SourceKind; meta: string };

/** What the twin and the trainer say in the demo call, revealed one turn at a time. */
export const DEMO_SCRIPT: CalibrationTurn[] = [
  {
    id: "t1",
    speaker: "twin",
    text: "Hi! I’m your twin. I’ve learnt how you run these conversations. Ask me anything your learners would, and I’ll answer the way you would.",
  },
  { id: "t2", speaker: "you", text: "A learner freezes when I ask about their biggest weakness. What do I tell them?" },
  {
    id: "t3",
    speaker: "twin",
    text: "I’d tell them to pick a real weakness, say what they did about it last month, and stop there. Short and honest beats polished.",
  },
  { id: "t4", speaker: "you", text: "And if they ramble during the project deep dive?" },
  {
    id: "t5",
    speaker: "twin",
    text: "I’d ask for the one decision they owned, then the result. Everything else can wait for my follow-up question.",
  },
];

/** What the twin says after "Feels off" (the prototype asks why, then tries again). */
export const FEELS_OFF_FOLLOW_UP = "Why do you feel the response feels off? Tell me and I’ll answer it again the way you would.";

export const DEMO_WHY = {
  summary:
    "A learner freezing on the weakness question is something you cover in your interview playbook. I used your “one real weakness, one recent action” structure.",
  total: 12,
  sources: [
    { title: "Course deck: Interview playbook", kind: "slides", meta: "Slides · Module 2 · Answering the weakness question" },
    { title: "Coaching notes", kind: "notion", meta: "Notion · Your workspace · Short answers beat polished ones" },
    { title: "Feedback guide", kind: "doc", meta: "Doc · Course materials · When to stop a learner" },
    { title: "Mock interview walkthrough", kind: "video", meta: "YouTube · 09:48 · Owning one decision" },
    { title: "Project deep dive worksheet", kind: "doc", meta: "Google Doc · Shared with learners · Decision, then result" },
  ] satisfies AnswerSource[],
};

/** A finished calibration, as shown on its review page. */
export const DEMO_CALIBRATION = {
  id: "demo",
  title: "Handling the weakness question",
  startedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
  turns: [
    { id: "p1", speaker: "you", text: "A learner says their biggest weakness is perfectionism. How do I respond?" },
    {
      id: "p2",
      speaker: "twin",
      text: "I’d stop them there and ask for a real one. Then I’d ask what they changed last month because of it.",
      rating: "like",
    },
    { id: "p3", speaker: "you", text: "Good. Add a line about why interviewers ask it at all." },
    {
      id: "p4",
      speaker: "twin",
      text: "Got it. I’ll say we’re checking self-awareness, not looking for flaws, right before asking for the real weakness.",
      rating: "like",
    },
  ] satisfies CalibrationTurn[],
};
