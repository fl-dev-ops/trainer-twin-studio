# Issue: Spoken-First Prompting (TTS Style Gate) & Multimodal Show-and-Tell

## 1. Context & Problem Statement

Currently, the voice agent pipeline exhibits two major experiential flaws during live sessions:

1. **Screen-Formatted Text Sent to Speech (TTS):**
   - The LLM generates text designed for visual reading rather than human voice.
   - It outputs raw digits (`$50,000`, `3.5x`, `10-15`, `80%`), symbols (`#`, `*`, `/`, `&`, `_`), markdown formatting (`**bold**`, bullets, backticks), abbreviations (`e.g.`, `i.e.`, `vs.`), and code blocks.
   - When passed to Text-to-Speech engines (Sarvam, ElevenLabs, Cartesia), this produces robotic stuttering, mispronounced symbols ("asterisk asterisk", "slash", "e period g period"), and awkward cadence.
2. **Disconnected Static Stage (Missing "Show-and-Tell"):**
   - When a trainer asks about a candidate's résumé, architecture diagram, code implementation, or presentation slide, the stage remains static.
   - A real coaching or interview session is inherently **show-and-tell**: when an interviewer questions a specific system component, they point to the diagram, open the relevant file, or highlight the bullet point in question.

---

## 2. Industry Standards & Deep Research

### A. Spoken-First Prompt Engineering (LiveKit, Deepgram, ElevenLabs, Cartesia)
According to official voice AI guidelines (LiveKit Prompting Guide, ElevenLabs Voice Realism, Cartesia Sonic):
- **Spoken Text vs. Visual Text:** LLMs have no intrinsic awareness that they are in a voice pipeline. They default to ChatGPT-style visual formatting unless constrained.
- **Numbers & Units:**
  - Quantities and metrics should be written phonetically: *"three point five times"*, *"fifty thousand dollars"*, *"eighty percent"*.
  - Large or ambiguous years/numbers: *"twenty twenty-six"* instead of `"2026"`, *"ten to fifteen"* instead of `"10-15"`.
- **Symbols, Punctuation & Prosody:**
  - Absolute ban on Markdown formatting (`**`, `*`, `_`, `~`), emojis, tables, and bullet lists.
  - Commas and periods must be used deliberately as prosody markers—they dictate the TTS engine's breath pauses and natural rhythm.
- **Abbreviations & Latinisms:**
  - Prohibit `"e.g."`, `"i.e."`, `"etc."`, `"vs."`, `"w/"`. Replace with conversational English: *"for example"*, *"that is"*, *"versus"*, *"with"*.
- **Conciseness & Monologue Prevention:**
  - Spoken words take ~3× longer to consume than written text. Turns must be capped at 30–60 words (~15–25 seconds of speech) to maintain high conversational velocity and prevent listener fatigue.

### B. Multimodal "Show-and-Tell" Synchronization
Modern voice agents (e.g., LiveKit Multimodal Agents, OpenAI Realtime Vision, multimodal demos) coordinate visual state with conversational turns:
1. **Synchronous Tool Dispatch:**
   - The runtime emits workspace tool calls (`surface`, `workspace.code`, `workspace.canvas`, `workspace.pdf`, `workspace.presentation`) *alongside* or *prior to* the speech output.
2. **Deictic Anchoring:**
   - The agent's speech explicitly references the visual state: *"If you look at the architecture diagram on your canvas..."*, *"Looking at line 18 in your implementation..."*, *"On page two of your résumé under the infrastructure section..."*.
3. **Targeted Sub-Actions:**
   - Rather than just opening a tool, the agent dispatches coordinated focus commands:
     - **Code Editor:** `select_lines(from_line, to_line)` / `highlight_snippet`.
     - **Canvas / Whiteboard:** `zoom_to_element(id)` / `highlight_node`.
     - **PDF Viewer:** `scroll_to_section("experience")` / `highlight_text(quote)`.
     - **Presentation:** `goto_slide(number)`.

---

## 3. Architectural Specifications for TrainerTwin

### A. TTS Speech Normalization in System Prompts (`web/lib/runtime/openai.ts`)
Inject a dedicated **Spoken Output & Audio Formatting** constraint block into `generateSpeech` / `renderPersonaSpeech`:

```text
AUDIO & SPOKEN OUTPUT RULES (MANDATORY):
You are speaking aloud over a live voice connection. The text you generate is passed directly to a Text-to-Speech model:
1. Write out all numbers, currencies, and percentages as spoken words:
   - "$100k" -> "a hundred thousand dollars"
   - "3.5x" -> "three point five times"
   - "50%" -> "fifty percent"
   - "v2" -> "version two"
2. NEVER output Markdown formatting, asterisks (**bold**), bullet points, numbered lists, backticks, or emojis.
3. Spell out abbreviations: use "for example" instead of "e.g.", "versus" instead of "vs.", "and so on" instead of "etc.".
4. Use commas and periods to create natural human breath pauses and rhythm.
5. Keep spoken turns concise (under 60 words). One focal thought or question per turn.
```

### B. "Show-and-Tell" Stage Coordination
1. **Runtime Decision Engine:**
   - When `selectAction()` selects a probe targeting a specific artifact (e.g. Code Editor during coding phase, PDF résumé during project deep-dive, Canvas during system design):
   - The runtime automatically attaches the appropriate `tool_calls` payload in the OpenAI stream:
     ```json
     {
       "tool_calls": [
         {
           "name": "workspace_surface",
           "arguments": "{\"tool\":\"code\",\"action\":\"open\",\"highlightLines\":[14,22]}"
         }
       ]
     }
     ```
2. **LiveKit RPC Synchronization:**
   - The Python agent worker receives the tool call and dispatches the RPC method (`workspace.surface` or `workspace.code`) over the LiveKit data channel.
   - The browser's `LiveKitWorkspaceProvider` receives the event and:
     - Opens the surface in the left split stage.
     - Automatically highlights the target code lines, canvas elements, or document paragraph.

---

## 4. Verification Checklist (Definition of Done)

### Spoken Prompting & TTS Style Gate
- [ ] Speech prompt in `web/lib/runtime/openai.ts` includes explicit spoken formatting rules (numbers written as words, no markdown/symbols).
- [ ] Automated regex / compliance check verifies generated `spoken_text` contains no asterisks, raw dollar amounts (`$`), percentages (`%`), or bullet points.
- [ ] Sarvam / ElevenLabs audio playback sounds natural with proper cadence and zero symbol stuttering.

### Multimodal Show-and-Tell
- [ ] When an interview phase references a document, code snippet, or slide, the agent automatically opens the corresponding workspace surface.
- [ ] The agent's speech deictically anchors to the open surface (*"Looking at your canvas diagram..."*).
- [ ] Sub-actions (line selection in Code Editor, slide navigation in Presentation Viewer) dispatch in sync with the agent's turn.
- [ ] Candidate can view the highlighted artifact while hearing the trainer's spoken question.
