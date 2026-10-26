// shortcut: past calibrations aren't stored yet, so the review page shows this sample; replace once ratings are saved.

export type Rating = "like" | "off";
export type CalibrationTurn = { id: string; speaker: "you" | "twin"; text: string; rating?: Rating };

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
