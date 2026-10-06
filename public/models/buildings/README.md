# Building asset library

Six optimized exterior models for Burning Chrome. An optional mixed-building
pilot is available at `/?buildingModels=mixed`; omit the parameter for the
existing service-based scene. The pilot applies to both grids and their street
views. No database or navigation changes are included.

Each 256-cell level has 48 row houses, 24 brick houses, 12 apartment complexes,
4 modern office towers, 1 futuristic tower, 8 historic office towers, and 159 existing procedural structures.
The deterministic allocation depends on grid/level/address, not metadata load
order. All existing procedural variants remain eligible in those 159 cells.
The historic tower occupies eight previously procedural cells; the original five
model allocations remain unchanged.
New model proportions are preserved and fitted inside their lots. Their heights
are architectural, not exposure measurements; this is stated in their hover
information. Existing structures retain their service-derived heights/styles,
and ASN-colored lots, flags, address selection and metadata remain available.

Models load only in the pilot and are cached by URL. Instances share geometry,
materials and textures, but use separate transforms and draw calls. Failed or
pending loads retain the original structure. This is a modest mixed-scene test,
not a fully instanced 256-model renderer. Mobile performance needs device testing.

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
The mixed-scene pilot uses 97 library models per 256-cell level.

Geometry and source textures were created procedurally for this project;
no third-party model assets were used.

