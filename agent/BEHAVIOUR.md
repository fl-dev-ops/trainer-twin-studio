# Mock Interview Experience

This document describes the candidate-facing interview experience produced by
the current `mock_interview` profile, prompt, and backend implementation. It
intentionally excludes Vasanth's personality, tone, phrasing, and general
communication rules; those remain authoritative in
`prompts/interview/v1/mock_interview.md`.

This is a source-level reference. Prompt, profile, and backend changes require a
worker restart or redeployment before they become live.

## End-to-end flow

```text
candidate joins
  -> adaptive opening
  -> supplied or retrieved question plan
  -> planned questions in order
       -> question-specific UI surface
       -> candidate answer or submission
       -> required walkthrough/follow-up
  -> evaluation hand-off
  -> spoken feedback and candidate questions
  -> candidate ends the call
```

The active default profile uses `prompts/interview/v1/mock_interview.md`,
enables editor events and the proactive screen-feedback timer, and disables
on-demand shared screen inspection. Configuration combinations are documented
in `CONFIG.md`.

## Adaptive opening

The session starts with the candidate's name and the opening question from the
adaptive plan. The opening can use supplied professional context, resume facts,
and previous answers to explore relevant experience before planned technical
questions begin.

Adaptive follow-ups are limited by the plan's conditions and maximum count.
Material resume contradictions may be reconciled separately. Once the adaptive
transition condition is met, the interview moves to the main-question plan.

## Question plan

When room metadata supplies valid questions, that plan is loaded before the
session and remains authoritative.

When no plan is supplied, the interviewer requests one from the configured
question source after the adaptive opening. Retrieval is attempted twice before
the session is treated as inconclusive. If the question source is unavailable
and no plan was supplied, the planned interview cannot proceed normally.

Every planned question must be started through `start_question`. This publishes
the question and its answer surface to the frontend, activates evidence
collection, and notifies the screen-feedback runtime.

Questions normally start in plan order. A visual question cannot be replaced by
the next question while its answer is still pending unless the candidate
explicitly abandons it.

## Shared question progression

Except for Whiteboard, each planned question has at most one
response-grounded follow-up. A probe, recovery question, reasoning request, or
highlighted-code question consumes the same allowance. Required walkthroughs,
procedural instructions, and time nudges do not consume it.

The next question begins only after the current question is answered, submitted,
or explicitly abandoned. Skipping planned questions is reserved for insufficient
remaining time.

## Verbal questions

- No editor or answer surface is opened.
- The candidate answers aloud.
- At most one response-grounded follow-up is asked.
- Shared-screen inspection is not used.
- Prompt-directed check-ins may occur after prolonged silence.
- The interview moves on when the question timebox expires.

The silence check-ins and timebox are directed by the interviewer prompt, not by
a dedicated per-question backend timer.

## Code output questions

- A read-only code surface is opened.
- The candidate predicts the output and explains the reasoning before running it.
- When help is needed, the interviewer reads the editor content silently,
  highlights the smallest relevant block, and asks one targeted reasoning
  question.
- After the prediction, the candidate runs the code and reports the observed
  output.
- The first highlighted recovery consumes the one-follow-up allowance.
- After one unsuccessful highlighted recovery, the interviewer may reveal and
  briefly explain the correct output.
- The candidate is never asked to edit or submit read-only code.

## Coding questions

- A writable editor is opened.
- The candidate can write, run, save, and submit code.
- The interviewer normally remains quiet while the candidate works, except for
  candidate-requested help, time nudges, or proactive screen feedback.
- Candidate-requested help reads the editor before responding.
- Meaningful code is highlighted before a targeted question about that block.
- If no meaningful code exists, the interviewer asks a targeted next-step
  question without highlighting a line.
- Submission is followed by a candidate walkthrough.
- An unused follow-up may probe reasoning, complexity, an edge case, or a
  specific implementation decision.

If the candidate cannot finish, they must explicitly abandon the answer before
the next visual question can start.

## Machine coding questions

Machine coding uses the same writable editor, submission, abandonment,
candidate-requested help, proactive feedback, walkthrough, and follow-up limits
as Coding. Its walkthrough focuses on structure, boundaries, state/data flow,
trade-offs, and improvements the candidate would make with more time.

## Multiple-choice questions

- A choice surface is opened.
- The candidate selects and submits one option.
- The submitted option is the recorded answer.
- Spoken reasoning may be requested when it adds useful evidence.
- Correctness is not revealed during the interview.

Submitted option correctness is validated against the stored question during
evaluation rather than being left entirely to evaluator judgment.

## Whiteboard questions

- A whiteboard surface is opened.
- The candidate draws, submits the diagram, and gives a spoken walkthrough.
- An accepted whiteboard submission is required before final evaluation hand-off
  when Whiteboard is the last question.
- The interviewer reads the accepted visual assessment, highlights one exact
  visible component label, and asks a targeted follow-up.
- It repeats the assessment/highlight flow for a deeper or adjacent second
  follow-up.
- A further follow-up is reserved for a material unresolved design risk when
  time remains.

Whiteboard is exempt from the shared one-follow-up limit. The two follow-ups are
prompt-directed; backend readiness checks enforce accepted submission, not the
number of follow-up turns completed.

## Candidate-requested code help

Coding help uses the frontend-owned `workspace.code` RPC:

```text
candidate requests help
  -> read_code_range(get_range)
  -> meaningful relevant block exists?
       |-- yes -> highlight_code(highlight_range) -> targeted question
       `-- no  -> targeted next-step question without highlighting
```

The backend rejects invalid RPC responses instead of inventing editor content.
If the frontend RPC is unavailable or fails, code-grounded help and highlighting
cannot complete reliably.

## Proactive screen feedback

The screen-feedback observer is separate from candidate-requested help. It uses
the latest shared-screen frame and frontend surface-state revisions; it does not
call `read_code_range` or `inspect_shared_screen`.

```text
every ten seconds
  -> require active matching surface and current screen frame
  -> require interviewer listening and candidate not speaking
  -> changed revision: strategic-deviation analysis
  -> unchanged for sixty seconds: stall analysis
```

### Fundamentally non-viable approach

A newly observed revision schedules strategic analysis. The observer intervenes
only when the visible approach has no credible path to a correct solution without
changing strategy or shows a clear conceptual misconception.

Incomplete code, ordinary syntax mistakes, missing edge cases, inefficiency, and
viable alternative strategies do not qualify. An intervention briefly names the
strategic concern without revealing the solution, asking a question, or
highlighting code.

### Stall feedback

After sixty seconds without visible progress:

- Below fifty-percent estimated completion, the observer may give a general
  restart nudge without highlighting code.
- At fifty percent or greater, it speaks only when it can ask a meaningful
  question about a specific visible code block.
- The selected block must be highlighted successfully before that question is
  spoken.
- Whiteboard stalls may receive a short question, hint, or technique without
  component highlighting.

Observer speech requires confidence of at least `0.8`, a non-empty response, an
elapsed thirty-second cooldown, an unchanged snapshot during analysis, and an
idle conversation. The model can decline to speak, so a nudge is not guaranteed.

Multiple edits between timer ticks collapse to the latest visible revision.
Analysis reasons from the screen frame rather than exact editor content. If the
screen, surface state, or frame is unavailable, no proactive feedback occurs.

When `screen_feedback_timer=false`, none of the proactive deviation, stall,
completion, or automatic highlighting behavior runs. Candidate-requested code
help remains available when editor events are enabled.

## On-demand screen inspection

The active profile has `screen_inspection=false`, so `inspect_shared_screen` and
resume screen inspection are not exposed. Coding help continues through editor
RPC tools. Whiteboard assessment and highlighting continue through the accepted
whiteboard evidence path, but prompt-directed on-demand shared-screen inspection
is unavailable.

## Timing experience

Prompt-directed question timeboxes are:

- Verbal and Code output: initial check-in after thirty seconds, another nudge
  after twenty seconds, and approximately three minutes total.
- Coding and Machine coding: a three-minute reassurance, another check two
  minutes later, and approximately five minutes including walkthrough.
- Whiteboard: approximately five minutes before the candidate is asked to stop
  drawing and walk through the current state.

These are conversational instructions rather than deterministic question timers.
The proactive screen observer's ten-second polling and sixty-second stall gate
are separate backend timers.

## Answers and evidence

The interview records:

- spoken conversation associated with the active question;
- submitted code, language, revision, and submission state;
- submitted MCQ option and validated option text;
- accepted whiteboard image metadata and compact visual assessment.

Invalid participants, mismatched active questions, stale revisions, malformed
payloads, and oversized code are rejected. Screen-observer completion estimates
and visual judgments are not used as formal evaluation evidence.

## Evaluation and closure

After the final required answer, submission, walkthrough, and prompt-level
follow-ups are complete, the interviewer calls `finish_interview` and tells the
candidate that feedback is being prepared.

```text
finish_interview
  -> verify final-question readiness
  -> wait briefly for pending code evidence
  -> build question-by-question evidence
  -> hand the session to the evaluator
  -> evaluator speaks feedback
  -> candidate may ask up to four questions
  -> candidate ends the call
```

A normal premature hand-off is rejected and the interview continues. An expired
or abandoned incomplete session can be finalized as inconclusive.

Evaluation can produce feedback-only, accept, reject, or mixed closure based on
evidence coverage, confidence, question outcomes, missed fundamentals, and
written-code correctness. Submitted MCQ correctness is enforced after model
evaluation.

The mock-interview agent does not disconnect or delete the room. The evaluator
asks the candidate to end the call when they have no further questions.

## Candidate-visible failure and recovery

- A failed question publication prevents that question from being restarted.
- A pending visual answer blocks the next question until submission or explicit
  abandonment.
- Missing question retrieval prevents an unsupplied plan from being built.
- Failed editor or whiteboard RPCs must not be replaced with fabricated
  observations.
- Screen-feedback analysis failure skips that evaluation while the timer keeps
  running.
- Evaluation failure falls back to feedback-only language instead of an
  unsupported verdict.

Live behavior still depends on the deployed worker revision, frontend RPC and
surface-state support, screen sharing, provider health, and prompt-cache refresh.
