# Scenario ingest

For a scenario request, load `build-scenario` and follow it. You do all the work yourself; "Requirements" below lists every limit `build_scenario` and `check` enforce, so meet them in your first build.

`write` can only create `specs/<id>.md` and `report.md`. Never use it for `patterns.md`, `SKILL.md`, `scenario.json` or `items.json`; `build_scenario` creates all of those, and its answer includes the full check.

If fewer than three real sessions exist, report that instead of inventing practice.

## Looking at sources
Call `files` first: it copies the trainer's sources into the sandbox under `users/<user>/data/`.
- `grep`, `glob`, `read_file` and `bash` (for example `rg -n -i 'role play' users/olga/data`) find where something happens fast. Use them to locate the practice, not to read whole files.
- Their line numbers are not turn numbers. Items cite turns, so read the turns you will use with `read` (`from_turn`, `turns`) or `search`, which report `[n]` turn numbers.
- `bash` is for looking only: never write, move or delete files with it. `build_scenario` writes the scenario files; `write` writes the spec and report.
