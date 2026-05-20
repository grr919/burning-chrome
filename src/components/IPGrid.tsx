import { useEffect, useMemo, useRef, useState } from 'react';
import { Html, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

type GridPosition = {
  firstOctet: number;
  secondOctet: number;
  thirdOctet: number;
  fourthOctet: number;
};

type LookupMode = 'rdap' | 'ptr';
type GridSystemMode = 'grid1' | 'grid2';

type Grid2Position = {
  outerFirstOctet: number;
  outerSecondOctet: number;
  innerThirdStart: number;
  innerFourthStart: number;
};

type LookupAddress = {
  ipAddress: string;
  label: number;
  displayLabel: string;
  firstOctetValue: number;
  secondOctetValue: number;
  thirdOctetValue: number;
  fourthOctetValue: number;
};

const DEFAULT_GRID2_POSITION: Grid2Position = {
  outerFirstOctet: 0,
  outerSecondOctet: 0,
  innerThirdStart: 0,
  innerFourthStart: 0,
};

function clampOctet(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

type IPGridProps = {
  zoomLevel: number;
  currentPosition: GridPosition;
  getIPColor: (first: number, second: number, third: number, fourth: number) => string;
  handleGridClick: (x: number, y: number) => void;
  onFlagClick: (building: { ipAddress: string; label: number; color: string; buildingFamily: 'block' | 'tower' | 'stepped' | 'fort'; buildingHeight: number; flagImageUrl?: string | null; countryCodeLabel?: string; asn?: string; asnName?: string; route?: string; asnColor?: string }) => void;
  lookupMode: LookupMode;
  gridSystemMode?: GridSystemMode;
  grid2Position?: Grid2Position;
  onHoverInfoHtml?: (html: string) => void;
};

type RdapEntity = {
  roles: string[];
  name?: string;
  email?: string;
};

type RdapRecord = {
  ipAddress: string;
  networkName?: string;
  handle?: string;
  org?: string;
  country?: string;
  cidr?: string;
  startAddress?: string;
  endAddress?: string;
  entities: RdapEntity[];
  source?: string;
  rdapBaseUrl?: string;
  error?: string;
};

type ReverseDnsRecord = {
  ipAddress: string;
  hostnames: string[];
  ptrHostnames: string[];
  fallbackHostnames: string[];
  error?: string;
};

type ExposureRecord = {
  ipAddress: string;
  sourceProvider: 'internetdb';
  serviceCount: number;
  openPortCount: number;
  topPorts: string[];
  serviceNames: string[];
  labels: string[];
  hostnames: string[];
  lastUpdatedAt?: string;
  warning?: string;
  error?: string;
};

type AsnRecord = {
  ipAddress: string;
  asn?: string;
  asnName?: string;
  route?: string;
  country?: string;
  registry?: string;
  source?: string;
  error?: string;
};

const rdapCache: Record<string, RdapRecord> = {};
const pendingRdapLookups = new Set<string>();
const reverseDnsCache: Record<string, ReverseDnsRecord> = {};
const pendingReverseLookups = new Set<string>();
const exposureCache: Record<string, ExposureRecord> = {};
const pendingExposureLookups = new Set<string>();
const asnCache: Record<string, AsnRecord> = {};
const pendingAsnLookups = new Set<string>();

function getLookupAddress(
  zoomLevel: number,
  currentPosition: GridPosition,
  x: number,
  y: number,
  gridSystemMode: GridSystemMode = 'grid1',
  grid2Position: Grid2Position = DEFAULT_GRID2_POSITION
): LookupAddress {
  const value = y * 16 + x;

  if (gridSystemMode === 'grid2') {
    const firstOctetValue = clampOctet(grid2Position.outerFirstOctet);
    const secondOctetValue = clampOctet(grid2Position.outerSecondOctet);
    const thirdOctetValue = clampOctet(grid2Position.innerThirdStart + y);
    const fourthOctetValue = clampOctet(grid2Position.innerFourthStart + x);

    return {
      ipAddress: `${firstOctetValue}.${secondOctetValue}.${thirdOctetValue}.${fourthOctetValue}`,
      label: thirdOctetValue * 256 + fourthOctetValue,
      displayLabel: `${thirdOctetValue}.${fourthOctetValue}`,
      firstOctetValue,
      secondOctetValue,
      thirdOctetValue,
      fourthOctetValue,
    };
  }

  if (zoomLevel === 0) {
    return {
      ipAddress: `${value}.0.0.0`,
      label: value,
      displayLabel: `${value}`,
      firstOctetValue: value,
      secondOctetValue: 0,
      thirdOctetValue: 0,
      fourthOctetValue: 0,
    };
  }

  if (zoomLevel === 1) {
    return {
      ipAddress: `${currentPosition.firstOctet}.${value}.0.0`,
      label: value,
      displayLabel: `${value}`,
      firstOctetValue: currentPosition.firstOctet,
      secondOctetValue: value,
      thirdOctetValue: 0,
      fourthOctetValue: 0,
    };
  }

  if (zoomLevel === 2) {
    return {
      ipAddress: `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${value}.0`,
      label: value,
      displayLabel: `${value}`,
      firstOctetValue: currentPosition.firstOctet,
      secondOctetValue: currentPosition.secondOctet,
      thirdOctetValue: value,
      fourthOctetValue: 0,
    };
  }

  return {
    ipAddress: `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.${value}`,
    label: value,
    displayLabel: `${value}`,
    firstOctetValue: currentPosition.firstOctet,
    secondOctetValue: currentPosition.secondOctet,
    thirdOctetValue: currentPosition.thirdOctet,
    fourthOctetValue: value,
  };
}

function getVisibleLookupAddresses(
  zoomLevel: number,
  currentPosition: GridPosition,
  gridSize: number,
  gridSystemMode: GridSystemMode = 'grid1',
  grid2Position: Grid2Position = DEFAULT_GRID2_POSITION
): LookupAddress[] {
  const items: LookupAddress[] = [];
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      items.push(getLookupAddress(zoomLevel, currentPosition, x, y, gridSystemMode, grid2Position));
    }
  }
  return items;
}

function firstUsefulEntities(entities: RdapEntity[]): RdapEntity[] {
  return entities.filter((entity) => entity.name || entity.email).slice(0, 3);
}

function shadeColor(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const numeric = Number.parseInt(clean, 16);

  let red = (numeric >> 16) + amount;
  let green = ((numeric >> 8) & 0xff) + amount;
  let blue = (numeric & 0xff) + amount;

  red = Math.max(0, Math.min(255, red));
  green = Math.max(0, Math.min(255, green));
  blue = Math.max(0, Math.min(255, blue));

  return `#${((1 << 24) + (red << 16) + (green << 8) + blue).toString(16).slice(1)}`;
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function getHeightFromServiceCount(cubeSize: number, serviceCount: number): number {
  const normalized = Math.log10(serviceCount + 1);
  return cubeSize * (0.72 + normalized * 1.95);
}

function normalizeAsn(value?: string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim().toUpperCase();
  if (!text) {
    return null;
  }
  if (/^AS\d+$/.test(text)) {
    return text;
  }
  if (/^\d+$/.test(text)) {
    return `AS${text}`;
  }
  return text;
}

function getAsnColor(asn?: string | null): string {
  const normalized = normalizeAsn(asn);
  if (!normalized) {
    return '#8f8f8f';
  }

  const palette = [
    '#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2',
    '#4f46e5', '#be123c', '#65a30d', '#0f766e', '#b45309', '#7c3aed',
    '#0ea5e9', '#84cc16', '#f43f5e', '#14b8a6', '#6366f1', '#d946ef',
  ];

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }

  return palette[Math.abs(hash) % palette.length];
}

function getAsnSummaryLabel(record?: AsnRecord | null): string {
  if (!record?.asn) {
    return 'ASN not loaded';
  }
  return `${normalizeAsn(record.asn)}${record.asnName ? ` — ${record.asnName}` : ''}${record.route ? ` (${record.route})` : ''}`;
}

function escapeHtml(value?: string | number | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAsnDiagnosticLabel(record: AsnRecord | undefined, loading: boolean): string {
  if (loading) return 'loading';
  if (record?.asn) return 'ok';
  if (record?.error) return `error: ${record.error}`;
  return 'not requested or no response yet';
}

function getCountryCode(countryCode?: string): string | null {
  if (!countryCode) {
    return null;
  }

  const normalized = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function getFlagImageUrl(countryCode?: string): string | null {
  const normalized = getCountryCode(countryCode);
  if (!normalized) {
    return null;
  }

  return `https://flagcdn.com/w40/${normalized}.png`;
}

function getCountryName(countryCode?: string): string | null {
  const normalized = getCountryCode(countryCode);
  if (!normalized) {
    return null;
  }

  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return displayNames.of(normalized.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

function parseTopPortNumber(portLabel: string): number | null {
  const match = portLabel.match(/^(\d+)/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getIpTypeLabel(first: number, second: number): string {
  if (first === 127) return 'Loopback';
  if (first === 10) return 'Private';
  if (first === 172 && second >= 16 && second <= 31) return 'Private';
  if (first === 192 && second === 168) return 'Private';
  if (first === 0) return 'Reserved';
  if (first === 169 && second === 254) return 'Reserved';
  if (first >= 224 && first <= 239) return 'Multicast';
  if (first >= 240 && first <= 255) return 'Reserved';
  return 'Public';
}

type StreetTrafficLayerProps = {
  gridSize: number;
  spacing: number;
  offset: number;
  groundY: number;
};

function StreetTrafficLayer({ gridSize, spacing, offset, groundY }: StreetTrafficLayerProps) {
  const totalFlows = 40;
  const refs = useRef<Array<THREE.Mesh | null>>([]);

  const flows = useMemo(
    () =>
      Array.from({ length: totalFlows }, (_, index) => {
        const seed = index + 1;
        const horizontal = index % 2 === 0;
        const laneIndex = Math.floor(pseudoRandom(seed * 7) * (gridSize + 1));
        const laneCenter = laneIndex * spacing - offset - spacing / 2;
        const travelPositive = pseudoRandom(seed * 13) > 0.5;
        const speed = (0.65 + pseudoRandom(seed * 17) * 0.85) * 0.5;
        const phase = pseudoRandom(seed * 19);
        const width = 0.16 + pseudoRandom(seed * 23) * 0.16;
        const length = 0.32 + pseudoRandom(seed * 29) * 0.32;
        const y = groundY + 0.028 + pseudoRandom(seed * 31) * 0.012;
        const colorOptions = ['#60A5FA', '#34D399', '#F59E0B', '#A78BFA', '#F87171'];
        const color = colorOptions[index % colorOptions.length];

        return {
          horizontal,
          laneCenter,
          travelPositive,
          speed,
          phase,
          width,
          length,
          y,
          color,
        };
      }),
    [gridSize, spacing, offset, groundY]
  );

  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    const fullTravel = gridSize * spacing + spacing;

    flows.forEach((flow, index) => {
      const mesh = refs.current[index];
      if (!mesh) {
        return;
      }

      const progress = ((elapsed * flow.speed + flow.phase) % 1) - 0.5;
      const along = progress * fullTravel * (flow.travelPositive ? 1 : -1);

      if (flow.horizontal) {
        mesh.position.set(along, flow.y, flow.laneCenter);
      } else {
        mesh.position.set(flow.laneCenter, flow.y, along);
      }
    });
  });

  return (
    <>
      {flows.map((flow, index) => (
        <mesh
          key={`traffic-flow-${index}`}
          ref={(node) => {
            refs.current[index] = node;
          }}
          rotation={[-Math.PI / 2, 0, flow.horizontal ? 0 : Math.PI / 2]}
        >
          <planeGeometry args={[flow.length, flow.width]} />
          <meshStandardMaterial
            color={flow.color}
            emissive={flow.color}
            emissiveIntensity={1.35}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </>
  );
}


function StreetSceneryLayer({ gridSize, spacing, offset, groundY }: StreetTrafficLayerProps) {
  const sceneryItems = useMemo(() => {
    const items: JSX.Element[] = [];

    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        const seed = (x + 1) * 1000 + (y + 1) * 17;
        const xPos = x * spacing - offset;
        const zPos = y * spacing - offset;

        const frontLeftX = xPos - 0.34;
        const frontRightX = xPos + 0.34;
        const frontZ = zPos + 0.66;

        if (pseudoRandom(seed) > 0.35) {
          items.push(
            <group key={`tree-left-${x}-${y}`} position={[frontLeftX, groundY + 0.07, frontZ]}>
              <mesh position={[0, 0.13, 0]} castShadow>
                <cylinderGeometry args={[0.025, 0.03, 0.26, 8]} />
                <meshStandardMaterial color="#6b4f3a" />
              </mesh>
              <mesh position={[0, 0.34, 0]} castShadow>
                <sphereGeometry args={[0.12, 10, 10]} />
                <meshStandardMaterial color="#3f7f4f" />
              </mesh>
            </group>
          );
        } else {
          items.push(
            <mesh key={`bush-left-${x}-${y}`} position={[frontLeftX, groundY + 0.1, frontZ]} castShadow>
              <sphereGeometry args={[0.09, 10, 10]} />
              <meshStandardMaterial color="#4e8b57" />
            </mesh>
          );
        }

        if (pseudoRandom(seed + 1) > 0.5) {
          items.push(
            <mesh key={`bush-right-${x}-${y}`} position={[frontRightX, groundY + 0.1, frontZ]} castShadow>
              <sphereGeometry args={[0.08, 10, 10]} />
              <meshStandardMaterial color="#5a9a62" />
            </mesh>
          );
        }

        if (pseudoRandom(seed + 2) > 0.72) {
          const personX = xPos + (pseudoRandom(seed + 3) - 0.5) * 0.5;
          const personZ = zPos + 0.79;
          items.push(
            <group key={`person-${x}-${y}`} position={[personX, groundY + 0.07, personZ]}>
              <mesh position={[0, 0.14, 0]} castShadow>
                <cylinderGeometry args={[0.025, 0.03, 0.18, 8]} />
                <meshStandardMaterial color="#9ca3af" />
              </mesh>
              <mesh position={[0, 0.28, 0]} castShadow>
                <sphereGeometry args={[0.04, 10, 10]} />
                <meshStandardMaterial color="#d6b18b" />
              </mesh>
            </group>
          );
        }
      }
    }

    for (let row = 0; row <= gridSize; row += 1) {
      const zRoad = row * spacing - offset - spacing / 2;
      for (let i = 0; i < 6; i += 1) {
        const seed = row * 100 + i;
        const xCar = -offset + pseudoRandom(seed + 5) * (gridSize * spacing);
        items.push(
          <group key={`car-h-${row}-${i}`} position={[xCar, groundY + 0.055, zRoad]}>
            <mesh castShadow>
              <boxGeometry args={[0.28, 0.09, 0.14]} />
              <meshStandardMaterial color={['#60a5fa', '#f87171', '#fbbf24', '#34d399'][i % 4]} />
            </mesh>
            <mesh position={[0, 0.06, 0]} castShadow>
              <boxGeometry args={[0.16, 0.06, 0.12]} />
              <meshStandardMaterial color="#d1d5db" />
            </mesh>
          </group>
        );
      }
    }

    for (let col = 0; col <= gridSize; col += 1) {
      const xRoad = col * spacing - offset - spacing / 2;
      for (let i = 0; i < 6; i += 1) {
        const seed = col * 100 + i + 500;
        const zCar = -offset + pseudoRandom(seed + 7) * (gridSize * spacing);
        items.push(
          <group key={`car-v-${col}-${i}`} position={[xRoad, groundY + 0.055, zCar]} rotation={[0, Math.PI / 2, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.28, 0.09, 0.14]} />
              <meshStandardMaterial color={['#a78bfa', '#f97316', '#22d3ee', '#f472b6'][i % 4]} />
            </mesh>
            <mesh position={[0, 0.06, 0]} castShadow>
              <boxGeometry args={[0.16, 0.06, 0.12]} />
              <meshStandardMaterial color="#d1d5db" />
            </mesh>
          </group>
        );
      }
    }

    return items;
  }, [gridSize, spacing, offset, groundY]);

  return <>{sceneryItems}</>;
}

function IPGrid({
  zoomLevel,
  currentPosition,
  getIPColor,
  handleGridClick,
  onFlagClick,
  lookupMode,
  gridSystemMode = 'grid1',
  grid2Position = DEFAULT_GRID2_POSITION,
  onHoverInfoHtml,
}: IPGridProps) {
  const gridSize = 16;
  const spacing = 1.9;
  const cubeSize = 0.92;
  const roadWidth = spacing - cubeSize;
  const sidewalkInset = 0.08;
  const groundY = -cubeSize / 2;
  const offset = (gridSize * spacing) / 2 - spacing / 2;
  const gridExtent = gridSize * spacing;

  const [hoveredCube, setHoveredCube] = useState<string | null>(null);
  const [hoveredIpAddress, setHoveredIpAddress] = useState<string | null>(null);
  const [rdapInfo, setRdapInfo] = useState<Record<string, RdapRecord>>({});
  const [reverseDnsInfo, setReverseDnsInfo] = useState<Record<string, ReverseDnsRecord>>({});
  const [exposureInfo, setExposureInfo] = useState<Record<string, ExposureRecord>>({});
  const [asnInfo, setAsnInfo] = useState<Record<string, AsnRecord>>({});
  const [isRdapLoading, setIsRdapLoading] = useState<Record<string, boolean>>({});
  const [isReverseLoading, setIsReverseLoading] = useState<Record<string, boolean>>({});
  const [isExposureLoading, setIsExposureLoading] = useState<Record<string, boolean>>({});
  const [isAsnLoading, setIsAsnLoading] = useState<Record<string, boolean>>({});

  const visibleLookupAddresses = useMemo(
    () => getVisibleLookupAddresses(zoomLevel, currentPosition, gridSize, gridSystemMode, grid2Position),
    [
      zoomLevel,
      gridSystemMode,
      currentPosition.firstOctet,
      currentPosition.secondOctet,
      currentPosition.thirdOctet,
      grid2Position.outerFirstOctet,
      grid2Position.outerSecondOctet,
      grid2Position.innerThirdStart,
      grid2Position.innerFourthStart,
    ]
  );

  const performRdapLookup = async (ipAddress: string) => {
    if (rdapCache[ipAddress] || pendingRdapLookups.has(ipAddress)) {
      return;
    }

    pendingRdapLookups.add(ipAddress);
    setIsRdapLoading((prev) => ({ ...prev, [ipAddress]: true }));

    try {
      const response = await fetch(`/api/rdap?ip=${encodeURIComponent(ipAddress)}`);
      const json = (await response.json()) as RdapRecord & { details?: string };

      if (!response.ok) {
        const failedRecord: RdapRecord = {
          ipAddress,
          entities: [],
          error: json.error ?? json.details ?? `Lookup failed with status ${response.status}`,
        };
        rdapCache[ipAddress] = failedRecord;
        setRdapInfo((prev) => ({ ...prev, [ipAddress]: failedRecord }));
        return;
      }

      rdapCache[ipAddress] = json;
      setRdapInfo((prev) => ({ ...prev, [ipAddress]: json }));
    } catch (error) {
      const failedRecord: RdapRecord = {
        ipAddress,
        entities: [],
        error: error instanceof Error ? error.message : 'Unknown lookup error',
      };
      rdapCache[ipAddress] = failedRecord;
      setRdapInfo((prev) => ({ ...prev, [ipAddress]: failedRecord }));
    } finally {
      pendingRdapLookups.delete(ipAddress);
      setIsRdapLoading((prev) => ({ ...prev, [ipAddress]: false }));
    }
  };

  const performReverseDnsLookup = async (ipAddress: string) => {
    if (reverseDnsCache[ipAddress] || pendingReverseLookups.has(ipAddress)) {
      return;
    }

    pendingReverseLookups.add(ipAddress);
    setIsReverseLoading((prev) => ({ ...prev, [ipAddress]: true }));

    try {
      const response = await fetch(`/api/reverse-dns?ip=${encodeURIComponent(ipAddress)}`);
      const json = (await response.json()) as ReverseDnsRecord & { details?: string };

      if (!response.ok) {
        const failedRecord: ReverseDnsRecord = {
          ipAddress,
          hostnames: [],
          ptrHostnames: [],
          fallbackHostnames: [],
          error: json.error ?? json.details ?? `Lookup failed with status ${response.status}`,
        };
        reverseDnsCache[ipAddress] = failedRecord;
        setReverseDnsInfo((prev) => ({ ...prev, [ipAddress]: failedRecord }));
        return;
      }

      reverseDnsCache[ipAddress] = json;
      setReverseDnsInfo((prev) => ({ ...prev, [ipAddress]: json }));
    } catch (error) {
      const failedRecord: ReverseDnsRecord = {
        ipAddress,
        hostnames: [],
        ptrHostnames: [],
        fallbackHostnames: [],
        error: error instanceof Error ? error.message : 'Unknown hostname lookup error',
      };
      reverseDnsCache[ipAddress] = failedRecord;
      setReverseDnsInfo((prev) => ({ ...prev, [ipAddress]: failedRecord }));
    } finally {
      pendingReverseLookups.delete(ipAddress);
      setIsReverseLoading((prev) => ({ ...prev, [ipAddress]: false }));
    }
  };

  const performAsnLookup = async (ipAddresses: string[]) => {
    const missing = ipAddresses.filter((ipAddress) => !asnCache[ipAddress] && !pendingAsnLookups.has(ipAddress));
    if (missing.length === 0) {
      return;
    }

    for (const ipAddress of missing) {
      pendingAsnLookups.add(ipAddress);
    }

    setIsAsnLoading((prev) => {
      const next = { ...prev };
      for (const ipAddress of missing) {
        next[ipAddress] = true;
      }
      return next;
    });

    try {
      const response = await fetch('/api/asn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ ipAddresses: missing }),
      });

      let json: { records?: AsnRecord[]; error?: string; details?: string } = {};
      const responseText = await response.text();
      if (responseText.trim()) {
        try {
          json = JSON.parse(responseText) as { records?: AsnRecord[]; error?: string; details?: string };
        } catch {
          json = {
            error: `ASN endpoint returned non-JSON text. Status ${response.status}. First characters: ${responseText.slice(0, 80)}`,
          };
        }
      }

      if (!response.ok) {
        const message = json.error ?? json.details ?? `ASN lookup failed with status ${response.status}`;
        const failedRecords: Record<string, AsnRecord> = {};
        for (const ipAddress of missing) {
          failedRecords[ipAddress] = { ipAddress, error: message };
          asnCache[ipAddress] = failedRecords[ipAddress];
        }
        setAsnInfo((prev) => ({ ...prev, ...failedRecords }));
        return;
      }

      const nextRecords: Record<string, AsnRecord> = {};
      for (const record of Array.isArray(json.records) ? json.records : []) {
        const normalizedRecord: AsnRecord = {
          ...record,
          asn: normalizeAsn(record.asn) ?? undefined,
        };
        nextRecords[normalizedRecord.ipAddress] = normalizedRecord;
        asnCache[normalizedRecord.ipAddress] = normalizedRecord;
      }

      for (const ipAddress of missing) {
        if (!nextRecords[ipAddress]) {
          const fallback: AsnRecord = { ipAddress, error: 'No ASN record returned for this IP.' };
          nextRecords[ipAddress] = fallback;
          asnCache[ipAddress] = fallback;
        }
      }

      setAsnInfo((prev) => ({ ...prev, ...nextRecords }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown ASN lookup error';
      const failedRecords: Record<string, AsnRecord> = {};
      for (const ipAddress of missing) {
        failedRecords[ipAddress] = { ipAddress, error: message };
        asnCache[ipAddress] = failedRecords[ipAddress];
      }
      setAsnInfo((prev) => ({ ...prev, ...failedRecords }));
    } finally {
      for (const ipAddress of missing) {
        pendingAsnLookups.delete(ipAddress);
      }
      setIsAsnLoading((prev) => {
        const next = { ...prev };
        for (const ipAddress of missing) {
          next[ipAddress] = false;
        }
        return next;
      });
    }
  };

  const performExposureLookup = async (ipAddresses: string[]) => {
    const missing = ipAddresses.filter((ipAddress) => !exposureCache[ipAddress] && !pendingExposureLookups.has(ipAddress));
    if (missing.length === 0) {
      return;
    }

    for (const ipAddress of missing) {
      pendingExposureLookups.add(ipAddress);
    }

    setIsExposureLoading((prev) => {
      const next = { ...prev };
      for (const ipAddress of missing) {
        next[ipAddress] = true;
      }
      return next;
    });

    try {
      const response = await fetch('/api/exposure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ ipAddresses: missing }),
      });

      const json = (await response.json()) as { records?: ExposureRecord[]; error?: string; details?: string };

      if (!response.ok) {
        const message = json.error ?? json.details ?? `Exposure lookup failed with status ${response.status}`;
        const failedRecords: Record<string, ExposureRecord> = {};
        for (const ipAddress of missing) {
          failedRecords[ipAddress] = {
            ipAddress,
            sourceProvider: 'internetdb',
            serviceCount: 0,
            openPortCount: 0,
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
            error: message,
          };
          exposureCache[ipAddress] = failedRecords[ipAddress];
        }
        setExposureInfo((prev) => ({ ...prev, ...failedRecords }));
        return;
      }

      const receivedRecords = Array.isArray(json.records) ? json.records : [];
      const nextRecords: Record<string, ExposureRecord> = {};
      for (const record of receivedRecords) {
        nextRecords[record.ipAddress] = record;
        exposureCache[record.ipAddress] = record;
      }

      for (const ipAddress of missing) {
        if (!nextRecords[ipAddress]) {
          const fallback: ExposureRecord = {
            ipAddress,
            sourceProvider: 'internetdb',
            serviceCount: 0,
            openPortCount: 0,
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
          };
          nextRecords[ipAddress] = fallback;
          exposureCache[ipAddress] = fallback;
        }
      }

      setExposureInfo((prev) => ({ ...prev, ...nextRecords }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown exposure lookup error';
      const failedRecords: Record<string, ExposureRecord> = {};
      for (const ipAddress of missing) {
        failedRecords[ipAddress] = {
          ipAddress,
          sourceProvider: 'internetdb',
          serviceCount: 0,
          openPortCount: 0,
          topPorts: [],
          serviceNames: [],
          labels: [],
          hostnames: [],
          error: message,
        };
        exposureCache[ipAddress] = failedRecords[ipAddress];
      }
      setExposureInfo((prev) => ({ ...prev, ...failedRecords }));
    } finally {
      for (const ipAddress of missing) {
        pendingExposureLookups.delete(ipAddress);
      }
      setIsExposureLoading((prev) => {
        const next = { ...prev };
        for (const ipAddress of missing) {
          next[ipAddress] = false;
        }
        return next;
      });
    }
  };

  useEffect(() => {
    const visibleIps = visibleLookupAddresses.map((item) => item.ipAddress);
    void performExposureLookup(visibleIps);
    void performAsnLookup(visibleIps);
  }, [visibleLookupAddresses]);

  useEffect(() => {
    let cancelled = false;
    const uncached = visibleLookupAddresses
      .map((item) => item.ipAddress)
      .filter((ipAddress) => !rdapCache[ipAddress] && !pendingRdapLookups.has(ipAddress));

    if (uncached.length === 0) {
      return;
    }

    let timer = 0;
    let index = 0;
    const batchSize = 12;

    const runBatch = () => {
      if (cancelled) {
        return;
      }

      const batch = uncached.slice(index, index + batchSize);
      for (const ipAddress of batch) {
        void performRdapLookup(ipAddress);
      }

      index += batchSize;
      if (index < uncached.length) {
        timer = window.setTimeout(runBatch, 140);
      }
    };

    timer = window.setTimeout(runBatch, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visibleLookupAddresses]);

  useEffect(() => {
    if (!hoveredIpAddress) {
      return;
    }

    if (lookupMode === 'rdap') {
      if (!rdapCache[hoveredIpAddress] && !pendingRdapLookups.has(hoveredIpAddress)) {
        void performRdapLookup(hoveredIpAddress);
      }
    }

    if (!reverseDnsCache[hoveredIpAddress] && !pendingReverseLookups.has(hoveredIpAddress)) {
      void performReverseDnsLookup(hoveredIpAddress);
    }
  }, [hoveredIpAddress, lookupMode]);


  useEffect(() => {
    if (!hoveredIpAddress || !onHoverInfoHtml) {
      return;
    }

    const activePanel = document.querySelector('div[data-info-panel="true"]') as HTMLDivElement | null;
    if (activePanel?.innerHTML) {
      onHoverInfoHtml(activePanel.innerHTML);
    }
  }, [hoveredIpAddress, rdapInfo, reverseDnsInfo, asnInfo, isRdapLoading, isReverseLoading, isAsnLoading, lookupMode, onHoverInfoHtml]);

  const createStreetGrid = () => {
    const items = [];
    const laneMarkings = [];
    const blockOutlineColor = '#8f8f8f';

    items.push(
      <mesh
        key="city-base"
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY - 0.05, 0]}
        receiveShadow
      >
        <planeGeometry args={[gridExtent + 6, gridExtent + 6]} />
        <meshStandardMaterial color="#eaf6ff" />
      </mesh>
    );

    for (let i = 0; i <= gridSize; i += 1) {
      const roadCenter = i * spacing - offset - spacing / 2;

      items.push(
        <mesh
          key={`road-h-${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, groundY - 0.012, roadCenter]}
          receiveShadow
        >
          <planeGeometry args={[gridExtent + spacing, roadWidth]} />
          <meshStandardMaterial color="#3a3a3a" />
        </mesh>
      );

      items.push(
        <mesh
          key={`road-v-${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[roadCenter, groundY - 0.012, 0]}
          receiveShadow
        >
          <planeGeometry args={[roadWidth, gridExtent + spacing]} />
          <meshStandardMaterial color="#3a3a3a" />
        </mesh>
      );
    }

    for (let row = 0; row <= gridSize; row += 1) {
      const roadCenter = row * spacing - offset - spacing / 2;
      for (let column = 0; column < gridSize; column += 1) {
        const segmentCenter = column * spacing - offset;
        laneMarkings.push(
          <mesh
            key={`lane-h-${row}-${column}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[segmentCenter, groundY + 0.001, roadCenter]}
          >
            <planeGeometry args={[spacing * 0.38, 0.03]} />
            <meshStandardMaterial color="#d9d2a6" />
          </mesh>
        );
      }
    }

    for (let column = 0; column <= gridSize; column += 1) {
      const roadCenter = column * spacing - offset - spacing / 2;
      for (let row = 0; row < gridSize; row += 1) {
        const segmentCenter = row * spacing - offset;
        laneMarkings.push(
          <mesh
            key={`lane-v-${column}-${row}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[roadCenter, groundY + 0.001, segmentCenter]}
          >
            <planeGeometry args={[0.03, spacing * 0.38]} />
            <meshStandardMaterial color="#d9d2a6" />
          </mesh>
        );
      }
    }

    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        const xPos = x * spacing - offset;
        const zPos = y * spacing - offset;

        const lookupAddress = getLookupAddress(zoomLevel, currentPosition, x, y, gridSystemMode, grid2Position);
        const asnRecord = asnInfo[lookupAddress.ipAddress] ?? asnCache[lookupAddress.ipAddress];
        const asnLotColor = asnRecord?.asn ? getAsnColor(asnRecord.asn) : blockOutlineColor;
        const asnLotOpacity = asnRecord?.asn ? 0.32 : 0.14;

        items.push(
          <mesh
            key={`lot-outline-${x}-${y}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[xPos, groundY + 0.002, zPos]}
          >
            <planeGeometry args={[spacing - 0.18, spacing - 0.18]} />
            <meshStandardMaterial color={asnLotColor} transparent opacity={asnLotOpacity} />
          </mesh>
        );
      }
    }

    return (
      <>
        {items}
        {laneMarkings}
        <StreetTrafficLayer gridSize={gridSize} spacing={spacing} offset={offset} groundY={groundY} />
        <StreetSceneryLayer gridSize={gridSize} spacing={spacing} offset={offset} groundY={groundY} />
      </>
    );
  };

  const cubes = [];

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const {
        ipAddress,
        label,
        displayLabel,
        firstOctetValue,
        secondOctetValue,
        thirdOctetValue,
        fourthOctetValue,
      } = getLookupAddress(zoomLevel, currentPosition, x, y, gridSystemMode, grid2Position);
      const exposureRecord = exposureInfo[ipAddress] ?? exposureCache[ipAddress];
      const serviceCount = exposureRecord?.serviceCount ?? 0;
      const buildingHeight = getHeightFromServiceCount(cubeSize, serviceCount);
      const ipTypeLabel = getIpTypeLabel(firstOctetValue, secondOctetValue);
      const color = getIPColor(firstOctetValue, secondOctetValue, thirdOctetValue, fourthOctetValue);
      const xPos = x * spacing - offset;
      const zPos = y * spacing - offset;
      const cubeId = `cube-${x}-${y}`;
      const rdapRecord = rdapInfo[ipAddress] ?? rdapCache[ipAddress];
      const asnRecord = asnInfo[ipAddress] ?? asnCache[ipAddress];
      const asnColor = getAsnColor(asnRecord?.asn);
      const dnsRecord = reverseDnsInfo[ipAddress] ?? reverseDnsCache[ipAddress];
      const topReverseDnsHostname = dnsRecord?.ptrHostnames[0] ?? dnsRecord?.fallbackHostnames[0] ?? null;
      const visibleEntities = rdapRecord ? firstUsefulEntities(rdapRecord.entities) : [];
      const flagImageUrl = getFlagImageUrl(rdapRecord?.country);
      const countryCodeLabel = getCountryCode(rdapRecord?.country)?.toUpperCase() ?? '';
      const countryName = flagImageUrl ? getCountryName(rdapRecord?.country) : null;
      const visiblePorts: number[] = [...new Set<number>((exposureRecord?.topPorts ?? [])
        .map((portLabel) => parseTopPortNumber(portLabel))
        .filter((port): port is number => typeof port === 'number'))];
      const hasHttp = visiblePorts.includes(80);
      const hasHttps = visiblePorts.includes(443);
      const hasSsh = visiblePorts.includes(22);
      const hasDns = visiblePorts.includes(53);
      const hasMail = visiblePorts.some((port) => [25, 465, 587].includes(port));
      const hasRdp = visiblePorts.includes(3389);
      const genericPortFeatureCount = Math.min(Math.max(exposureRecord?.openPortCount ?? 0, 0), 4);
      const extraPorts = visiblePorts.filter((port) => ![80, 443, 22, 53, 25, 465, 587, 3389].includes(port)).slice(0, 4);
      const openPortCount = exposureRecord?.openPortCount ?? 0;
      const buildingFamily =
        hasRdp || extraPorts.length >= 2 || openPortCount >= 4
          ? 'fort'
          : hasDns || hasMail || hasHttps || openPortCount >= 3
            ? 'stepped'
            : hasHttp || hasSsh || openPortCount >= 2 || visiblePorts.length >= 1
              ? 'tower'
              : 'block';
      const seed =
        label +
        firstOctetValue * 1000000 +
        secondOctetValue * 10000 +
        thirdOctetValue * 100 +
        fourthOctetValue +
        (gridSystemMode === 'grid2' ? 2000000 : zoomLevel * 10000);

      const widthJitter = 0.72 + pseudoRandom(seed) * 0.18;
      const depthJitter = 0.72 + pseudoRandom(seed + 1) * 0.18;
      const towerWidth = cubeSize * widthJitter;
      const towerDepth = cubeSize * depthJitter;
      const podiumHeight = Math.max(0.14, buildingHeight * 0.18);
      const towerOnlyHeight = Math.max(0.32, buildingHeight - podiumHeight);

      const blockBaseHeight = 0.07 + buildingHeight / 2;
      const blockRoofTopY = 0.07 + buildingHeight + 0.04;

      const towerBaseHeight = 0.07 + podiumHeight / 2;
      const towerUpperHeight = 0.07 + podiumHeight + towerOnlyHeight / 2;
      const towerRoofTopY = 0.07 + podiumHeight + towerOnlyHeight + 0.06;

      const steppedLowerHeight = Math.max(0.22, buildingHeight * 0.38);
      const steppedMidHeight = Math.max(0.18, buildingHeight * 0.28);
      const steppedTopHeight = Math.max(0.16, buildingHeight * 0.18);
      const steppedRoofTopY = 0.07 + steppedLowerHeight + steppedMidHeight + steppedTopHeight + 0.06;

      const fortWallHeight = Math.max(0.28, buildingHeight * 0.34);
      const keepHeight = Math.max(0.26, buildingHeight * 0.42);
      const turretHeight = Math.max(0.22, buildingHeight * 0.26);
      const fortRoofTopY = 0.07 + fortWallHeight + keepHeight + 0.06;

      const roofTopY =
        buildingFamily === 'block'
          ? blockRoofTopY
          : buildingFamily === 'stepped'
            ? steppedRoofTopY
            : buildingFamily === 'fort'
              ? fortRoofTopY
              : towerRoofTopY;

      const hitboxHeight = roofTopY + 0.08;
      const hoverScale = hoveredCube === cubeId ? 1.03 : 1;
      const blockDoorWidth = 0.14 + pseudoRandom(seed + 201) * 0.08;
      const blockDoorHeight = 0.18 + pseudoRandom(seed + 202) * 0.08;
      const blockStairSteps = 2 + Math.floor(pseudoRandom(seed + 203) * 3);
      const blockWindowColumns = 2 + Math.floor(pseudoRandom(seed + 204) * 3);
      const blockWindowRows = 2 + Math.floor(pseudoRandom(seed + 205) * 3);
      const blockVariantIndex = Math.floor(pseudoRandom(seed + 206) * 4);
      const blockVariant = ['square', 'round', 'hex', 'courtyard'][blockVariantIndex] as 'square' | 'round' | 'hex' | 'courtyard';
      const tooltipX = x < gridSize / 2 ? towerWidth / 2 + 0.82 : -(towerWidth / 2 + 3.1);
      const tooltipY = roofTopY + 0.16;
      const facadeFlagY = Math.min(Math.max(0.28, roofTopY * 0.42), roofTopY - 0.18);
      const facadeFlagZ =
        buildingFamily === 'tower'
          ? towerDepth / 2 + 0.035
          : buildingFamily === 'block'
            ? cubeSize / 2 + 0.035
            : cubeSize / 2 + 0.045;

      const trimColor = shadeColor(color, -30);
      const roofColor = shadeColor(color, -55);
      const windowColor = '#dfe8ff';

      const headerParts = [
        ipAddress,
        ipTypeLabel,
        countryName ? `(${countryName})` : '',
        asnRecord?.asn ? normalizeAsn(asnRecord.asn) ?? '' : '',
        topReverseDnsHostname ? `reverse-dns: ${topReverseDnsHostname}` : '',
      ].filter(Boolean);

      const hoverInfoLines: string[] = [
        `<div class="font-bold">${escapeHtml(headerParts.join(' — '))}</div>`,
      ];

      if (isAsnLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching ASN neighborhood data...</div>');
      } else if (asnRecord?.asn) {
        hoverInfoLines.push(
          `<div class="mt-2 rounded p-1.5 text-xs" style="background:${escapeHtml(asnColor)};color:white">` +
          `<div><span class="font-semibold">ASN neighborhood:</span> ${escapeHtml(getAsnSummaryLabel(asnRecord))}</div>` +
          `${asnRecord.country ? `<div>Country: ${escapeHtml(asnRecord.country)}</div>` : ''}` +
          `${asnRecord.registry ? `<div>Registry: ${escapeHtml(asnRecord.registry)}</div>` : ''}` +
          '</div>'
        );
      } else if (asnRecord?.error) {
        hoverInfoLines.push(`<div class="text-gray-600 mt-2 text-xs">ASN lookup unavailable: ${escapeHtml(asnRecord.error)}</div>`);
      } else {
        hoverInfoLines.push(`<div class="text-gray-600 mt-2 text-xs">ASN status: ${escapeHtml(getAsnDiagnosticLabel(asnRecord, Boolean(isAsnLoading[ipAddress])))}</div>`);
      }

      if (lookupMode === 'rdap' && isRdapLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching live RDAP record...</div>');
      }

      if (lookupMode === 'ptr' && isReverseLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching hostname data...</div>');
      }

      if (lookupMode === 'rdap' && !isRdapLoading[ipAddress] && rdapRecord?.error) {
        hoverInfoLines.push(`<div class="text-red-700 mt-2">${escapeHtml(rdapRecord.error)}</div>`);
      }

      if (lookupMode === 'ptr' && !isReverseLoading[ipAddress] && dnsRecord?.error) {
        hoverInfoLines.push(`<div class="text-red-700 mt-2">${escapeHtml(dnsRecord.error)}</div>`);
      }

      if (lookupMode === 'rdap' && !isRdapLoading[ipAddress] && rdapRecord && !rdapRecord.error) {
        const rdapLines: string[] = [];
        if (rdapRecord.org) {
          rdapLines.push(`<div><span class="text-gray-600">Organization:</span> ${escapeHtml(rdapRecord.org)}</div>`);
        }
        if (rdapRecord.networkName) {
          rdapLines.push(`<div><span class="text-gray-600">Network:</span> ${escapeHtml(rdapRecord.networkName)}</div>`);
        }
        if (visibleEntities.length > 0) {
          const entityHtml = visibleEntities.map((entity, index) =>
            `<div class="text-xs bg-gray-100 rounded p-1.5" data-entity-index="${index}">` +
            `${entity.name ? `<div>${escapeHtml(entity.name)}</div>` : ''}` +
            `${entity.roles.length > 0 ? `<div class="text-gray-600">${escapeHtml(entity.roles.join(', '))}</div>` : ''}` +
            `${entity.email ? `<div>${escapeHtml(entity.email)}</div>` : ''}` +
            '</div>'
          ).join('');
          rdapLines.push(`<div class="pt-1"><div class="text-gray-600">Contacts:</div><div class="space-y-1 mt-1">${entityHtml}</div></div>`);
        }
        if (rdapLines.length > 0) {
          hoverInfoLines.push(`<div class="mt-2 space-y-1">${rdapLines.join('')}</div>`);
        }
      }

      if (lookupMode === 'ptr' && !isReverseLoading[ipAddress] && dnsRecord && !dnsRecord.error) {
        if (dnsRecord.hostnames.length > 0) {
          const ptrLines = dnsRecord.ptrHostnames.map((hostname) => `<div class="text-xs bg-gray-100 rounded p-1.5 break-all">${escapeHtml(hostname)}</div>`).join('');
          const fallbackLines = dnsRecord.fallbackHostnames.map((hostname) => `<div class="text-xs bg-gray-100 rounded p-1.5 break-all">${escapeHtml(hostname)}</div>`).join('');
          hoverInfoLines.push(
            '<div class="mt-2 space-y-1"><div class="text-gray-600">Hostnames:</div><div class="space-y-1 mt-1">' +
            `${dnsRecord.ptrHostnames.length > 0 ? '<div class="text-xs text-gray-600">PTR / reverse DNS</div>' : ''}` +
            ptrLines +
            `${dnsRecord.fallbackHostnames.length > 0 ? '<div class="text-xs text-gray-600 mt-2">Public scan data fallback</div>' : ''}` +
            fallbackLines +
            '</div></div>'
          );
        } else {
          hoverInfoLines.push('<div class="mt-2 space-y-1"><div class="text-gray-600">Hostnames:</div><div class="text-gray-700">No hostname was found for this address.</div></div>');
        }
      }

      const hoverInfoHtml = hoverInfoLines.join('');

      const windowBands = [];
      {
        const effectiveHeight =
          buildingFamily === 'block'
            ? buildingHeight
            : buildingFamily === 'tower'
              ? towerOnlyHeight
              : buildingFamily === 'stepped'
                ? steppedLowerHeight + steppedMidHeight + steppedTopHeight
                : fortWallHeight + keepHeight;

        const baseY =
          buildingFamily === 'block'
            ? 0.07
            : buildingFamily === 'tower'
              ? 0.07 + podiumHeight
              : buildingFamily === 'stepped'
                ? 0.07
                : 0.07 + 0.06;

        const faceWidth =
          buildingFamily === 'block'
            ? cubeSize * 0.88
            : buildingFamily === 'tower'
              ? towerWidth
              : buildingFamily === 'stepped'
                ? cubeSize * 0.92
                : cubeSize * 0.94;

        const faceDepth =
          buildingFamily === 'block'
            ? cubeSize * 0.88
            : buildingFamily === 'tower'
              ? towerDepth
              : buildingFamily === 'stepped'
                ? cubeSize * 0.92
                : cubeSize * 0.94;

        const levels = Math.max(1, Math.floor(Math.max(0.22, effectiveHeight - 0.12) / 0.22));
        for (let level = 0; level < levels; level += 1) {
          const bandY = baseY + 0.12 + level * 0.22;
          if (bandY >= roofTopY - 0.08) {
            break;
          }

          windowBands.push(
            <mesh key={`${cubeId}-win-front-${level}`} position={[0, bandY, faceDepth / 2 + 0.01]}>
              <planeGeometry args={[faceWidth * 0.68, 0.075]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={0.28} transparent opacity={0.42} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-back-${level}`} position={[0, bandY, -faceDepth / 2 - 0.01]} rotation={[0, Math.PI, 0]}>
              <planeGeometry args={[faceWidth * 0.68, 0.075]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={0.22} transparent opacity={0.3} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-left-${level}`} position={[-faceWidth / 2 - 0.01, bandY, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <planeGeometry args={[faceDepth * 0.68, 0.075]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={0.22} transparent opacity={0.3} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-right-${level}`} position={[faceWidth / 2 + 0.01, bandY, 0]} rotation={[0, Math.PI / 2, 0]}>
              <planeGeometry args={[faceDepth * 0.68, 0.075]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={0.22} transparent opacity={0.3} />
            </mesh>
          );
        }
      }

      cubes.push(
        <group key={cubeId} position={[xPos, groundY, zPos]}>
          <mesh position={[0, 0.035, 0]} receiveShadow>
            <boxGeometry args={[spacing - sidewalkInset, 0.07, spacing - sidewalkInset]} />
            <meshStandardMaterial color="#9a9a9a" />
          </mesh>

          <mesh position={[0, 0.07, 0]} receiveShadow>
            <boxGeometry args={[cubeSize + 0.1, 0.04, cubeSize + 0.1]} />
            <meshStandardMaterial color="#7f7f7f" />
          </mesh>

          <group scale={[hoverScale, hoverScale, hoverScale]}>
            <mesh
              position={[0, hitboxHeight / 2, 0]}
              onClick={(event) => {
                event.stopPropagation();
                handleGridClick(x, y);
              }}
              onPointerOver={() => {
                document.body.style.cursor = 'pointer';
                setHoveredCube(cubeId);
                setHoveredIpAddress(ipAddress);
                onHoverInfoHtml?.(hoverInfoHtml);
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
                setHoveredCube(null);
                setHoveredIpAddress(null);
                onHoverInfoHtml?.('');
              }}
            >
              <boxGeometry
                args={[
                  Math.max(cubeSize + 0.16, towerWidth + 0.12),
                  hitboxHeight,
                  Math.max(cubeSize + 0.16, towerDepth + 0.12),
                ]}
              />
              <meshBasicMaterial transparent opacity={0} />
            </mesh>

            {buildingFamily === 'block' && (
              <>
                {blockVariant === 'square' && (
                  <>
                    <mesh position={[0, blockBaseHeight, 0]} castShadow receiveShadow>
                      <boxGeometry args={[cubeSize * 0.98, buildingHeight, cubeSize * 0.98]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[cubeSize * 0.9, 0.06, cubeSize * 0.9]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'round' && (
                  <>
                    <mesh position={[0, blockBaseHeight, 0]} castShadow receiveShadow>
                      <cylinderGeometry args={[cubeSize * 0.5, cubeSize * 0.5, buildingHeight, 28]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <cylinderGeometry args={[cubeSize * 0.46, cubeSize * 0.46, 0.06, 28]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'hex' && (
                  <>
                    <mesh position={[0, blockBaseHeight, 0]} castShadow receiveShadow>
                      <cylinderGeometry args={[cubeSize * 0.54, cubeSize * 0.54, buildingHeight, 6]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <cylinderGeometry args={[cubeSize * 0.5, cubeSize * 0.5, 0.06, 6]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'courtyard' && (
                  <>
                    <mesh position={[0, blockBaseHeight, cubeSize * 0.34]} castShadow receiveShadow>
                      <boxGeometry args={[cubeSize * 0.98, buildingHeight, cubeSize * 0.3]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[0, blockBaseHeight, -cubeSize * 0.34]} castShadow receiveShadow>
                      <boxGeometry args={[cubeSize * 0.98, buildingHeight, cubeSize * 0.3]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[-cubeSize * 0.34, blockBaseHeight, 0]} castShadow receiveShadow>
                      <boxGeometry args={[cubeSize * 0.3, buildingHeight, cubeSize * 0.38]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[cubeSize * 0.34, blockBaseHeight, 0]} castShadow receiveShadow>
                      <boxGeometry args={[cubeSize * 0.3, buildingHeight, cubeSize * 0.38]} />
                      <meshStandardMaterial color={color} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, cubeSize * 0.34]} castShadow>
                      <boxGeometry args={[cubeSize * 0.9, 0.06, cubeSize * 0.22]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, -cubeSize * 0.34]} castShadow>
                      <boxGeometry args={[cubeSize * 0.9, 0.06, cubeSize * 0.22]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[-cubeSize * 0.34, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[cubeSize * 0.22, 0.06, cubeSize * 0.3]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[cubeSize * 0.34, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[cubeSize * 0.22, 0.06, cubeSize * 0.3]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}
              </>
            )}

            {buildingFamily === 'block' && (
              <>
                {Array.from({ length: blockStairSteps }).map((_, stepIndex) => (
                  <mesh
                    key={`${cubeId}-block-step-${stepIndex}`}
                    position={[0, 0.075 + stepIndex * 0.025, cubeSize / 2 + 0.06 + stepIndex * 0.035]}
                    castShadow
                    receiveShadow
                  >
                    <boxGeometry args={[blockDoorWidth * 1.7 + stepIndex * 0.04, 0.025, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 12)} />
                  </mesh>
                ))}

                <mesh position={[0, 0.11 + blockDoorHeight / 2, cubeSize / 2 + 0.02]} castShadow>
                  <boxGeometry args={[blockDoorWidth, blockDoorHeight, 0.05]} />
                  <meshStandardMaterial color={shadeColor(trimColor, -16)} />
                </mesh>

                {blockVariant === 'square' &&
                  Array.from({ length: blockWindowRows }).map((_, rowIndex) =>
                    Array.from({ length: blockWindowColumns }).flatMap((__, colIndex) => {
                      const xOffset =
                        (colIndex - (blockWindowColumns - 1) / 2) * (cubeSize * 0.22);
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return [
                        <mesh
                          key={`${cubeId}-block-window-front-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, cubeSize / 2 + 0.021]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-block-window-back-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, -cubeSize / 2 - 0.021]}
                          rotation={[0, Math.PI, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-block-window-left-${rowIndex}-${colIndex}`}
                          position={[-cubeSize / 2 - 0.021, yOffset, xOffset]}
                          rotation={[0, -Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-block-window-right-${rowIndex}-${colIndex}`}
                          position={[cubeSize / 2 + 0.021, yOffset, xOffset]}
                          rotation={[0, Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>
                      ];
                    })
                  )}

                {blockVariant === 'round' &&
                  Array.from({ length: blockWindowRows + 1 }).map((_, rowIndex) =>
                    Array.from({ length: 8 }).map((__, colIndex) => {
                      const angle = (Math.PI * 2 * colIndex) / 8;
                      const radius = cubeSize * 0.52;
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return (
                        <mesh
                          key={`${cubeId}-round-window-${rowIndex}-${colIndex}`}
                          position={[Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius]}
                          rotation={[0, -angle + Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>
                      );
                    })
                  )}

                {blockVariant === 'hex' &&
                  Array.from({ length: blockWindowRows + 1 }).map((_, rowIndex) =>
                    Array.from({ length: 6 }).map((__, colIndex) => {
                      const angle = (Math.PI * 2 * colIndex) / 6;
                      const radius = cubeSize * 0.54;
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return (
                        <mesh
                          key={`${cubeId}-hex-window-${rowIndex}-${colIndex}`}
                          position={[Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius]}
                          rotation={[0, -angle + Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.12, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>
                      );
                    })
                  )}

                {blockVariant === 'courtyard' &&
                  Array.from({ length: blockWindowRows }).map((_, rowIndex) =>
                    Array.from({ length: blockWindowColumns }).flatMap((__, colIndex) => {
                      const xOffset =
                        (colIndex - (blockWindowColumns - 1) / 2) * (cubeSize * 0.22);
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return [
                        <mesh
                          key={`${cubeId}-court-window-front-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, cubeSize * 0.49]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-court-window-back-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, -cubeSize * 0.49]}
                          rotation={[0, Math.PI, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-court-window-left-${rowIndex}-${colIndex}`}
                          position={[-cubeSize * 0.49, yOffset, xOffset]}
                          rotation={[0, -Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>,
                        <mesh
                          key={`${cubeId}-court-window-right-${rowIndex}-${colIndex}`}
                          position={[cubeSize * 0.49, yOffset, xOffset]}
                          rotation={[0, Math.PI / 2, 0]}
                        >
                          <planeGeometry args={[0.09, 0.08]} />
                          <meshStandardMaterial
                            color={windowColor}
                            emissive={windowColor}
                            emissiveIntensity={0.22}
                            transparent
                            opacity={0.34}
                          />
                        </mesh>
                      ];
                    })
                  )}

                {blockVariant !== 'courtyard' && (
                  <mesh position={[0, blockRoofTopY + 0.02, 0]} castShadow>
                    <boxGeometry args={[cubeSize * 0.18, 0.07, cubeSize * 0.18]} />
                    <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                  </mesh>
                )}
              </>
            )}

            {buildingFamily === 'tower' && (
              <>
                <mesh position={[0, towerBaseHeight, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 0.88, podiumHeight * 0.9, cubeSize * 0.88]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, towerUpperHeight + 0.06, 0]} castShadow receiveShadow>
                  <boxGeometry args={[towerWidth * 0.74, towerOnlyHeight * 1.1, towerDepth * 0.74]} />
                  <meshStandardMaterial color={color} />
                </mesh>
                <mesh position={[0, towerRoofTopY - 0.03, 0]} castShadow>
                  <boxGeometry args={[towerWidth * 0.9, 0.06, towerDepth * 0.9]} />
                  <meshStandardMaterial color={roofColor} />
                </mesh>
              </>
            )}

            {buildingFamily === 'stepped' && (
              <>
                <mesh position={[0, 0.07 + steppedLowerHeight / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 1.08, steppedLowerHeight * 0.95, cubeSize * 1.08]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, 0.07 + steppedLowerHeight + steppedMidHeight / 2 + 0.03, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 0.62, steppedMidHeight * 1.08, cubeSize * 0.62]} />
                  <meshStandardMaterial color={color} />
                </mesh>
                <mesh position={[0, 0.07 + steppedLowerHeight + steppedMidHeight + steppedTopHeight / 2 + 0.06, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 0.34, steppedTopHeight * 1.15, cubeSize * 0.34]} />
                  <meshStandardMaterial color={shadeColor(color, 20)} />
                </mesh>
                <mesh position={[0, steppedRoofTopY - 0.03, 0]} castShadow>
                  <boxGeometry args={[cubeSize * 0.44, 0.06, cubeSize * 0.44]} />
                  <meshStandardMaterial color={roofColor} />
                </mesh>
              </>
            )}

            {buildingFamily === 'fort' && (
              <>
                <mesh position={[0, 0.07 + fortWallHeight / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 1.16, fortWallHeight * 0.92, cubeSize * 1.16]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, 0.07 + fortWallHeight + keepHeight / 2 + 0.08, 0]} castShadow receiveShadow>
                  <boxGeometry args={[cubeSize * 0.42, keepHeight * 1.12, cubeSize * 0.42]} />
                  <meshStandardMaterial color={color} />
                </mesh>
                {[
                  [-cubeSize * 0.42, -cubeSize * 0.42],
                  [cubeSize * 0.42, -cubeSize * 0.42],
                  [-cubeSize * 0.42, cubeSize * 0.42],
                  [cubeSize * 0.42, cubeSize * 0.42],
                ].map((offsets, turretIndex) => (
                  <mesh
                    key={`${cubeId}-turret-${turretIndex}`}
                    position={[offsets[0], 0.07 + fortWallHeight + turretHeight / 2, offsets[1]]}
                    castShadow
                    receiveShadow
                  >
                    <cylinderGeometry args={[0.11, 0.11, turretHeight, 10]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 8)} />
                  </mesh>
                ))}
                <mesh position={[0, fortRoofTopY - 0.03, 0]} castShadow>
                  <boxGeometry args={[cubeSize * 0.56, 0.06, cubeSize * 0.56]} />
                  <meshStandardMaterial color={roofColor} />
                </mesh>
                {[-0.28, -0.09, 0.09, 0.28].map((xOffset, crenelIndex) => (
                  <mesh
                    key={`${cubeId}-crenel-front-${crenelIndex}`}
                    position={[xOffset, 0.07 + fortWallHeight + 0.05, cubeSize * 0.58]}
                    castShadow
                  >
                    <boxGeometry args={[0.08, 0.1, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 10)} />
                  </mesh>
                ))}
                {[-0.28, -0.09, 0.09, 0.28].map((xOffset, crenelIndex) => (
                  <mesh
                    key={`${cubeId}-crenel-back-${crenelIndex}`}
                    position={[xOffset, 0.07 + fortWallHeight + 0.05, -cubeSize * 0.58]}
                    castShadow
                  >
                    <boxGeometry args={[0.08, 0.1, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 10)} />
                  </mesh>
                ))}
              </>
            )}

            {buildingFamily === 'tower' && genericPortFeatureCount > 0 && Array.from({ length: genericPortFeatureCount }).map((_, portIndex) => {
              const finX = -towerWidth * 0.3 + portIndex * (towerWidth * 0.2);
              const finHeight = 0.16 + portIndex * 0.06;
              return (
                <mesh key={`${cubeId}-generic-port-fin-${portIndex}`} position={[finX, roofTopY + finHeight / 2 + 0.02, towerDepth * 0.28]} castShadow>
                  <boxGeometry args={[0.08, finHeight, 0.12]} />
                  <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.35} />
                </mesh>
              );
            })}

            {buildingFamily === 'tower' && hasHttp && (
              <mesh position={[0, 0.17, towerDepth / 2 + 0.055]} castShadow>
                <boxGeometry args={[towerWidth * 0.5, 0.22, 0.1]} />
                <meshStandardMaterial color="#60a5fa" emissive="#60a5fa" emissiveIntensity={0.25} />
              </mesh>
            )}

            {buildingFamily !== 'block' && hasHttps && (
              <>
                <mesh position={[0, 0.33, (buildingFamily === 'tower' ? towerDepth : cubeSize) / 2 + 0.06]} castShadow>
                  <boxGeometry args={[cubeSize * 0.54, 0.08, 0.08]} />
                  <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.3} />
                </mesh>
                <mesh position={[-cubeSize * 0.2, 0.25, (buildingFamily === 'tower' ? towerDepth : cubeSize) / 2 + 0.06]} castShadow>
                  <boxGeometry args={[0.08, 0.16, 0.08]} />
                  <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.3} />
                </mesh>
                <mesh position={[cubeSize * 0.2, 0.25, (buildingFamily === 'tower' ? towerDepth : cubeSize) / 2 + 0.06]} castShadow>
                  <boxGeometry args={[0.08, 0.16, 0.08]} />
                  <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.3} />
                </mesh>
              </>
            )}

            {buildingFamily !== 'block' && hasSsh && (
              <mesh position={[-cubeSize / 2 - 0.14, 0.24, 0]} castShadow receiveShadow>
                <boxGeometry args={[0.24, 0.34, cubeSize * 0.5]} />
                <meshStandardMaterial color="#34d399" emissive="#34d399" emissiveIntensity={0.22} />
              </mesh>
            )}

            {buildingFamily === 'fort' && hasRdp && (
              <mesh position={[cubeSize / 2 + 0.14, 0.26, -cubeSize * 0.06]} castShadow receiveShadow>
                <boxGeometry args={[0.28, 0.42, cubeSize * 0.56]} />
                <meshStandardMaterial color="#f87171" emissive="#f87171" emissiveIntensity={0.18} />
              </mesh>
            )}

            {buildingFamily !== 'block' && hasDns && (
              <>
                <mesh position={[0, roofTopY + 0.18, 0]} castShadow>
                  <cylinderGeometry args={[0.025, 0.025, 0.36, 12]} />
                  <meshStandardMaterial color="#d1d5db" metalness={0.6} roughness={0.3} />
                </mesh>
                <mesh position={[0, roofTopY + 0.43, 0]} castShadow>
                  <sphereGeometry args={[0.08, 12, 12]} />
                  <meshStandardMaterial color="#a78bfa" emissive="#a78bfa" emissiveIntensity={0.3} />
                </mesh>
              </>
            )}

            {buildingFamily !== 'block' && hasMail && (
              <mesh position={[cubeSize * 0.24, roofTopY + 0.18, cubeSize * 0.1]} castShadow receiveShadow>
                <boxGeometry args={[0.2, 0.38, 0.2]} />
                <meshStandardMaterial color="#fb7185" emissive="#fb7185" emissiveIntensity={0.24} />
              </mesh>
            )}

            {buildingFamily !== 'block' && extraPorts.map((port, extraIndex) => {
              const extraHeight = 0.22 + (port % 5) * 0.06;
              const extraX = -cubeSize * 0.3 + extraIndex * (cubeSize * 0.22);
              const extraZ = -cubeSize * 0.22 + (extraIndex % 2) * 0.14;
              return (
                <mesh key={`${cubeId}-port-spire-${port}`} position={[extraX, roofTopY + extraHeight / 2 + 0.08, extraZ]} castShadow>
                  <boxGeometry args={[0.09, extraHeight, 0.09]} />
                  <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.26} />
                </mesh>
              );
            })}

            {flagImageUrl ? (
              <Html position={[0, facadeFlagY, facadeFlagZ]} transform sprite distanceFactor={8}>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onFlagClick({
                      ipAddress,
                      label,
                      color,
                      buildingFamily,
                      buildingHeight,
                      flagImageUrl,
                      countryCodeLabel,
                      asn: asnRecord?.asn,
                      asnName: asnRecord?.asnName,
                      route: asnRecord?.route,
                      asnColor,
                    });
                  }}
                  style={{
                    width: '20px',
                    height: '14px',
                    padding: 0,
                    border: '1px solid rgba(255,255,255,0.5)',
                    borderRadius: '1px',
                    background: 'transparent',
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.65))',
                    userSelect: 'none',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                  }}
                  title="Open building view"
                >
                  <img
                    src={flagImageUrl}
                    alt={countryCodeLabel}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: '1px',
                      display: 'block',
                    }}
                  />
                </button>
              </Html>
            ) : (
              <Html position={[0, facadeFlagY, facadeFlagZ]} transform sprite distanceFactor={8}>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onFlagClick({
                      ipAddress,
                      label,
                      color,
                      buildingFamily,
                      buildingHeight,
                      flagImageUrl: null,
                      countryCodeLabel,
                      asn: asnRecord?.asn,
                      asnName: asnRecord?.asnName,
                      route: asnRecord?.route,
                      asnColor,
                    });
                  }}
                  style={{
                    width: '20px',
                    height: '14px',
                    padding: 0,
                    border: '1px solid rgba(255,255,255,0.5)',
                    borderRadius: '1px',
                    background: '#ffffff',
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.65))',
                    userSelect: 'none',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                  }}
                  title="Open building view"
                />
              </Html>
            )}

            {windowBands}

            <Text
              position={[0, roofTopY + 0.12, 0]}
              fontSize={0.2}
              color="white"
              anchorX="center"
              anchorY="middle"
              rotation={[-Math.PI / 2, 0, 0]}
            >
              {displayLabel}
            </Text>
          </group>

          {hoveredCube === cubeId && (
            <Html fullscreen>
              <div data-info-panel="true" style={{ display: 'none' }}>
                <div className="font-bold">{ipAddress} — {ipTypeLabel}{countryName ? ` (${countryName})` : ""}{asnRecord?.asn ? ` — ${normalizeAsn(asnRecord.asn)}` : ""}{topReverseDnsHostname ? ` — reverse-dns: ${topReverseDnsHostname}` : ""}</div>

                {lookupMode === 'rdap' && isRdapLoading[ipAddress] && (
                  <div className="text-blue-700 mt-2">Fetching live RDAP record...</div>
                )}

                {lookupMode === 'ptr' && isReverseLoading[ipAddress] && (
                  <div className="text-blue-700 mt-2">Fetching hostname data...</div>
                )}

                {isAsnLoading[ipAddress] && (
                  <div className="text-blue-700 mt-2">Fetching ASN neighborhood data...</div>
                )}

                {!isAsnLoading[ipAddress] && asnRecord?.asn && (
                  <div className="mt-2 rounded p-1.5 text-xs" style={{ background: asnColor, color: 'white' }}>
                    <div><span className="font-semibold">ASN neighborhood:</span> {getAsnSummaryLabel(asnRecord)}</div>
                    {asnRecord.country && <div>Country: {asnRecord.country}</div>}
                    {asnRecord.registry && <div>Registry: {asnRecord.registry}</div>}
                  </div>
                )}

                {!isAsnLoading[ipAddress] && asnRecord?.error && (
                  <div className="text-gray-600 mt-2 text-xs">ASN lookup unavailable: {asnRecord.error}</div>
                )}

                {lookupMode === 'rdap' && !isRdapLoading[ipAddress] && rdapRecord?.error && (
                  <div className="text-red-700 mt-2">{rdapRecord.error}</div>
                )}

                {lookupMode === 'ptr' && !isReverseLoading[ipAddress] && dnsRecord?.error && (
                  <div className="text-red-700 mt-2">{dnsRecord.error}</div>
                )}

                {lookupMode === 'rdap' && !isRdapLoading[ipAddress] && rdapRecord && !rdapRecord.error && (
                  <div className="mt-2 space-y-1">
                    {rdapRecord.org && (
                      <div>
                        <span className="text-gray-600">Organization:</span> {rdapRecord.org}
                      </div>
                    )}
                    {rdapRecord.networkName && (
                      <div>
                        <span className="text-gray-600">Network:</span> {rdapRecord.networkName}
                      </div>
                    )}
                    {visibleEntities.length > 0 && (
                      <div className="pt-1">
                        <div className="text-gray-600">Contacts:</div>
                        <div className="space-y-1 mt-1">
                          {visibleEntities.map((entity, index) => (
                            <div key={`${ipAddress}-entity-${index}`} className="text-xs bg-gray-100 rounded p-1.5">
                              {entity.name && <div>{entity.name}</div>}
                              {entity.roles.length > 0 && <div className="text-gray-600">{entity.roles.join(', ')}</div>}
                              {entity.email && <div>{entity.email}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {lookupMode === 'ptr' && !isReverseLoading[ipAddress] && dnsRecord && !dnsRecord.error && (
                  <div className="mt-2 space-y-1">
                    <div className="text-gray-600">Hostnames:</div>
                    {dnsRecord.hostnames.length > 0 ? (
                      <div className="space-y-1 mt-1">
                        {dnsRecord.ptrHostnames.length > 0 && (
                          <div className="text-xs text-gray-600">PTR / reverse DNS</div>
                        )}
                        {dnsRecord.ptrHostnames.map((hostname) => (
                          <div key={`ptr-${hostname}`} className="text-xs bg-gray-100 rounded p-1.5 break-all">
                            {hostname}
                          </div>
                        ))}
                        {dnsRecord.fallbackHostnames.length > 0 && (
                          <div className="text-xs text-gray-600 mt-2">Public scan data fallback</div>
                        )}
                        {dnsRecord.fallbackHostnames.map((hostname) => (
                          <div key={`fallback-${hostname}`} className="text-xs bg-gray-100 rounded p-1.5 break-all">
                            {hostname}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-gray-700">No hostname was found for this address.</div>
                    )}
                  </div>
                )}
              </div>
            </Html>
          )}
        </group>
      );
    }
  }

  return (
    <>
      {createStreetGrid()}
      {cubes}
    </>
  );
}

export default IPGrid;
