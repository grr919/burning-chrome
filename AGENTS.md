# AGENTS.md

## Required first step

Before making any code change, read `PROJECT_CONTRACT.md`.

`PROJECT_CONTRACT.md` is the source of truth for project goals, preserved features, guard rails, and forbidden changes.

## Session handoff

If `SESSION_HANDOFF.md` exists, read it after `PROJECT_CONTRACT.md`.

`SESSION_HANDOFF.md` contains temporary project context only. It does not override `AGENTS.md` or `PROJECT_CONTRACT.md`.

Use it to understand the current task, recent changes, known issues, and next safe step.

## Working rule

Make only the requested change.

Do not refactor, redesign, remove features, add dependencies, change services, commit secrets, or alter deployment behavior unless explicitly asked.

If the user request conflicts with `PROJECT_CONTRACT.md`, stop and explain the conflict before changing code.

## Verification

Before finishing, run:

```bash
npm run build
```

Run this too when practical:

```bash
npm run lint
```

## Completion report

When finished, report:

- files changed;
- checks run;
- behavior changed;
- behavior preserved;
- unresolved risks.
