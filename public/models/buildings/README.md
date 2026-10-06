# Building asset library

Six optimized exterior models for Burning Chrome, enabled by default at the main
URL. Existing `/?buildingModels=mixed` links still work. Use
`/?buildingModels=procedural` for the original service-based scene comparison.
The model integration applies to both grids and their street views. No database
or navigation changes are included.

Models are now selected by observed exposure complexity, rather than fixed quotas.
The score is the greater of the full observed port count, distinct listed ports,
and recognized named service categories, plus a diversity bonus of up to three
points (distinct categories minus one). Port lists may be truncated; the full
count is retained. Categories inferred from port numbers are approximate.
The old `serviceCount` field can include aliases and product fingerprints and is
therefore not used in this score. Hostnames, CPEs, tags, ASN ownership and presumed
traffic do not increase complexity. Hostnames alone do not prove multiple websites.

| Score | Tier | Eligible models | Maximum per level |
|---|---|---|---|
| 0–2 | Low | Row house / brick house | 96 / 48 |
| 3–5 | Moderate | Apartment complex | 24 |
| 6–9 | Complex | Historic tower | 16 |
| 10–15 | High | Modern office tower | 8 |
| 16+ | Exceptional | Futuristic tower / modern office tower | 1 / 8 shared with high tier |

These are ceilings, not targets: some levels may have no towers or no library
models at all. Highest scores receive scarce compatible models first; the
futuristic landmark goes to the strongest qualifying address. Weighted stable
selection supplies variation within a tier (row houses have twice the brick
house weight). Identical data yields identical assignments, regardless of record
order. New observations may change a tier or displace a capped allocation.
Overflow keeps procedural architecture, never a model from a lower tier.
The combined ceiling is 193 of 256 cells (75.4%), up from 97 (37.9%).
At least 63 cells remain procedural, preserving the existing variants. These
percentages are maximum capacity, not a guaranteed share on every level; missing
data and tier distribution can reduce the actual count.

Missing, failed, warning-only or unusable observations are **unknown**, shown
with `?` and a hover explanation, and do not qualify for library models. A
successful explicit zero is low observed complexity, not proof of inactivity.
Both prose and structured hover views explain the tier and evidence. Higher grid
levels score the representative IP already used by the app, not an entire subnet.
Scores describe observed exposure, not live traffic, computing power or importance.

Model proportions and lot footprints stay intact: building type indicates a
complexity band, not a linear height measurement. Procedural fallbacks in the
mixed view use the same cleaned score for height, with a small block for unknown
data. The explicit procedural comparison retains its prior behavior. ASN-colored lots, flags,
address selection and metadata remain available; data-fetching services are unchanged.
Incomplete cached records (for example, hostnames with no port observation) no
longer suppress the existing exposure lookup. No database fields or APIs changed.

## Adding another model

Add its optimized GLB and catalog entry, then register its ID, display name,
eligible `tiers`, `maxPerLevel`, relative `weight`, and `footprint` in
`src/components/buildingModelMix.ts`. The loader and loading indicator discover
registry entries automatically; scoring does not depend on model names.
Keep the sum of ceilings below 256 to retain procedural variety and check the
new footprint and height in the grid. Run `node scripts/test-building-complexity.mjs`.

Models load by default and are cached by URL; the procedural comparison skips them. Instances share geometry,
materials and textures, but use separate transforms and draw calls. Failed or
pending loads retain the original structure. This is a mixed scene,
not a fully instanced 256-model renderer. Higher instance counts add draw calls,
but reuse the same six files and do not add database storage. Mobile performance needs device testing.

## Models

| Model | File | Bytes | Triangles | Drawable primitives |
|---|---|---:|---:|---:|
| Brick House | `brick-house-01.glb` | 112,292 | 2,274 | 3 |
| Maple Row | `row-house-01.glb` | 81,372 | 1,508 | 2 |
| Meridian Tower | `office-tower-01.glb` | 360,132 | 7,776 | 1 |
| Astra Spires | `futuristic-towers-01.glb` | 303,324 | 7,877 | 3 |
| Courtyard Gardens | `apartment-complex-01.glb` | 402,800 | 8,452 | 4 |
| Sterling Exchange | `heritage-tower-01.glb` | 94,012 | 2,280 | 4 |

The original five files total **1,259,920 bytes**, down from 12,720,240 bytes for the
original building-only files (90.1% smaller). Their combined geometry decreased
from 196,122 to 27,887 triangles, and drawable primitives from 416 to 13.
Including Sterling Exchange, the library totals **1,353,932 bytes**, 30,167
triangles and 17 drawable primitives. Sterling Exchange was built directly for
the game: 23 stories, terracotta window bays, limestone piers and cornices,
setbacks, a bronze entry canopy and a copper crown. At its 1.05-unit lot footprint,
it is approximately 2.58 units tall, below the modern and futuristic towers.
Draw counts above are per model in a simple single-pass preview, not a promise
of whole-grid performance. Repeating models still requires a future instanced
renderer and appropriate distance/detail decisions.

## Format and catalog

- Standard glTF 2.0 binary (`.glb`), with embedded PNG/JPEG textures and PBR materials.
- Uses KHR_mesh_quantization, supported by the existing Three.js loader. Preserve node transforms when integrating or instancing these meshes.
- No Draco, Meshopt, KTX2, or other external decoder setup is required.
- Units are meters; Y is up and the intended front direction is +Z.
- Asset files preserve their source proportions and origins. The mixed-view
  loader scales them uniformly to their assigned lot footprints.
- `catalog.json` contains stable IDs, URLs, bounds, dimensions, checksums,
  geometry counts, and ground offsets for later integration.
- Apply `groundOffsetMeters` only when placing the bottom of a model at Y=0.
  The futuristic building-only source omits its plaza and starts above Y=0.
- Paths are `/models/buildings/<filename>` on a deployed site.
- Embedded textures keep this pilot self-contained; there is no separate texture folder.
- Individual asset versions are 1.0.0; the expanded catalog is 1.1.0. For future revisions, update the catalog and use a versioned
  URL or filename with suitable cache headers; do not assume unchanged URLs are
  safe for permanent immutable caching.

## Optimization

The detailed original models remain separate from the app repository.
These derivatives remove standalone display grounds and landscaping by using
the building-only sources. They retain built-in podiums, entry steps, balconies,
and terrace features that are part of the buildings.

- Brick House: individual roof tiles replaced with a tiled material surface.
- Maple Row: geometry welding, reduced texture size, and material batching.
- Meridian Tower: thin facade framing reduced to outward-facing surfaces.
- Astra Spires: fewer curve segments; floor bands moved into a repeating texture.
- Courtyard Gardens: window frames/sills baked into reusable panels; balcony
  guards simplified to thin surfaces and very small rail details removed.
- All models: indexed geometry, conservative simplification, unused-data
  removal, material palettes, and compatible mesh merging.

Windows are opaque. There are no usable interiors, colliders, animations, or
additional LOD files. Material palette textures preserve surface colors and PBR
properties but do not yet expose independent per-building color controls.

## Validation

All six pass the Khronos glTF Validator with zero errors and zero warnings.
The original five were visually compared with their sources; Sterling Exchange
was inspected from multiple sides in Three.js r162, matching the app dependency.
The mixed scene uses at most 193 library models per 256-cell level; counts depend
on usable evidence and tier eligibility.

Geometry and source textures were created procedurally for this project;
no third-party model assets were used.

