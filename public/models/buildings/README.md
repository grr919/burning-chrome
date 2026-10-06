# Building asset library

Five optimized exterior models for Burning Chrome. These files are available for
future use; they are **not assigned to grid cells or loaded by the application**.
No grid design, building-selection rules, navigation, or database changes are
included in this asset upload.

## Models

| Model | File | Bytes | Triangles | Drawable primitives |
|---|---|---:|---:|---:|
| Brick House | `brick-house-01.glb` | 112,292 | 2,274 | 3 |
| Maple Row | `row-house-01.glb` | 81,372 | 1,508 | 2 |
| Meridian Tower | `office-tower-01.glb` | 360,132 | 7,776 | 1 |
| Astra Spires | `futuristic-towers-01.glb` | 303,324 | 7,877 | 3 |
| Courtyard Gardens | `apartment-complex-01.glb` | 402,800 | 8,452 | 4 |

The five files total **1,259,920 bytes**, down from 12,720,240 bytes for the
original building-only files (90.1% smaller). Their combined geometry decreased
from 196,122 to 27,887 triangles, and drawable primitives from 416 to 13.
Draw counts above are per model in a simple single-pass preview, not a promise
of whole-grid performance. Repeating models still requires a future instanced
renderer and appropriate distance/detail decisions.

## Format and catalog

- Standard glTF 2.0 binary (`.glb`), with embedded PNG/JPEG textures and PBR materials.
- Uses KHR_mesh_quantization, supported by the existing Three.js loader. Preserve node transforms when integrating or instancing these meshes.
- No Draco, Meshopt, KTX2, or other external decoder setup is required.
- Units are meters; Y is up and the intended front direction is +Z.
- Source proportions and origins are preserved; these assets have not been
  resized, stretched, or assigned to the grid.
- `catalog.json` contains stable IDs, URLs, bounds, dimensions, checksums,
  geometry counts, and ground offsets for later integration.
- Apply `groundOffsetMeters` only when placing the bottom of a model at Y=0.
  The futuristic building-only source omits its plaza and starts above Y=0.
- Paths are `/models/buildings/<filename>` on a deployed site.
- Embedded textures keep this pilot self-contained; there is no separate texture folder.
- Version is 1.0.0. For future revisions, update the catalog and use a versioned
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

All five pass the Khronos glTF Validator with zero errors and zero warnings.
They were loaded and visually compared with their originals in Three.js r162,
matching the app's existing Three.js dependency, with no extra decoder.
No 256-building grid benchmark has been performed: integration is deferred.

Geometry and source textures were created procedurally for this project;
no third-party model assets were used.

