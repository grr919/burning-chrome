# PROJECT_CONTRACT.md

## Purpose

This contract defines how a coding worker must behave when changing this project.

The worker is an implementer, not a designer.

The worker is not authorized to decide, redesign, simplify, replace, or improve. The worker is authorized only to implement the user's specific instruction while preserving all existing behavior not named in that instruction.

## Authority

The user is the source of all product, design, architecture, and feature decisions.

This contract defines standing constraints that the worker must obey unless the user explicitly overrides them.

If the user request conflicts with this contract, the worker must stop and explain the conflict before changing code.

## Required first step

Before editing code, the worker must identify:

- the requested change;
- the files or systems likely affected;
- the features that must be preserved;
- any ambiguity or missing information;
- whether the request conflicts with this contract.

The worker must not begin editing until it has completed this first review.

## No independent decisions

The worker must not make independent product, design, architecture, or feature decisions.

The worker must not improve, simplify, modernize, redesign, reorganize, or reinterpret the project unless explicitly instructed.

The worker must not implement based on guesses about what the user probably wants.

If the instruction is ambiguous, incomplete, or has multiple reasonable interpretations, the worker must stop and ask for clarification before changing code.

If a minimal safe interpretation exists, the worker may proceed only if it states that interpretation first and does not exceed it.

## Insufficient information

If the worker does not have enough information to make a safe change, it must stop and say what information is missing.

The worker must not fill missing requirements with assumptions.

Examples of missing information include:

- unclear desired visual result;
- unclear interaction behavior;
- unclear source of truth for location;
- unclear whether a change applies to Grid 1, Grid 2, or both;
- unclear whether a change applies to street view, building view, or grid view;
- unclear whether multiplayer behavior should change.

## Scope limitation

No change is allowed unless it is necessary to complete the user's requested task.

The worker must not expand the task beyond the user's exact request.

If the worker notices adjacent bugs, improvements, or risks, it may report them, but must not fix them without permission.

Forbidden unless explicitly requested:

- redesigns;
- refactors;
- feature removals;
- dependency changes;
- service changes;
- file reorganizations;
- naming changes;
- visual changes;
- behavior changes outside the requested scope.

## No feature removal

The worker must not remove, disable, hide, replace, or degrade any existing feature unless the user explicitly names that feature and asks for its removal or change.

Fixing one feature must not remove another feature.

This rule applies even to features that seem unused, awkward, duplicated, incomplete, or buggy.

## Preservation rule

Existing behavior must be preserved unless the user explicitly asks to change it.

When in doubt, preserve rather than improve.

Unless explicitly instructed otherwise, the worker must preserve:

- Grid 1;
- Grid 2;
- street view;
- building view;
- flags;
- ASN coloring;
- metadata display;
- Prose/Data mode;
- multiplayer presence;
- location-based chat;
- avatars;
- Supabase compatibility;
- Vercel compatibility.

## No unrelated architecture changes

The worker must not change project architecture unless explicitly instructed.

Forbidden architectural changes include:

- moving major state between files;
- replacing existing data flows;
- changing the rendering model;
- changing the multiplayer model;
- changing the database/service model;
- introducing new global state systems;
- reorganizing files or folders;
- replacing existing libraries or services.

## No opportunistic cleanup

The worker must not perform opportunistic cleanup.

Forbidden unless explicitly requested:

- formatting unrelated files;
- renaming variables for style;
- deleting comments;
- rewriting components;
- changing unrelated CSS/classes;
- consolidating duplicated code;
- replacing working code with a preferred pattern.

## Minimal file touching

The worker must touch the fewest files necessary.

If more than three files must be changed, the worker must explain why before proceeding.

## Dependencies

The worker must not add, remove, or upgrade dependencies unless explicitly instructed.

The worker must not introduce new packages to solve a problem that can be solved within the existing project.

## External services

The worker must not add, remove, replace, or reconfigure external services unless explicitly instructed.

This includes:

- database providers;
- realtime providers;
- hosting assumptions;
- APIs;
- authentication services;
- paid services.

## Environment variables and secrets

The worker must not create, rename, remove, or require new environment variables unless explicitly instructed.

The worker must never commit:

- secrets;
- API keys;
- tokens;
- Supabase service-role keys;
- private environment values.

Configuration must use environment variables where appropriate.

## No silent behavior changes

The worker must not change existing behavior outside the requested scope.

A change is forbidden if it alters unrelated:

- click behavior;
- hover behavior;
- wheel behavior;
- touch behavior;
- camera behavior;
- layout;
- colors;
- labels;
- data fetching;
- multiplayer presence;
- chat behavior;
- deployment behavior.

## Visual changes

The worker must not redesign the interface.

Visual changes are allowed only when the user specifically requests a visual change, and only within the named area.

## Repair over replacement

The worker must prefer repair over replacement.

The worker must not replace a working system with a new implementation unless the user explicitly asks for a replacement.

## Fragile systems

If a task touches a fragile system, the worker must say so before editing and must explain how it will avoid changing unrelated behavior.

Fragile systems include:

- IP address calculation;
- grid coordinate mapping;
- mouse hover;
- click and double-click;
- mouse wheel;
- touch swipe;
- ray-casting;
- camera controls;
- street/building transitions;
- player location;
- chat location;
- Supabase presence;
- metadata lookup/cache behavior.

## Database and schema changes

The worker must not change database schemas, table names, column names, storage assumptions, or migration files unless explicitly instructed.

## Verification

The worker must run this before finishing when possible:

```bash
npm run build
```

The worker should run this too when practical:

```bash
npm run lint
```

If a check cannot be run, the worker must say so and explain why.

The worker must also describe any manual behavior checks that are necessary but could not be performed.

## Completion report

At completion, the worker must report:

- files changed;
- the exact requested change implemented;
- existing features intentionally preserved;
- checks run;
- checks not run;
- uncertainty or risk;
- any adjacent issue noticed but not fixed.
