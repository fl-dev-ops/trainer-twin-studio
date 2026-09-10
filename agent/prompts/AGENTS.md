# Prompt Editing Instructions

- Before changing any file under this directory, read `CHANGELOG.md` completely.
- Treat the checklist in `CHANGELOG.md` as required review criteria, not optional background.
- Confirm the active agent profile, frontend metadata, prompt placeholders, registered tools, and tool-owned speech before editing a prompt.
- Preserve existing candidate-facing behavior unless the user explicitly approves a change.
- Keep one authoritative instruction for each behavior. Remove or rewrite conflicting older instructions instead of adding another exception elsewhere.
- Keep main questions, adaptive opening questions, and response-grounded probes conceptually separate.
- Never duplicate speech already emitted by a backend tool through `session.say()`.
- After an approved prompt behavior change, update the checklist when a reusable invariant changes and append a concise dated bullet under `CHANGELOG.md` change history.
- For prompt-only edits, verify rendering and run `git diff --check`. When backend Python changes, also run Ruff, Python compilation, and a focused manual exercise of the affected path.
- Prompts and backend modules are cached or loaded by the worker. Always state that restart or redeployment is required before source changes affect a running interview.
- Do not add tests unless the user explicitly asks for tests.

