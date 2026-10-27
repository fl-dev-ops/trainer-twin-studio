# Preset personas

Preset (non-own, `isOwn: false`) personas that learners talk to in role plays, one JSON file each, grouped by client. Each file holds the prompt fields and program settings defined in `plans/persona-fields.md`, plus short `voice` and `avatar` briefs for sourcing media later (no media files here). Difficulty is deliberately absent: it belongs to the role play. Olga's personas are Dubai real-estate clients that her agents call, grounded in her objection-handling workbook, objection scripts, off-plan messaging playbook and recorded role plays. Vasanth's personas are interviewers for his mock technical interviews, grounded in `web/data/agents`, `web/data/domains` and `web/data/personas/neutral-technical-interviewer.yaml`.

| Client | Slug | Name | Role | Who |
|---|---|---|---|---|
| olga | `off-plan-lead-waiting-for-prices` | Rohan Mehta | Prospect | Dubai-resident first-time investor from an off-plan ad who wants "details on WhatsApp" and will wait for prices to drop. |
| olga | `landlord-unexpected-call` | Khalid Al Mansoori | Landlord | Emirati owner of three rented apartments who did not expect the call and wants to know who gave out his number. |
| olga | `seller-comparing-one-percent` | Hannah Clarke | Seller | British owner relocating home, selling a vacant Marina two-bed and comparing a 1% non-exclusive offer. |
| olga | `overseas-investor-short-on-time` | Irina Volkova | Investor | Kazakhstan-based business owner with AED 2M and ten minutes, doubting projected ROI and exit before handover. |
| olga | `buyer-quiet-after-viewing` | Amira Haddad | Buyer | First-time family buyer who went quiet after a townhouse viewing; money worry hidden behind "talk to my husband". |
| vasanth | `senior-engineer-depth-probe` | Meera Raghavan | Senior engineer | Warm but rigorous principal engineer who probes mechanisms, predictions and trade-offs without giving answers. |
| vasanth | `engineering-manager-tradeoffs` | Daniel Okafor | Engineering manager | Time-pressed hiring manager who pushes on ownership, measured impact and trade-offs. |

## Gaps

The option lists in `plans/persona-fields.md` were written for sales clients. For interviewers (Vasanth) these do not fit:

- **Role.** None of the eight roles describes an interviewer, and the prompt meanings ("you want to buy", "you own rental property") would mislead the model. The two interviewer roles used here (`Senior engineer`, `Engineering manager`) have no meaning sentence yet. Proposed meanings:
  - **Technical interviewer:** You run a structured technical round and judge the candidate only on what they show in this call.
  - **Senior engineer:** You are a future peer; you test whether the candidate truly understands how things work, not just the terms.
  - **Engineering manager:** You are hiring for your team; you test ownership, impact and judgement under trade-offs.
  - **Hiring manager:** You make the final hiring call; you test fit for the role, clarity and evidence behind claims.
- **Behaviours.** Every meaning is written about buying and about "the agent": "Warm & Open … you still will not buy on this call", "Warm but Cautious … hold back anything personal until trust is earned", "Curious & Probing … want to understand before you share", "Skeptical & Reserved … doubt what agents say", "Direct & Challenging … test whether the agent knows their stuff". The labels were reused here for their surface sense only. Proposed interviewer behaviours:
  - **Supportive & Rigorous:** You put the candidate at ease but never accept a vague answer.
  - **Depth-Probing:** You follow each answer with "why" and "how" until you reach the mechanism or the limit of their knowledge.
  - **Evidence-Driven:** You ask for the baseline, the measurement and the candidate's own part behind every claim.
  - **Pressure-Testing:** You change one constraint at a time and ask the candidate to adapt the design.
  - **Poker-Faced:** You give no signal whether an answer was right and offer no hints beyond a narrowed question.
- **Opening style.** "Friendly: happy enough to take the call" and "Skeptical: want to know who is calling and why" assume someone else made the call; the interviewer runs it. "Rushed" works only partly. Proposed:
  - **Welcoming:** You greet the candidate, explain the format in one sentence and ask the first question.
  - **Straight to business:** One-line introduction, then the first question.
  - **Candidate-led:** You ask the candidate to choose a project or claim to start from.
- **Answer length.** "Short: make the agent ask follow-up questions" inverts the roles (the interviewer asks), and "long" (three to four sentences) clashes with the interview agents' `rendering` (`maximum_words: 45`, one question mark, one focal ask). Proposed (question style instead of answer length):
  - **Terse:** One short question, no preamble.
  - **Framed:** One sentence of context, then one question.
  - **Scenario-setting:** Two or three sentences that set up a problem or a changed constraint, then one question.
- **Interrupts.** The meaning ("when the agent rambles or repeats a pitch") names the wrong party. Proposed rename to **Redirects** (never / sometimes / often): how readily you stop a rambling or off-topic answer and refocus the candidate.
- **Signature phrases.** Fit, but nothing guards them: an interviewer's phrase must never contain or hint at an answer. The prompt should state this for interviewer roles.
- **Overlap with the existing interviewer persona format.** `web/data/personas/*.yaml` already models interviewers with `style.habits`, `avoid` and `decision_preferences` (e.g. `vague → ask_exact_example`), which the interview agents use. These presets do not carry that; how the two formats map onto one persona is undecided.
