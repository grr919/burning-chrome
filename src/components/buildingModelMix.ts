// Optional pilot: keep most cells on the existing service-based architecture.
export const BUILDING_MODEL_MIX = [
  { id: 'row-house-01', name: 'Maple Row', count: 48, footprint: 0.86 },
  { id: 'brick-house-01', name: 'Brick House', count: 24, footprint: 1.04 },
  { id: 'apartment-complex-01', name: 'Courtyard Gardens', count: 12, footprint: 1.5 },
  { id: 'office-tower-01', name: 'Meridian Tower', count: 4, footprint: 0.94 },
  { id: 'futuristic-towers-01', name: 'Astra Spires', count: 1, footprint: 1.52 },
] as const;

export type BuildingModelId = typeof BUILDING_MODEL_MIX[number]['id'];

export function isBuildingModelTestEnabled(search: string): boolean {
  return new URLSearchParams(search).get('buildingModels') === 'mixed';
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x85ebca6b);
  result ^= result >>> 13;
  return result >>> 0;
}

// Ranking the entire level guarantees exact quotas and no duplicate landmarks.
// Metadata arrivals and hover updates never reshuffle the allocation.
export function allocateBuildingModels(levelKey: string): Map<number, BuildingModelId> {
  const cells = Array.from({ length: 256 }, (_, index) => ({ index, rank: hash(`${levelKey}:${index}`) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const assignments = new Map<number, BuildingModelId>();
  let cursor = 0;
  for (const model of BUILDING_MODEL_MIX) {
    for (let i = 0; i < model.count; i += 1) assignments.set(cells[cursor++].index, model.id);
  }
  return assignments;
}
