import { CalibrationReview } from "@/components/calibration/calibration-review";
import { DEMO_CALIBRATION, type CalibrationTurn } from "@/components/calibration/mock";

const MOCK_CALIB_CONVERSATIONS: Record<
  string,
  {
    title: string;
    turns: CalibrationTurn[];
  }
> = {
  "cal-prices": {
    title: "Handling “prices will drop next year”",
    turns: [
      { id: "1", speaker: "you", text: "A buyer tells me prices will drop next year. What do I say?" },
      {
        id: "2",
        speaker: "twin",
        text: "I’d ask what they’ll do with the money while they wait. Then I’d put a year of rent next to today’s payment plan, so waiting becomes a number, not an opinion.",
        rating: "like",
      },
      { id: "3", speaker: "you", text: "And if a seller wants me to cut my fee to one percent?" },
      {
        id: "4",
        speaker: "twin",
        text: "I wouldn’t cut it. I’d name the work: photography, viewings, negotiation and paperwork. Then I’d ask which part they’d like me to skip.",
        rating: "like",
      },
      { id: "5", speaker: "you", text: "What about a landlord who wants to hang up on a cold call?" },
      {
        id: "6",
        speaker: "twin",
        text: "Stay brief. Say who you are, why you’re calling, and offer to text two comparable sales. Then let them go.",
        rating: "off",
      },
    ],
  },
  "cal-fee": {
    title: "Pushing back on a one percent fee",
    turns: [
      { id: "1", speaker: "you", text: "A seller wants me to cut my fee to one percent. How do I respond?" },
      {
        id: "2",
        speaker: "twin",
        text: "I wouldn’t cut it. I’d name the work: photography, viewings, negotiation and paperwork. Then I’d ask which part they’d like me to skip.",
        rating: "like",
      },
      { id: "3", speaker: "you", text: "Good. Add a line about the last property I sold above asking." },
      {
        id: "4",
        speaker: "twin",
        text: "Got it. I’ll mention the Marina listing that closed above asking in nine days, right after the work list.",
        rating: "like",
      },
    ],
  },
};

export default async function TwinCalibrationReviewRoute({
  params,
}: {
  params: Promise<{ id: string; calibId: string }>;
}) {
  const { id, calibId } = await params;
  const calib = MOCK_CALIB_CONVERSATIONS[calibId] || {
    title: "Handling the weakness question",
    turns: DEMO_CALIBRATION.turns,
  };

  const twinName = id === "olga-twin" ? "Olga’s twin" : "The off-plan sales process";

  return (
    <CalibrationReview
      backHref={`/twin/${id}/calibration`}
      twinName={twinName}
      startedAt={new Date(Date.now() - 3600_000 * 4).toISOString()}
      turns={calib.turns}
    />
  );
}
