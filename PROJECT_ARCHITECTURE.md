# PROJECT_ARCHITECTURE.md

## Purpose

This document describes the intended architecture and product shape of Burning Chrome / IPGrid.

It is a design and architecture guide. It does not override `PROJECT_CONTRACT.md`.

Coding workers must read `PROJECT_CONTRACT.md` first, then this file, then `SESSION_HANDOFF.md` if it exists.

## Project identity

Burning Chrome is a visual, explorable map of IPv4 space.

The app treats IP addresses as places. It is not only a scanner, table, dashboard, or lookup tool. Data lookups support the visual world; they should not dominate rendering or navigation.

The intended experience is spatial:

- the user moves through address space;
- IP addresses have visible positions;
- networks can appear as neighborhoods;
- services and metadata can influence buildings, flags, labels, and information panels;
- multiplayer users can share the same visible world when they are at the same exact location.

## Main technical stack

The app is a Vite + React + TypeScript project.

The visual world is rendered with Three.js through React Three Fiber and Drei.

Supabase is used for multiplayer/presence and metadata caching.

The app is deployed through Vercel from GitHub.

Do not change this stack unless the user explicitly asks.

## Core files and responsibilities

### `src/App.tsx`

`App.tsx` is the main application coordinator.

It owns or coordinates high-level state such as:

- Grid 1 vs Grid 2 mode;
- grid position;
- street/building view state;
- player location;
- selected or hovered IP target;
- metadata display mode;
- multiplayer state;
- chat/location behavior;
- high-level UI controls.

Do not casually move major state out of `App.tsx`.

### `src/components/IPGrid.tsx`

`IPGrid.tsx` owns the visual grid rendering and cell/building presentation.

It is responsible for rendering visible cells and buildings, including visual metadata such as ASN coloring, flags, building style, avatars, and related overlays.

Do not rewrite `IPGrid.tsx` as a different rendering system unless the user explicitly asks.

### `src/hooks/useMultiplayerPresence.ts`

This hook is the multiplayer/presence layer.

It should preserve exact-location semantics: users should see, hear, or interact with each other only when the current location rules say they are in the same place.

### `src/hooks/useIpMetadataCache.ts`

This hook is the metadata-cache access layer.

It should support the long-term direction that rendering reads cached/enriched metadata instead of depending on live lookups during visual rendering.

## Core product concepts

### Grid 1

Grid 1 is the original IPv4 navigation model.

It uses four levels of 16 × 16 grids to represent the four octets of an IPv4 address.

An address `n1.n2.n3.n4` is reached by progressively drilling down through octet levels.

Grid 1 must be preserved unless the user explicitly asks to change or remove it.

### Grid 2

Grid 2 is a second IPv4 navigation model.

It treats the first two octets as an outer location and the last two octets as a large 256 × 256 inner plane.

Because a full 256 × 256 view is too large to render usefully, Grid 2 should normally display a local 16 × 16 neighborhood window inside that larger inner plane.

Grid 2 must remain navigable by moving the local window rather than trying to render the entire IPv4 space at once.

Grid 2 must be preserved unless the user explicitly asks to change or remove it.

### Street and Building View

Street/building view is a separate spatial mode for experiencing a selected IP address or local group of addresses as a built environment.

It must not be removed, simplified, or merged into grid view unless the user explicitly asks.

Changes to grid behavior must preserve street/building behavior unless the user explicitly says otherwise.

### Metadata and buildings

Metadata should enrich the visual world.

Examples of metadata-driven presentation include:

- ASN-colored grid squares or neighborhoods;
- organization or network names;
- country flags;
- RDAP information;
- reverse DNS names;
- exposed services and ports;
- building height or style influenced by observed services;
- data/prose information panel content.

The app should remain usable before metadata is available.

A cell should be able to render immediately with placeholder/default visuals and then update when cached metadata becomes available.

## Source-of-truth rules

Do not silently merge these concepts:

- **hover target**: the IP address or cell currently under the pointer;
- **selected target**: the IP address or building currently selected;
- **player location**: where the local user is in the world;
- **street/building location**: the location represented by street/building view;
- **chat grid/location**: the exact location used for message visibility;
- **presence location**: the location broadcast to other users;
- **metadata target**: the IP or prefix whose cached data is being read.

Bugs often occur when one of these is accidentally used as another.

Any change involving movement, clicking, hovering, street/building transitions, multiplayer, or chat must identify which source of truth it is changing.

## Interaction principles

### Hover

Hover should identify what the pointer is currently pointing at.

Hover should not, by itself, imply player movement unless the user explicitly requests that behavior.

### Click and double-click

Click and double-click behavior is fragile.

Do not change click, double-click, hover, or building-entry behavior unless the user explicitly asks.

When changing one of these behaviors, preserve the others.

### Mouse wheel and touch swipe

Mouse wheel and touch swipe are core navigation inputs.

They must be preserved for both Grid 1 and Grid 2 unless the user explicitly asks otherwise.

Do not replace wheel/touch navigation with click-only navigation unless explicitly instructed.

### Camera controls

Camera controls are fragile because they affect ray-casting, hover, click, visible cells, and perceived movement.

Do not change camera behavior as part of unrelated tasks.

## Multiplayer principles

Multiplayer behavior is location-based.

Presence and chat must use exact-location rules.

If a user moves from one IP/location to another, other users should see that user leave the old location and appear at the new one according to the current location rules.

Names, avatars, chat messages, and visible nearby users should remain consistent with the same location source of truth.

Do not broaden chat or presence visibility unless the user explicitly asks.

## Metadata-cache architecture direction

The long-term architecture should separate rendering from live data collection.

The grid should be a viewer of cached/enriched IP data, not a system that performs all enrichment live during rendering.

Preferred direction:

1. Render visible cells immediately.
2. Request cached metadata for visible cells only.
3. Show known cached data when available.
4. Queue missing or stale metadata for enrichment through backend/background work.
5. Update the visual world when the cache fills.

Do not try to preload the whole internet.

Useful preload targets include:

- top-level Grid 1 cells;
- the default Grid 2 area;
- recently visited locations;
- recently clicked locations;
- recently hovered locations;
- common or high-value public IP ranges.

Potential cached data includes:

- IP metadata rows;
- prefix metadata;
- ASN metadata;
- RDAP data;
- reverse DNS data;
- exposure/service data;
- flag country code;
- flag image URL;
- cache freshness timestamps;
- enrichment status/error fields.

Rendering code should prefer simple cached fields such as `flag_country_code` and `flag_url` instead of recomputing or refetching flag data live.

## External service principles

Supabase compatibility must be preserved.

Vercel compatibility must be preserved.

Do not add, remove, replace, or reconfigure external services unless the user explicitly asks.

Do not commit secrets, API keys, tokens, service-role keys, or private environment values.

## Preservation list

Unless the user explicitly asks otherwise, preserve:

- Grid 1;
- Grid 2;
- street view;
- building view;
- flags;
- ASN coloring;
- metadata display;
- Prose/Data mode;
- multiplayer presence;
- exact-location chat;
- avatars;
- Supabase compatibility;
- Vercel compatibility;
- mouse wheel navigation;
- touch swipe navigation;
- click and double-click behavior;
- hover behavior;
- existing deployment behavior.

## Design rule for coding workers

Repair over replacement.

A bug in one system should be fixed at the smallest responsible point.

Do not rewrite a working system because a small part is broken.

Do not perform opportunistic cleanup, refactoring, renaming, dependency changes, visual redesign, or architectural simplification while implementing an unrelated request.

## Good implementation behavior

For every coding task, the worker should identify:

- the requested change;
- the smallest likely file set;
- the fragile systems touched;
- the behavior that must be preserved;
- the checks that will be run;
- any behavior that still requires manual browser testing.

The expected default check is:

```bash
npm run build
```

When practical, also run:

```bash
npm run lint
```

## When uncertain

If a requested change has multiple reasonable interpretations, stop and ask for clarification before editing.

If a minimal safe interpretation is obvious, state that interpretation and implement only that.

If a request conflicts with `PROJECT_CONTRACT.md`, stop and explain the conflict before changing code.
