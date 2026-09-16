# Requirements Specification: Autonomous Trainer Twin Brain (`chat/`)

> **Superseded:** The consolidated and current requirements now live in
> [`trainer-twin-conversation-requirements.md`](./trainer-twin-conversation-requirements.md).
> This file remains as historical context for the first Eve-brain design.

---

## 1. System Vision & Purpose

Build a **single, standalone, agentic "Brain"** running in Vercel Eve (`chat/`) that acts as a digital twin for any trainer. 

The Brain is decoupled from the web UI and transport layer. It exposes a standard **OpenAI-compatible HTTP/SSE API (`POST /v1/chat/completions`)**, allowing it to power:
1. **LiveKit Voice Sessions:** Python agent acts purely as an audio/transport pipe (STT/TTS + room RPC tool execution).
2. **Text Chatbot Sessions:** Web or mobile chat UIs connect directly via standard OpenAI client libraries.

---

## 2. What We NEED (Must-Haves)

### A. Core Architecture & API
* **Vercel Eve Framework (`chat/`):** Houses instructions, dynamic resolvers, tools, and durable session state.
* **OpenAI-Compatible Channel (`agent/channels/openai-compat.ts`):**
  * Route: `POST /v1/chat/completions` supporting streaming SSE (`chat.completion.chunk`).
  * Streams incremental text deltas (`delta.content`) for real-time speech/TTS synthesis.
  * Streams tool execution requests (`delta.tool_calls`) for client execution.
  * Returns final chunk with `finish_reason` and token usage metrics.
* **Durable Session Mapping:**
  * Maps an inbound session address (via `x-trainertwin-session-id` or bearer token) to an Eve durable session so conversation history, pending questions, and state persist across turns.

### B. Persona Fidelity (Dynamic, Not Hardcoded)
* **Trainer-Agnostic:** Adapts to *any* trainer by reading indexed specs and vector databases. Zero hardcoded trainer names or catchphrases.
* **Move-First Execution:**
  1. Determine conversational move (`probe`, `challenge`, `hint`, `acknowledge_advance`, `clarify`, `redirect`, `close`).
  2. Perform targeted style retrieval (`search_style`) using a topic-neutral description of the move and situation.
  3. Generate speech directly in the trainer's voice using the retrieved examples + metadata (phase, function, sentence shape).
* **Identity Lock:** Candidate's name is learned **strictly from their own spoken words** (e.g. *"I am Karthik"*). Stored examples must redact past learner names to `<name>` placeholders.
* **Anti-Repetition & Variety:**
  * Rotate style examples to prevent dominant-example bias.
  * Ban repeating the same opener or acknowledgement (e.g. *"Good, good"*) across consecutive turns.

### C. Voice & Audio Delivery Constraints
* **Spoken-First Text:** All generation passed to TTS must be phonetically natural:
  * Numbers, currencies, and percentages written out as words (*"fifty thousand dollars"*, *"eighty percent"*, *"three point five times"*).
  * Absolute ban on Markdown: no asterisks (`**bold**`), bullets, numbered lists, backticks, or emoji.
  * Abbreviations expanded (*"for example"*, not *"e.g."*; *"versus"*, not *"vs."*).
  * Commas and periods used intentionally as natural prosody/breath pauses.
* **Conciseness:** Spoken turns strictly under **50 words** with **exactly one focal question** per turn.

### D. Scenario & Document Grounding
* **Dynamic Spec Loading:** At `session.started`, fetch scenario specs (objective, progression phases, opening brief) and persona preferences (decision patterns) from the studio API.
* **Document Awareness:** Brain must receive the list of attached session documents (e.g. candidate résumé PDF, case study) so it knows what artifacts are available to show.

### E. Show-and-Tell Workspace Coordination
* **"Open, Don't Ask" Principle:** When an artifact is relevant (e.g. candidate résumé in a résumé interview), the agent automatically emits the tool call to open it while speaking—never asks for permission to open a platform surface.
* **Deictic Anchoring:** Speech references what is visible (*"Looking at your code on the screen..."*, *"On page one of your resume..."*).
* **No Visual Hallucination:** The agent must recognize it has **no camera or screen vision**. It only knows what tools or client messages report. If a whiteboard is empty, it must truthfully say it sees no diagrams yet.

### F. Dual-Mode Tool Scoping (Voice vs. Chat)
* **Internal Tools (Always active):** `search_style`, `search_knowledge` execute server-side in Eve for both voice and chat.
* **Workspace Tools (Conditionally active):** `surface`, `highlight_code`, `read_canvas_scene`, `finish_session` are offered only when the client advertises workspace capability or during LiveKit sessions.

---

## 3. What We DO NOT NEED (Anti-Requirements & YAGNI)

* ❌ **Eve Joining the LiveKit Room:** Eve does NOT connect to LiveKit as a participant. It communicates strictly over HTTP/SSE.
* ❌ **Real-Time Rubric Grading in the Speech Path:** Do not force the agent to compute structured grading JSON, coverage percentages, or evidence quotes during voice turns. That adds 3–4s of latency.
* ❌ **Knowledge RAG on Every Turn:** Attached domain documents should only be searched on explicit need, not on every conversational turn.
* ❌ **Hardcoded Voice Cards:** Do not embed fixed catchphrase lists into prompt files.
* ❌ **Web Runtime In-Path Proxying:** LiveKit must hit the Eve endpoint directly without unnecessary Next.js routing hops.
* ❌ **Unbounded Multi-Tool Loops:** An agent must not execute chains of 3+ tools before speaking on a voice turn.

---

## 4. Optional / Deferred Items (Phase 2)

* ⏳ **Background Rubric Evaluator:** An asynchronous evaluator (Variant 2 pattern) that observes transcripts in the background and populates the scorecard without blocking voice turns.
* ⏳ **Bidirectional `workspace.changed` Client Event:** An event from the browser notifying Eve when the user manually clicks "X" to close a workspace.
* ⏳ **Chat SDK Adapters:** Multi-platform bot integrations (Slack, Discord, Teams) using `@chat-adapter/*`.

---

## 5. Required Working Behaviors & Edge Cases

| Scenario / Trigger | Expected Agent Behavior |
| :--- | :--- |
| **Session Start (`session-start`)** | Identifies candidate (if provided) or greets warmly, states scenario focus per opening brief, opens initial document (e.g. résumé) if required, asks first focal question. Under 50 words. |
| **Candidate Answers Normally** | Decides move (`probe` or `challenge`), fetches 5 style examples via `search_style`, acknowledges with varied phrasing, asks 1 targeted follow-up question. |
| **Candidate Asks for Help / Gets Stuck** | Identifies intent as `hint`. Gives a genuine conceptual nudge (does not just re-read the previous question). |
| **Candidate Requests Screen Action** | *"Can you open the whiteboard / code editor?"* → Immediately emits `surface(action)` tool call + speaks one confirming line. Does NOT ask *"Is it external or virtual?"* |
| **Candidate Asks to Repeat** | Replays the pending question immediately without re-running retrieval or advancing the topic. |
| **Candidate Signals Conclusion** | *"I think we are done for today"* → Emits `finish_session` tool call and speaks a warm, brief closing line. |
| **Learner Interrupts (Barge-in)** | Client sends a new message while a turn is generating → Eve's `turnPolicy: "steer"` cancels the ongoing turn and begins processing the new utterance. |
| **Unknown Candidate Name** | Speaks naturally without any name. Never substitutes fake placeholder names (*"there"*, *"Harini"* from résumé). Uses candidate's name only after they say it. |

---

## 6. Performance & Latency Budgets

| Metric | Target | Hard Ceiling |
| :--- | :--- | :--- |
| **Voice Turn Latency (Wall Clock)** | **4.5s – 5.5s** | **6.0s** |
| **Tool Hops per Voice Turn** | **1 hop** (`search_style`) | **2 hops** (`surface` + `search_style`) |
| **Spoken Output Length** | **30 – 45 words** | **55 words** |
| **Candidate Name Accuracy** | **100%** (from speech only) | Zero résumé name leaks |
