export type ComplexityTier = 'unknown' | 'low' | 'moderate' | 'complex' | 'high' | 'exceptional';
type KnownTier = Exclude<ComplexityTier, 'unknown'>;

// Add models with compatible tiers, a footprint, selection weight and ceiling.
// Ceilings never force a model onto an unsuitable address.
export const BUILDING_MODEL_MIX = [
  { id: 'row-house-01', name: 'Maple Row', tiers: ['low'], maxPerLevel: 96, weight: 2, footprint: 0.86 },
  { id: 'brick-house-01', name: 'Brick House', tiers: ['low'], maxPerLevel: 48, weight: 1, footprint: 1.04 },
  { id: 'apartment-complex-01', name: 'Courtyard Gardens', tiers: ['moderate'], maxPerLevel: 8, weight: 1, footprint: 1.5 },
  { id: 'mansion-01', name: 'Bellevue Manor', tiers: ['moderate'], maxPerLevel: 8, weight: 1, footprint: 1.55 },
  { id: 'warehouse-01', name: 'Northline Depot', tiers: ['moderate'], maxPerLevel: 8, weight: 1, footprint: 1.6 },
  { id: 'office-tower-01', name: 'Meridian Tower', tiers: ['high', 'exceptional'], maxPerLevel: 8, weight: 1, footprint: 0.94 },
  { id: 'futuristic-towers-01', name: 'Astra Spires', tiers: ['exceptional'], maxPerLevel: 1, weight: 1, footprint: 1.52 },
  { id: 'factory-01', name: 'Ironvale Works', tiers: ['complex'], maxPerLevel: 8, weight: 1, footprint: 1.65 },
  { id: 'heritage-tower-01', name: 'Sterling Exchange', tiers: ['complex'], maxPerLevel: 8, weight: 1, footprint: 1.05 },
] as const;

export type BuildingModelId = typeof BUILDING_MODEL_MIX[number]['id'];

export type ComplexityEvidence = {
  openPortCount?: number | null;
  topPorts?: readonly string[] | null;
  serviceNames?: readonly string[] | null;
  observationAvailable?: boolean;
  warning?: string | null;
  error?: string | null;
};
export type BuildingComplexity = {
  tier: ComplexityTier;
  score: number | null;
  observedCount: number;
  categoryCount: number;
  explanation: string;
};

const PORT_CATEGORIES: Readonly<Record<number, string>> = {
  80: 'web', 443: 'web', 8000: 'web', 8008: 'web', 8080: 'web', 8443: 'web',
  22: 'remote access', 23: 'remote access', 3389: 'remote access', 5900: 'remote access',
  25: 'mail', 110: 'mail', 143: 'mail', 465: 'mail', 587: 'mail', 993: 'mail', 995: 'mail',
  53: 'DNS',
  1433: 'database', 1521: 'database', 3306: 'database', 5432: 'database', 6379: 'database', 9200: 'database', 11211: 'database', 27017: 'database',
  20: 'file sharing', 21: 'file sharing', 69: 'file sharing', 139: 'file sharing', 445: 'file sharing', 873: 'file sharing', 990: 'file sharing', 2049: 'file sharing',
  123: 'infrastructure', 161: 'infrastructure', 389: 'infrastructure', 636: 'infrastructure', 2375: 'infrastructure', 2376: 'infrastructure', 6443: 'infrastructure',
};
const NAMED_CATEGORIES: Readonly<Record<string, string>> = {
  http: 'web', https: 'web', ssh: 'remote access', telnet: 'remote access', rdp: 'remote access', vnc: 'remote access',
  smtp: 'mail', smtps: 'mail', imap: 'mail', imaps: 'mail', pop3: 'mail', pop3s: 'mail', dns: 'DNS', domain: 'DNS',
  mysql: 'database', postgresql: 'database', postgres: 'database', redis: 'database', mongodb: 'database', mssql: 'database',
  ftp: 'file sharing', ftps: 'file sharing', smb: 'file sharing', nfs: 'file sharing', rsync: 'file sharing',
  snmp: 'infrastructure', ldap: 'infrastructure', ldaps: 'infrastructure', ntp: 'infrastructure',
};

export function assessBuildingComplexity(record?: ComplexityEvidence | null): BuildingComplexity {
  const unknown = (reason: string): BuildingComplexity => ({
    tier: 'unknown', score: null, observedCount: 0, categoryCount: 0,
    explanation: `Complexity unknown: ${reason} This is not evidence of inactivity.`,
  });
  if (!record) return unknown('exposure data has not arrived.');
  if (record.error) return unknown('the exposure lookup failed.');
  if (record.warning || record.observationAvailable === false) return unknown('no usable exposure observation is available.');
  const ports = new Set<number>();
  for (const value of record.topPorts ?? []) {
    if (typeof value !== 'string') continue;
    const match = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(value.trim());
    const port = match ? Number(match[1]) : 0;
    if (port > 0 && port <= 65535) ports.add(port);
  }
  const categories = new Set<string>();
  for (const port of ports) if (PORT_CATEGORIES[port]) categories.add(PORT_CATEGORIES[port]);
  const namedCategories = new Set<string>();
  for (const name of record.serviceNames ?? []) {
    // Tags, hostnames and CPE product fingerprints are not additional services.
    if (typeof name !== 'string') continue;
    const key = name.trim().toLowerCase();
    const category = Object.prototype.hasOwnProperty.call(NAMED_CATEGORIES, key) ? NAMED_CATEGORIES[key] : undefined;
    if (category) { categories.add(category); namedCategories.add(category); }
  }
  const count = record.openPortCount;
  const validCount = typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 65535;
  if (!validCount && ports.size === 0 && namedCategories.size === 0) return unknown('service counts are missing or invalid.');
  // The legacy serviceCount also counts aliases/products. Use the full port count
  // (topPorts may be truncated), without adding overlapping lists together.
  const observedCount = Math.max(validCount ? count : 0, ports.size, namedCategories.size);
  const score = observedCount + Math.min(3, Math.max(0, categories.size - 1));
  const tier: KnownTier = score >= 16 ? 'exceptional' : score >= 10 ? 'high' : score >= 6 ? 'complex' : score >= 3 ? 'moderate' : 'low';
  return {
    tier, score, observedCount, categoryCount: categories.size,
    explanation: observedCount === 0
      ? 'Low observed complexity: the available record reports no exposed services. This does not prove inactivity.'
      : `${tier[0].toUpperCase() + tier.slice(1)} observed complexity: ${observedCount} observed ports/services; ${categories.size} service categories; score ${score}. Categories inferred from port numbers are approximate.`,
  };
}

export function isBuildingModelTestEnabled(search: string): boolean {
  // Library buildings are the default; retain an explicit comparison fallback.
  return new URLSearchParams(search).get('buildingModels') !== 'procedural';
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

export type ComplexityCell = { index: number; ipAddress: string; complexity: BuildingComplexity };
const TIER_ORDER: Readonly<Record<KnownTier, number>> = { low: 1, moderate: 2, complex: 3, high: 4, exceptional: 5 };

export function allocateBuildingModels(levelKey: string, cells: readonly ComplexityCell[]): Map<number, BuildingModelId> {
  const assignments = new Map<number, BuildingModelId>();
  const used = new Map<BuildingModelId, number>();
  const ranked = cells.filter(cell => cell.complexity.tier !== 'unknown')
    .map(cell => ({ ...cell, tie: hash(`${levelKey}:${cell.ipAddress}`) }))
    .sort((a, b) => (b.complexity.score ?? 0) - (a.complexity.score ?? 0) || a.tie - b.tie || a.index - b.index);
  for (const cell of ranked) {
    let eligible = BUILDING_MODEL_MIX.filter(model =>
      model.tiers.some(tier => tier === cell.complexity.tier) && (used.get(model.id) ?? 0) < model.maxPerLevel);
    if (!eligible.length) continue; // Preserve procedural architecture; never downgrade to fill a quota.
    const specificity = (model: typeof BUILDING_MODEL_MIX[number]) => Math.min(...model.tiers.map(tier => TIER_ORDER[tier]));
    const highest = Math.max(...eligible.map(specificity));
    eligible = eligible.filter(model => specificity(model) === highest);
    let choice = (hash(`${levelKey}:${cell.ipAddress}:style`) / 4294967296) * eligible.reduce((sum, model) => sum + model.weight, 0);
    const selected = eligible.find(model => { choice -= model.weight; return choice < 0; }) ?? eligible[eligible.length - 1];
    assignments.set(cell.index, selected.id);
    used.set(selected.id, (used.get(selected.id) ?? 0) + 1);
  }
  return assignments;
}
