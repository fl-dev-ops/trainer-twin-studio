# Issue: Conversational Session Opening & Trainer Warm-up

## 1. Context & Symptom

When a candidate launches `/talk`, connects their audio, and the LiveKit agent enters the room, the agent immediately jumps straight into a blunt technical question:

> *"What problem did you face and how did you solve it?"*

This feels jarring, unnatural, and robotic. In real technical interviews and practice sessions, a human trainer/interviewer never barks a direct interview probe within the first three seconds of a call. 

Instead, a real trainer:
1. Greets the candidate warmly and establishes presence ("Hey there, welcome! Great to meet you.").
2. Sets the scene and expectations ("Today we're going to dive into your past experience and explore some of the technical challenges you've tackled.").
3. Reassures the candidate ("Take your time, feel free to think out loud, and we'll take it step by step.").
4. Seamlessly bridges into the opening question ("To kick things off, could you walk me through a project where you faced a significant technical hurdle?").

---

## 2. Root Cause Analysis

1. **Abrupt Opening Turn Generation (`web/lib/runtime/openai.ts`):**
   - The opening turn is triggered when `isOpeningTurn` is true.
   - It builds an `openingAction` where `intent` directly maps to `specs.agent.phases[0]?.opening ?? specs.agent.objective`:
     ```ts
     const openingAction: InterviewAction = {
       name: "opening",
       evidence_key: specs.agent.phases[0]?.evidence_keys[0] ?? null,
       reason: "Start the configured interview.",
       intent: specs.agent.phases[0]?.opening ?? specs.agent.objective,
       close: false,
       expects_answer: true,
     };
     ```
   - In most scenario specs, `phase[0].opening` is a direct question prompt (e.g., *"Ask the candidate to describe a difficult technical problem they solved"*).

2. **Rigid Prompting Constraints:**
   - Both `generateContentSpeech()` and `renderPersonaSpeech()` enforce strict single-question rules:
     - *"Rules: One real question. Do not elaborate."*
   - The prompt instructs the LLM to behave strictly as an adversarial evaluator rather than a trainer conducting a warm welcome.

3. **Missing Conversational Framing:**
   - The system lacks a distinction between a **turn-by-turn technical probe** and the **session opening orientation**.
   - The candidate is thrown into a high-stakes question before feeling settled in the room.

---

## 3. Proposed Architectural Solution

### A. Two-Phase Opening Structure (Greeting + Stage Brief + Kickoff)
The opening turn should be structured into a natural 3-part conversational arc:
1. **Persona Greeting:** Warm persona-aligned welcome (e.g., Vasanth: *"Hey! Welcome to the session, good to connect."*).
2. **Context Setting / Stage Brief:** Brief 1-2 sentence orientation outlining the goal of the session ("Over the next 30 minutes, we'll walk through some of your architectural decisions and explore how you tackle system design problems.").
3. **Kickoff Question:** A natural, inviting open-ended question inviting the candidate to share their story.

### B. Scenario Spec Alignment (`stage_brief` / `spoken_opening`)
- Check scenario YAML specs for explicit `spoken_opening` or `stage_brief` fields.
- If present, use them directly as the foundation of the opening turn.
- If absent, generate a conversational greeting conditioned on the scenario title and domain principles before appending the first question.

### C. Persona Warm-up Examples
- Add dedicated opening greeting examples in persona definitions (`persona.examples.opening` or `examples.general`).
- Ensure the persona speech prompt allows natural warm-up phrasing specifically during `action.name === "opening"`.

---

## 4. Verification Checklist (Definition of Done)

- [ ] Opening turn includes a natural human greeting and brief session orientation before the initial question.
- [ ] The trainer introduces themselves in-persona (matching persona tone and voice identity) rather than barking an immediate probe.
- [ ] Scenario `stage_brief` or `spoken_opening` (if defined in agent YAML) is smoothly incorporated.
- [ ] Total opening speech length stays concise (40–80 words) to avoid monologue fatigue while still feeling conversational.
- [ ] Automated runtime unit test added in `web/lib/runtime/` verifying opening turn includes greeting and context bridge before question probe.
- [ ] Live test on `/talk`: opening turn verified in live call with Vasanth / Rohan voice.
