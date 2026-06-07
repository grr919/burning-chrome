import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import IPGrid from './components/IPGrid';
import {
  getMultiplayerRoomKey,
  useMultiplayerPresence,
  type MultiplayerCell,
  type MultiplayerPlayerLocation,
} from './hooks/useMultiplayerPresence';

type GridPosition = {
  firstOctet: number;
  secondOctet: number;
  thirdOctet: number;
  fourthOctet: number;
};

type LookupMode = 'rdap' | 'ptr';
type InfoDisplayMode = 'structured' | 'prose';

type HttpsCertificateResponse = {
  provider: 'https_certificate';
  ipAddress: string;
  status: 'ready' | 'error';
  host: string;
  port: number;
  lookupMode?: 'direct_ip' | 'hostname_sni';
  attemptedHosts?: string[];
  statusSummary?: string;
  subjectCn?: string;
  subjectAltNames: string[];
  issuerCn?: string;
  validFrom?: string;
  validTo?: string;
  serialNumber?: string;
  fingerprint256?: string;
  authorized?: boolean;
  authorizationError?: string;
  error?: string;
  warning?: string;
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

type SshLaunchResponse = {
  provider: 'ssh_launch';
  status: 'ready' | 'error';
  ipAddress: string;
  command?: string;
  statusSummary?: string;
  error?: string;
};

type BuildingViewState = {
  ipAddress: string;
  label: number;
  color: string;
  buildingFamily: 'block' | 'tower' | 'stepped' | 'fort';
  buildingHeight: number;
  flagImageUrl?: string | null;
  countryCodeLabel?: string;
  asn?: string;
  asnName?: string;
  route?: string;
  asnColor?: string;
};

type DirectoryEntry = {
  hostname: string;
  url: string;
};

type LayoutMode = 'grid' | 'street';
type GridSystemMode = 'grid1' | 'grid2';
type StreetOrientation = 'row' | 'column';

type Grid2Position = {
  outerFirstOctet: number;
  outerSecondOctet: number;
  innerThirdStart: number;
  innerFourthStart: number;
};

type PlayerLocation = MultiplayerPlayerLocation;

const GRID2_WINDOW_SIZE = 16;
const DEFAULT_GRID2_POSITION: Grid2Position = {
  outerFirstOctet: 0,
  outerSecondOctet: 0,
  innerThirdStart: 0,
  innerFourthStart: 0,
};

function clampOctet(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampGrid2WindowStart(value: number): number {
  return Math.max(0, Math.min(256 - GRID2_WINDOW_SIZE, Math.round(value)));
}

type StreetBuilding = {
  ipAddress: string;
  label: number;
  color: string;
  buildingFamily: 'block' | 'tower' | 'stepped' | 'fort';
  buildingHeight: number;
  streetSide: 'left' | 'right';
  streetPosition: number;
};

function getIpFromCell(zoomLevel: number, currentPosition: GridPosition, x: number, y: number): string {
  const value = y * 16 + x;

  if (zoomLevel === 0) {
    return `${value}.0.0.0`;
  }

  if (zoomLevel === 1) {
    return `${currentPosition.firstOctet}.${value}.0.0`;
  }

  if (zoomLevel === 2) {
    return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${value}.0`;
  }

  return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.${value}`;
}


function getGrid2IpFromCell(grid2Position: Grid2Position, x: number, y: number): string {
  const firstOctet = clampOctet(grid2Position.outerFirstOctet);
  const secondOctet = clampOctet(grid2Position.outerSecondOctet);
  const thirdOctet = clampOctet(grid2Position.innerThirdStart + y);
  const fourthOctet = clampOctet(grid2Position.innerFourthStart + x);
  return `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

function getGridAwareIpFromCell(
  gridSystemMode: GridSystemMode,
  zoomLevel: number,
  currentPosition: GridPosition,
  grid2Position: Grid2Position,
  x: number,
  y: number
): string {
  if (gridSystemMode === 'grid2') {
    return getGrid2IpFromCell(grid2Position, x, y);
  }

  return getIpFromCell(zoomLevel, currentPosition, x, y);
}

function parseIpOctets(ipAddress: string): [number, number, number, number] {
  const [first = 0, second = 0, third = 0, fourth = 0] = ipAddress.split('.').map((part) => Number.parseInt(part, 10));
  return [first, second, third, fourth].map((value) => (Number.isFinite(value) ? clampOctet(value) : 0)) as [number, number, number, number];
}

function getRepresentativeTarget(gridSystemMode: GridSystemMode, zoomLevel: number, currentPosition: GridPosition, grid2Position: Grid2Position): string {
  if (gridSystemMode === 'grid2') {
    return getGrid2IpFromCell(grid2Position, 0, 0);
  }

  if (zoomLevel === 0) return '8.8.8.8';
  if (zoomLevel === 1) return `${currentPosition.firstOctet}.1.1.1`;
  if (zoomLevel === 2) return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.1.1`;
  return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.1`;
}


function BuildingDetailScene({
  building,
  directoryEntries,
  onExit,
}: {
  building: BuildingViewState;
  directoryEntries: DirectoryEntry[];
  onExit: () => void;
}) {
  const windowColor = '#dfe8ff';
  const trimColor = '#4b5563';
  const roofColor = '#374151';

  const normalizedHeight = Math.max(2.8, Math.min(7.2, building.buildingHeight * 2.2));
  const podiumHeight = Math.max(0.5, normalizedHeight * 0.22);
  const towerOnlyHeight = Math.max(1.4, normalizedHeight - podiumHeight);
  const steppedLowerHeight = Math.max(1.1, normalizedHeight * 0.4);
  const steppedMidHeight = Math.max(0.8, normalizedHeight * 0.28);
  const steppedTopHeight = Math.max(0.65, normalizedHeight * 0.18);
  const fortWallHeight = Math.max(1.0, normalizedHeight * 0.34);
  const keepHeight = Math.max(1.2, normalizedHeight * 0.44);
  const turretHeight = Math.max(0.9, normalizedHeight * 0.26);

  const roofTopY =
    building.buildingFamily === 'block'
      ? normalizedHeight
      : building.buildingFamily === 'tower'
        ? podiumHeight + towerOnlyHeight
        : building.buildingFamily === 'stepped'
          ? steppedLowerHeight + steppedMidHeight + steppedTopHeight
          : fortWallHeight + keepHeight;

  const flagY = Math.max(1.4, roofTopY * 0.46);
  const labelY = roofTopY + 0.8;

  return (
    <>
      <fog attach="fog" args={['#4b91fa', 10, 28]} />
      <ambientLight intensity={0.7} />
      <pointLight position={[6, 10, 8]} intensity={1.1} />
      <directionalLight position={[-6, 9, 6]} intensity={0.85} castShadow />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.46, 0]} receiveShadow>
        <planeGeometry args={[14, 14]} />
        <meshStandardMaterial color="#2a2a2a" />
      </mesh>

      <mesh position={[0, -0.2, 0]} receiveShadow>
        <boxGeometry args={[4.8, 0.5, 4.8]} />
        <meshStandardMaterial color="#8f8f8f" />
      </mesh>

      {building.buildingFamily === 'block' && (
        <>
          <mesh position={[0, normalizedHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[3.4, normalizedHeight, 3.4]} />
            <meshStandardMaterial color={building.color} />
          </mesh>
          <mesh position={[0, normalizedHeight + 0.12, 0]} castShadow>
            <boxGeometry args={[3.0, 0.18, 3.0]} />
            <meshStandardMaterial color={roofColor} />
          </mesh>
        </>
      )}

      {building.buildingFamily === 'tower' && (
        <>
          <mesh position={[0, podiumHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[3.0, podiumHeight, 3.0]} />
            <meshStandardMaterial color={trimColor} />
          </mesh>
          <mesh position={[0, podiumHeight + towerOnlyHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[2.1, towerOnlyHeight, 2.1]} />
            <meshStandardMaterial color={building.color} />
          </mesh>
          <mesh position={[0, roofTopY + 0.12, 0]} castShadow>
            <boxGeometry args={[2.3, 0.18, 2.3]} />
            <meshStandardMaterial color={roofColor} />
          </mesh>
        </>
      )}

      {building.buildingFamily === 'stepped' && (
        <>
          <mesh position={[0, steppedLowerHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[3.6, steppedLowerHeight, 3.6]} />
            <meshStandardMaterial color={trimColor} />
          </mesh>
          <mesh position={[0, steppedLowerHeight + steppedMidHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[2.5, steppedMidHeight, 2.5]} />
            <meshStandardMaterial color={building.color} />
          </mesh>
          <mesh position={[0, steppedLowerHeight + steppedMidHeight + steppedTopHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[1.45, steppedTopHeight, 1.45]} />
            <meshStandardMaterial color={building.color} />
          </mesh>
          <mesh position={[0, roofTopY + 0.12, 0]} castShadow>
            <boxGeometry args={[1.6, 0.18, 1.6]} />
            <meshStandardMaterial color={roofColor} />
          </mesh>
        </>
      )}

      {building.buildingFamily === 'fort' && (
        <>
          <mesh position={[0, fortWallHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[3.9, fortWallHeight, 3.9]} />
            <meshStandardMaterial color={trimColor} />
          </mesh>
          <mesh position={[0, fortWallHeight + keepHeight / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[1.55, keepHeight, 1.55]} />
            <meshStandardMaterial color={building.color} />
          </mesh>
          {[
            [-1.35, -1.35],
            [1.35, -1.35],
            [-1.35, 1.35],
            [1.35, 1.35],
          ].map((offsets, turretIndex) => (
            <mesh
              key={`detail-turret-${turretIndex}`}
              position={[offsets[0], fortWallHeight + turretHeight / 2 - 0.1, offsets[1]]}
              castShadow
              receiveShadow
            >
              <cylinderGeometry args={[0.42, 0.42, turretHeight, 12]} />
              <meshStandardMaterial color={trimColor} />
            </mesh>
          ))}
          <mesh position={[0, roofTopY + 0.12, 0]} castShadow>
            <boxGeometry args={[1.75, 0.18, 1.75]} />
            <meshStandardMaterial color={roofColor} />
          </mesh>
        </>
      )}

      {Array.from({ length: 4 }).map((_, rowIndex) =>
        Array.from({ length: 3 }).map((__, colIndex) => {
          const xOffset = (colIndex - 1) * 0.78;
          const yOffset = 1.05 + rowIndex * 0.74;
          if (yOffset >= roofTopY - 0.35) return null;
          return (
            <mesh key={`detail-window-${rowIndex}-${colIndex}`} position={[xOffset, yOffset, 1.72]}>
              <planeGeometry args={[0.36, 0.34]} />
              <meshStandardMaterial
                color={windowColor}
                emissive={windowColor}
                emissiveIntensity={0.22}
                transparent
                opacity={0.42}
              />
            </mesh>
          );
        })
      )}

      <mesh position={[0, 0.45, 1.73]} castShadow>
        <boxGeometry args={[0.72, 0.9, 0.08]} />
        <meshStandardMaterial color="#374151" />
      </mesh>

      <Html position={[1.45, 0.86, 1.78]} transform sprite distanceFactor={8}>
        <div
          style={{
            width: '156px',
            maxHeight: '172px',
            overflow: 'hidden',
            border: '1px solid rgba(17,24,39,0.75)',
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.94)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            color: '#111827',
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '10px',
            lineHeight: 1.25,
            padding: '6px',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: '4px' }}>Directory</div>
          {directoryEntries.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {directoryEntries.map((entry) => (
                <a
                  key={entry.hostname}
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  title={entry.hostname}
                  style={{
                    color: '#1d4ed8',
                    display: 'block',
                    overflow: 'hidden',
                    textDecoration: 'underline',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.hostname}
                </a>
              ))}
            </div>
          ) : (
            <div style={{ color: '#4b5563' }}>No websites identified.</div>
          )}
        </div>
      </Html>

      {building.flagImageUrl && (
        <Html position={[0, flagY, 1.78]} transform sprite distanceFactor={8}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onExit();
            }}
            style={{
              width: '36px',
              height: '24px',
              padding: 0,
              border: '1px solid rgba(255,255,255,0.55)',
              borderRadius: '2px',
              background: 'transparent',
              cursor: 'pointer',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.65))',
            }}
            title="Return to grid view"
          >
            <img
              src={building.flagImageUrl}
              alt={building.countryCodeLabel ?? building.ipAddress}
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
      )}

      <Html position={[0, labelY, 0]} center>
        <div className="bg-white/90 text-black px-2 py-1 rounded text-sm shadow space-y-1">
          <div className="font-semibold">{building.ipAddress}</div>
          {building.asn && (
            <div className="text-xs rounded px-1.5 py-0.5 text-white" style={{ background: building.asnColor ?? '#4b5563' }}>
              {building.asn}{building.asnName ? ` - ${building.asnName}` : ''}{building.route ? ` (${building.route})` : ''}
            </div>
          )}
        </div>
      </Html>
    </>
  );
}



function getCertificateStatusTone(certificateResult: HttpsCertificateResponse): 'ok' | 'warn' | 'error' {
  if (certificateResult.status === 'error') return 'error';
  if (certificateResult.lookupMode === 'hostname_sni' || certificateResult.authorizationError) return 'warn';
  return 'ok';
}

function getExposureSummarySentences(exposure: ExposureRecord | null): string[] {
  if (!exposure) {
    return [];
  }

  const ports = new Set(
    exposure.topPorts
      .map((entry) => {
        const match = entry.match(/^(\d+)/);
        return match ? Number.parseInt(match[1], 10) : null;
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  );

  const sentences: string[] = [];

  if (ports.has(80) && ports.has(443)) {
    sentences.push('This IP appears to expose a public website over both HTTP and HTTPS.');
  } else if (ports.has(443)) {
    sentences.push('This IP appears to expose a secure public web service over HTTPS.');
  } else if (ports.has(80)) {
    sentences.push('This IP appears to expose a public web service over HTTP.');
  }

  if (ports.has(22)) {
    sentences.push('This IP appears to expose SSH for remote shell access.');
  }

  if (ports.has(53)) {
    sentences.push('This IP appears to expose DNS services.');
  }

  if ([25, 465, 587].some((port) => ports.has(port))) {
    sentences.push('This IP appears to expose mail-related services.');
  }

  if (ports.has(3389)) {
    sentences.push('This IP appears to expose Remote Desktop services.');
  }

  const knownPorts = new Set([22, 25, 53, 80, 443, 465, 587, 3389]);
  const additionalPorts = [...ports].filter((port) => !knownPorts.has(port));
  if (additionalPorts.length > 0) {
    sentences.push(`This IP appears to expose additional public-facing services on ports ${additionalPorts.slice(0, 4).join(', ')}.`);
  }

  if (sentences.length === 0) {
    if (exposure.openPortCount > 0 || exposure.serviceCount > 0) {
      sentences.push('This IP appears to expose one or more public-facing services, but none matched the main categories shown here.');
    } else {
      sentences.push('No public-facing services were observed for this IP.');
    }
  }

  return sentences;
}

function extractPortNumbers(exposure: ExposureRecord | null): Set<number> {
  if (!exposure) {
    return new Set();
  }

  return new Set(
    exposure.topPorts
      .map((entry) => {
        const match = entry.match(/^(\d+)/);
        return match ? Number.parseInt(match[1], 10) : null;
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  );
}

function normalizeHostnameCandidate(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/^dns:/i, '');
  if (!normalized || /^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes('.')) {
    return null;
  }
  return normalized;
}

function getWebsiteCandidate(exposure: ExposureRecord | null, certificate: HttpsCertificateResponse | null) {
  const ports = extractPortNumbers(exposure);
  const hasHttp = ports.has(80);
  const hasHttps = ports.has(443);

  if (!hasHttp && !hasHttps) {
    return null;
  }

  const candidates = [
    ...(exposure?.hostnames ?? []),
    ...(certificate?.subjectAltNames ?? []),
    certificate?.subjectCn ?? '',
    certificate?.host ?? '',
  ]
    .map((value) => normalizeHostnameCandidate(value))
    .filter((value): value is string => Boolean(value));

  const hostname = candidates.find((value) => !value.startsWith('*.'));
  if (!hostname) {
    return null;
  }

  return {
    hostname,
    hasHttp,
    hasHttps,
    primaryUrl: `${hasHttps ? 'https' : 'http'}://${hostname}`,
    secondaryUrl: hasHttp && hasHttps ? `http://${hostname}` : null,
  };
}

function getBuildingDirectoryEntries(exposure: ExposureRecord | null, certificate: HttpsCertificateResponse | null): DirectoryEntry[] {
  const ports = extractPortNumbers(exposure);
  const hasHttp = ports.has(80);
  const hasHttps = ports.has(443) || certificate?.status === 'ready';
  const protocol = hasHttps ? 'https' : hasHttp ? 'http' : 'https';
  const candidates = [
    ...(exposure?.hostnames ?? []),
    ...(certificate?.subjectAltNames ?? []),
    certificate?.subjectCn ?? '',
    certificate?.host ?? '',
  ];
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeHostnameCandidate(candidate);
    if (!normalized || normalized.startsWith('*.') || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    entries.push({
      hostname: normalized,
      url: `${protocol}://${normalized}`,
    });

    if (entries.length >= 8) {
      break;
    }
  }

  return entries;
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function getHeightFromServiceCount(cubeSize: number, serviceCount: number): number {
  const normalized = Math.log10(serviceCount + 1);
  return cubeSize * (0.72 + normalized * 1.95);
}

function parseTopPortNumber(portLabel: string): number | null {
  const match = portLabel.match(/^(\d+)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStreetBuildingFamily(exposureRecord: ExposureRecord | null): 'block' | 'tower' | 'stepped' | 'fort' {
  const visiblePorts: number[] = [...new Set<number>((exposureRecord?.topPorts ?? [])
    .map((portLabel) => parseTopPortNumber(portLabel))
    .filter((port): port is number => typeof port === 'number'))];
  const hasHttp = visiblePorts.includes(80);
  const hasHttps = visiblePorts.includes(443);
  const hasSsh = visiblePorts.includes(22);
  const hasDns = visiblePorts.includes(53);
  const hasMail = visiblePorts.some((port) => [25, 465, 587].includes(port));
  const hasRdp = visiblePorts.includes(3389);
  const extraPorts = visiblePorts.filter((port) => ![80, 443, 22, 53, 25, 465, 587, 3389].includes(port)).slice(0, 4);
  const openPortCount = exposureRecord?.openPortCount ?? 0;

  return hasRdp || extraPorts.length >= 2 || openPortCount >= 4
    ? 'fort'
    : hasDns || hasMail || hasHttps || openPortCount >= 3
      ? 'stepped'
      : hasHttp || hasSsh || openPortCount >= 2 || visiblePorts.length >= 1
        ? 'tower'
        : 'block';
}

function buildStreetBuildings(
  gridSystemMode: GridSystemMode,
  zoomLevel: number,
  currentPosition: GridPosition,
  grid2Position: Grid2Position,
  orientation: StreetOrientation,
  streetIndex: number,
  exposureByIp: Record<string, ExposureRecord>,
  getIPColor: (first: number, second: number, third: number, fourth: number) => string,
): StreetBuilding[] {
  const cubeSize = 0.92;
  const items: StreetBuilding[] = [];

  for (let i = 0; i < 16; i += 1) {
    const leftX = orientation === 'row' ? i : streetIndex;
    const leftY = orientation === 'row' ? streetIndex : i;
    const rightX = orientation === 'row' ? i : Math.min(streetIndex + 1, 15);
    const rightY = orientation === 'row' ? Math.min(streetIndex + 1, 15) : i;

    const leftIp = getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, leftX, leftY);
    const rightIp = getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, rightX, rightY);

    const makeBuilding = (ipAddress: string, x: number, y: number, streetSide: 'left' | 'right') => {
      const exposureRecord = exposureByIp[ipAddress] ?? null;
      const serviceCount = exposureRecord?.serviceCount ?? 0;
      const buildingHeight = getHeightFromServiceCount(cubeSize, serviceCount);
      const [firstOctetValue, secondOctetValue, thirdOctetValue, fourthOctetValue] = parseIpOctets(ipAddress);
      const label = gridSystemMode === 'grid2' ? thirdOctetValue * 256 + fourthOctetValue : y * 16 + x;

      return {
        ipAddress,
        label,
        color: getIPColor(firstOctetValue, secondOctetValue, thirdOctetValue, fourthOctetValue),
        buildingFamily: getStreetBuildingFamily(exposureRecord),
        buildingHeight,
        streetSide,
        streetPosition: i,
      };
    };

    items.push(makeBuilding(leftIp, leftX, leftY, 'left'));
    if (rightIp !== leftIp || orientation === 'column' || streetIndex < 15) {
      items.push(makeBuilding(rightIp, rightX, rightY, 'right'));
    }
  }

  return items;
}

function StreetCamera({
  streetStep,
  lateralOffset,
  heading,
}: {
  streetStep: number;
  lateralOffset: number;
  heading: number;
}) {
  const { camera } = useThree();

  useEffect(() => {
    const z = streetStep * 7.5 - 56;
    const x = lateralOffset;
    const lookX = x + Math.sin(heading) * 10;
    const lookZ = z + Math.cos(heading) * 10;
    camera.position.set(x, 2.1, z);
    camera.lookAt(lookX, 2.1, lookZ);
    camera.updateProjectionMatrix();
  }, [camera, streetStep, lateralOffset, heading]);

  return null;
}

function StreetScene({
  streetBuildings,
  streetStep,
  lateralOffset,
  heading,
  onOpenBuilding,
}: {
  streetBuildings: StreetBuilding[];
  streetStep: number;
  lateralOffset: number;
  heading: number;
  onOpenBuilding: (building: BuildingViewState) => void;
}) {
  const roadLength = 128;
  const leftX = -5.2;
  const rightX = 5.2;
  const spacing = 7.5;

  const buildingMesh = (building: StreetBuilding) => {
    const x = building.streetSide === 'left' ? leftX : rightX;
    const z = building.streetPosition * spacing - 56;
    const faceDirection = building.streetSide === 'left' ? 1 : -1;
    const width = building.buildingFamily === 'tower' ? 3.1 : building.buildingFamily === 'fort' ? 3.8 : 3.5;
    const depth = building.buildingFamily === 'tower' ? 2.3 : 2.8;
    const height = Math.max(2.6, Math.min(8.5, building.buildingHeight * 2.1));
    const trimColor = '#4b5563';
    const roofColor = '#374151';

    return (
      <group key={`${building.streetSide}-${building.streetPosition}-${building.ipAddress}`} position={[x, 0, z]}>
        <mesh position={[0, 0.03, 0]} receiveShadow>
          <boxGeometry args={[4.2, 0.06, 5.6]} />
          <meshStandardMaterial color="#9a9a9a" />
        </mesh>

        {building.buildingFamily === 'block' && (
          <>
            <mesh position={[0, height / 2, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width, height, depth]} />
              <meshStandardMaterial color={building.color} />
            </mesh>
            <mesh position={[0, height + 0.04, 0]} castShadow>
              <boxGeometry args={[width * 0.92, 0.08, depth * 0.92]} />
              <meshStandardMaterial color={roofColor} />
            </mesh>
          </>
        )}

        {building.buildingFamily === 'tower' && (
          <>
            <mesh position={[0, 0.5, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width * 1.1, 1.0, depth * 1.1]} />
              <meshStandardMaterial color={trimColor} />
            </mesh>
            <mesh position={[0, (height - 1.0) / 2 + 1.0, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width * 0.72, Math.max(1.8, height - 1.0), depth * 0.72]} />
              <meshStandardMaterial color={building.color} />
            </mesh>
          </>
        )}

        {building.buildingFamily === 'stepped' && (
          <>
            <mesh position={[0, height * 0.22, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width, height * 0.44, depth]} />
              <meshStandardMaterial color={trimColor} />
            </mesh>
            <mesh position={[0, height * 0.55, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width * 0.72, height * 0.24, depth * 0.72]} />
              <meshStandardMaterial color={building.color} />
            </mesh>
            <mesh position={[0, height * 0.78, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width * 0.42, height * 0.18, depth * 0.42]} />
              <meshStandardMaterial color={building.color} />
            </mesh>
          </>
        )}

        {building.buildingFamily === 'fort' && (
          <>
            <mesh position={[0, height * 0.18, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width, height * 0.36, depth]} />
              <meshStandardMaterial color={trimColor} />
            </mesh>
            <mesh position={[0, height * 0.56, 0]} castShadow receiveShadow onClick={() => onOpenBuilding(building)}>
              <boxGeometry args={[width * 0.42, height * 0.42, depth * 0.42]} />
              <meshStandardMaterial color={building.color} />
            </mesh>
          </>
        )}

        <mesh position={[0, 0.48, faceDirection * (depth / 2 + 0.03)]}>
          <boxGeometry args={[0.8, 0.96, 0.08]} />
          <meshStandardMaterial color="#374151" />
        </mesh>

        <Html position={[0, 1.6, faceDirection * (depth / 2 + 0.12)]} transform sprite distanceFactor={10}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onOpenBuilding(building);
            }}
            className="bg-white/90 text-black px-2 py-1 rounded text-xs shadow border border-gray-300"
            title={building.ipAddress}
          >
            {building.ipAddress}
          </button>
        </Html>
      </group>
    );
  };

  return (
    <>
      <StreetCamera streetStep={streetStep} lateralOffset={lateralOffset} heading={heading} />
      <fog attach="fog" args={['#bcdffb', 18, 160]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 16, 8]} intensity={1.0} castShadow />
      <pointLight position={[0, 8, 20]} intensity={0.6} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[48, roadLength]} />
        <meshStandardMaterial color="#eaf6ff" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[8, roadLength]} />
        <meshStandardMaterial color="#3a3a3a" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <planeGeometry args={[0.25, roadLength]} />
        <meshStandardMaterial color="#d9d2a6" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-3.2, 0.01, 0]} receiveShadow>
        <planeGeometry args={[2.4, roadLength]} />
        <meshStandardMaterial color="#9a9a9a" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[3.2, 0.01, 0]} receiveShadow>
        <planeGeometry args={[2.4, roadLength]} />
        <meshStandardMaterial color="#9a9a9a" />
      </mesh>
      {streetBuildings.map(buildingMesh)}
    </>
  );
}


function App() {
  const [zoomLevel, setZoomLevel] = useState<number>(0);
  const [currentPosition, setCurrentPosition] = useState<GridPosition>({
    firstOctet: 0,
    secondOctet: 0,
    thirdOctet: 0,
    fourthOctet: 0,
  });
  const [showHeightLegend, setShowHeightLegend] = useState<boolean>(false);
  const [lookupMode, setLookupMode] = useState<LookupMode>('rdap');
  const [infoDisplayMode, setInfoDisplayMode] = useState<InfoDisplayMode>('structured');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('grid');
  const [gridSystemMode, setGridSystemMode] = useState<GridSystemMode>('grid1');
  const [grid2Position, setGrid2Position] = useState<Grid2Position>(DEFAULT_GRID2_POSITION);
  const [streetOrientation, setStreetOrientation] = useState<StreetOrientation>('row');
  const [streetIndex, setStreetIndex] = useState<number>(0);
  const [streetStep, setStreetStep] = useState<number>(7);
  const [streetLateralOffset, setStreetLateralOffset] = useState<number>(0);
  const [streetHeading, setStreetHeading] = useState<number>(0);
  const [streetExposureByIp, setStreetExposureByIp] = useState<Record<string, ExposureRecord>>({});
  const [streetExposureLoading, setStreetExposureLoading] = useState<boolean>(false);
  const [selectedTargetIp, setSelectedTargetIp] = useState<string>('8.8.8.8');
  const [playerLocation, setPlayerLocation] = useState<PlayerLocation>({
    kind: 'ip',
    ipAddress: '8.8.8.8',
    x: 0,
    y: 0,
  });
  const [viewResetKey, setViewResetKey] = useState(0);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);

  const controlsRef = useRef<any>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [bottomInfoHtml, setBottomInfoHtml] = useState<string>('');
  const [buildingView, setBuildingView] = useState<BuildingViewState | null>(null);
  const [certificateResult, setCertificateResult] = useState<HttpsCertificateResponse | null>(null);
  const [certificateLoadingIp, setCertificateLoadingIp] = useState<string | null>(null);
  const [exposureResult, setExposureResult] = useState<ExposureRecord | null>(null);
  const [exposureLoadingIp, setExposureLoadingIp] = useState<string | null>(null);
  const [sshLaunchLoadingIp, setSshLaunchLoadingIp] = useState<string | null>(null);
  const [sshLaunchResult, setSshLaunchResult] = useState<SshLaunchResponse | null>(null);
  const [pointerTarget, setPointerTarget] = useState<MultiplayerCell | undefined>(undefined);
  const [chatDraft, setChatDraft] = useState('');

  const ipColors = {
    reserved: '#2C3E50',
    private: '#3498DB',
    loopback: '#9B59B6',
    multicast: '#E74C3C',
    public: '#6B7280',
  };

  const getIPColor = (first: number, second: number, _third: number, _fourth: number): string => {
    if (first === 127) return ipColors.loopback;
    if (first === 10) return ipColors.private;
    if (first === 172 && second >= 16 && second <= 31) return ipColors.private;
    if (first === 192 && second === 168) return ipColors.private;
    if (first === 0) return ipColors.reserved;
    if (first === 169 && second === 254) return ipColors.reserved;
    if (first >= 224 && first <= 239) return ipColors.multicast;
    if (first >= 240 && first <= 255) return ipColors.reserved;
    return ipColors.public;
  };

  const fallbackTargetIp = useMemo(
    () => getRepresentativeTarget(gridSystemMode, zoomLevel, currentPosition, grid2Position),
    [
      gridSystemMode,
      zoomLevel,
      currentPosition.firstOctet,
      currentPosition.secondOctet,
      currentPosition.thirdOctet,
      grid2Position.outerFirstOctet,
      grid2Position.outerSecondOctet,
      grid2Position.innerThirdStart,
      grid2Position.innerFourthStart,
    ]
  );

  const activeTargetIp = selectedTargetIp || fallbackTargetIp;
  const playerLocationIp = playerLocation.kind === 'ip' ? playerLocation.ipAddress : activeTargetIp;
  const multiplayerRoomKey = useMemo(
    () => getMultiplayerRoomKey(gridSystemMode, zoomLevel, currentPosition, grid2Position),
    [gridSystemMode, zoomLevel, currentPosition, grid2Position]
  );
  const multiplayer = useMultiplayerPresence({
    roomKey: multiplayerRoomKey,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    pointerTarget,
    playerLocation,
    selectedIp: playerLocationIp,
  });
  useEffect(() => {
    setPointerTarget(undefined);
  }, [multiplayerRoomKey]);
  const websiteCandidate = useMemo(
    () => getWebsiteCandidate(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );
  const buildingDirectoryEntries = useMemo(
    () => getBuildingDirectoryEntries(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );
  const streetBuildings = useMemo(
    () => buildStreetBuildings(
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position,
      streetOrientation,
      streetIndex,
      streetExposureByIp,
      getIPColor
    ),
    [
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position,
      streetOrientation,
      streetIndex,
      streetExposureByIp
    ]
  );

  const handleGridClick = (x: number, y: number) => {
    const octetValue = y * 16 + x;
    const clickedIp = getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, x, y);
    setSelectedTargetIp(clickedIp);
    setPlayerLocation({ kind: 'ip', ipAddress: clickedIp, x, y });

    if (gridSystemMode === 'grid2') {
      return;
    }

    if (zoomLevel === 0) {
      setCurrentPosition((prev) => ({ ...prev, firstOctet: octetValue }));
      setZoomLevel(1);
      return;
    }

    if (zoomLevel === 1) {
      setCurrentPosition((prev) => ({ ...prev, secondOctet: octetValue }));
      setZoomLevel(2);
      return;
    }

    if (zoomLevel === 2) {
      setCurrentPosition((prev) => ({ ...prev, thirdOctet: octetValue }));
      setZoomLevel(3);
    }
  };


  const handleBack = () => {
    if (layoutMode === 'street') {
      setLayoutMode('grid');
      return;
    }

    if (gridSystemMode === 'grid2') {
      return;
    }

    if (zoomLevel === 1) {
      setCurrentPosition({ firstOctet: 0, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
      setZoomLevel(0);
      return;
    }

    if (zoomLevel === 2) {
      setCurrentPosition((prev) => ({ ...prev, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(1);
      return;
    }

    if (zoomLevel === 3) {
      setCurrentPosition((prev) => ({ ...prev, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(2);
    }
  };

  const handleReset = () => {
    const nextTargetIp = gridSystemMode === 'grid2' ? getGrid2IpFromCell(DEFAULT_GRID2_POSITION, 0, 0) : '8.8.8.8';
    setLayoutMode('grid');
    setBuildingView(null);
    setZoomLevel(0);
    setCurrentPosition({ firstOctet: 0, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
    setGrid2Position(DEFAULT_GRID2_POSITION);
    setSelectedTargetIp(nextTargetIp);
    setPlayerLocation({ kind: 'ip', ipAddress: nextTargetIp, x: 0, y: 0 });
    setStreetIndex(0);
    setStreetOrientation('row');
    setStreetStep(7);
    setStreetLateralOffset(0);
    setStreetHeading(0);
  };

  const handleResetView = () => {
    const defaultCameraPosition = new THREE.Vector3(0, 16, 22);

    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.copy(defaultCameraPosition);
      cameraRef.current.lookAt(0, 0, 0);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
      return;
    }

    setViewResetKey((prev) => prev + 1);
  };

  const handleGridSystemChange = (mode: GridSystemMode) => {
    const nextTargetIp = mode === 'grid2' ? getGrid2IpFromCell(grid2Position, 0, 0) : getRepresentativeTarget('grid1', zoomLevel, currentPosition, grid2Position);
    setGridSystemMode(mode);
    setLayoutMode('grid');
    setBuildingView(null);
    setBottomInfoHtml('');
    setSelectedTargetIp(nextTargetIp);
    setPlayerLocation({ kind: 'ip', ipAddress: nextTargetIp, x: 0, y: 0 });
  };

  const moveGrid2Window = (thirdDelta: number, fourthDelta: number) => {
    setGrid2Position((prev) => {
      const next = {
        ...prev,
        innerThirdStart: clampGrid2WindowStart(prev.innerThirdStart + thirdDelta),
        innerFourthStart: clampGrid2WindowStart(prev.innerFourthStart + fourthDelta),
      };
      const nextTargetIp = getGrid2IpFromCell(next, 0, 0);
      setSelectedTargetIp(nextTargetIp);
      setPlayerLocation({ kind: 'ip', ipAddress: nextTargetIp, x: 0, y: 0 });
      return next;
    });
    setBottomInfoHtml('');
  };

  const updateGrid2Octet = (field: keyof Grid2Position, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }

    setGrid2Position((prev) => {
      const next = {
        ...prev,
        [field]: field === 'innerThirdStart' || field === 'innerFourthStart'
          ? clampGrid2WindowStart(parsed)
          : clampOctet(parsed),
      };
      const nextTargetIp = getGrid2IpFromCell(next, 0, 0);
      setSelectedTargetIp(nextTargetIp);
      setPlayerLocation({ kind: 'ip', ipAddress: nextTargetIp, x: 0, y: 0 });
      return next;
    });
    setBottomInfoHtml('');
  };


  useEffect(() => {
    if (layoutMode !== 'street') {
      return;
    }

    const ips = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      if (streetOrientation === 'row') {
        ips.add(getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, i, streetIndex));
        ips.add(getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, i, Math.min(streetIndex + 1, 15)));
      } else {
        ips.add(getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, streetIndex, i));
        ips.add(getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, Math.min(streetIndex + 1, 15), i));
      }
    }

    const ipAddresses = [...ips];
    setStreetExposureLoading(true);

    void (async () => {
      try {
        const response = await fetch('/api/exposure', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ ipAddresses }),
        });
        const json = (await response.json()) as { records?: ExposureRecord[] };

        const next: Record<string, ExposureRecord> = {};
        for (const ipAddress of ipAddresses) {
          next[ipAddress] = {
            ipAddress,
            sourceProvider: 'internetdb',
            serviceCount: 0,
            openPortCount: 0,
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
          };
        }
        if (response.ok && Array.isArray(json.records)) {
          for (const record of json.records) {
            next[record.ipAddress] = record;
          }
        }
        setStreetExposureByIp(next);
      } catch {
        const next: Record<string, ExposureRecord> = {};
        for (const ipAddress of ipAddresses) {
          next[ipAddress] = {
            ipAddress,
            sourceProvider: 'internetdb',
            serviceCount: 0,
            openPortCount: 0,
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
          };
        }
        setStreetExposureByIp(next);
      } finally {
        setStreetExposureLoading(false);
      }
    })();
  }, [
    layoutMode,
    streetOrientation,
    streetIndex,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
  ]);

  useEffect(() => {
    if (layoutMode !== 'street' || buildingView) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'w' || event.key === 'ArrowUp') {
        setStreetStep((prev) => Math.min(15, prev + 1));
      } else if (event.key === 's' || event.key === 'ArrowDown') {
        setStreetStep((prev) => Math.max(0, prev - 1));
      } else if (event.key === 'a') {
        setStreetLateralOffset((prev) => Math.max(-1.8, prev - 0.5));
      } else if (event.key === 'd') {
        setStreetLateralOffset((prev) => Math.min(1.8, prev + 0.5));
      } else if (event.key === 'ArrowLeft') {
        setStreetHeading((prev) => prev + 0.12);
      } else if (event.key === 'ArrowRight') {
        setStreetHeading((prev) => prev - 0.12);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layoutMode, buildingView]);



  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) {
      return;
    }

    const syncInfoPanel = () => {
      const tooltipCandidates = Array.from(
        container.querySelectorAll('div[data-info-panel="true"]')
      ) as HTMLDivElement[];

      let activeHtml = '';

      tooltipCandidates.forEach((candidate) => {
        const hasBoldHeader = candidate.querySelector('.font-bold');
        const text = candidate.textContent?.trim() ?? '';

        if (hasBoldHeader && text.length > 0) {
          activeHtml = candidate.innerHTML;
          candidate.style.display = 'none';
        }
      });

      if (activeHtml) {
        setBottomInfoHtml(activeHtml);
      }
    };

    syncInfoPanel();

    const observer = new MutationObserver(() => {
      syncInfoPanel();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [
    layoutMode,
    lookupMode,
    gridSystemMode,
    zoomLevel,
    currentPosition.firstOctet,
    currentPosition.secondOctet,
    currentPosition.thirdOctet,
    grid2Position.outerFirstOctet,
    grid2Position.outerSecondOctet,
    grid2Position.innerThirdStart,
    grid2Position.innerFourthStart,
  ]);


  const handleFlagClick = (building: BuildingViewState) => {
    setBuildingView(building);
    setSelectedTargetIp(building.ipAddress);
    setPlayerLocation({ kind: 'ip', ipAddress: building.ipAddress });
    setCertificateLoadingIp(building.ipAddress);
    setExposureLoadingIp(building.ipAddress);
    setCertificateResult(null);
    setExposureResult(null);
    setSshLaunchLoadingIp(null);
    setSshLaunchResult(null);

    void (async () => {
      try {
        const response = await fetch(`/api/https-certificate?ip=${encodeURIComponent(building.ipAddress)}`);
        const json = (await response.json()) as HttpsCertificateResponse & { details?: string };

        if (!response.ok) {
          setCertificateResult({
            provider: 'https_certificate',
            ipAddress: building.ipAddress,
            status: 'error',
            host: building.ipAddress,
            port: 443,
            subjectAltNames: [],
            error: json.error ?? json.details ?? `HTTPS certificate lookup failed with status ${response.status}`,
          });
          return;
        }

        setCertificateResult(json);
      } catch (error) {
        setCertificateResult({
          provider: 'https_certificate',
          ipAddress: building.ipAddress,
          status: 'error',
          host: building.ipAddress,
          port: 443,
          subjectAltNames: [],
          error: error instanceof Error ? error.message : 'Unknown HTTPS certificate lookup error',
        });
      } finally {
        setCertificateLoadingIp(null);
      }
    })();


    void (async () => {
      try {
        const response = await fetch('/api/exposure', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ ipAddresses: [building.ipAddress] }),
        });
        const json = (await response.json()) as { records?: ExposureRecord[]; error?: string; details?: string };

        if (!response.ok) {
          setExposureResult({
            ipAddress: building.ipAddress,
            sourceProvider: 'internetdb',
            serviceCount: 0,
            openPortCount: 0,
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
            error: json.error ?? json.details ?? `Exposure lookup failed with status ${response.status}`,
          });
          return;
        }

        const record = Array.isArray(json.records) ? json.records[0] : null;
        setExposureResult(record ?? {
          ipAddress: building.ipAddress,
          sourceProvider: 'internetdb',
          serviceCount: 0,
          openPortCount: 0,
          topPorts: [],
          serviceNames: [],
          labels: [],
          hostnames: [],
        });
      } catch (error) {
        setExposureResult({
          ipAddress: building.ipAddress,
          sourceProvider: 'internetdb',
          serviceCount: 0,
          openPortCount: 0,
          topPorts: [],
          serviceNames: [],
          labels: [],
          hostnames: [],
          error: error instanceof Error ? error.message : 'Unknown exposure lookup error',
        });
      } finally {
        setExposureLoadingIp(null);
      }
    })();
  };

  const handleExitBuildingView = () => {
    setBuildingView(null);
    setCertificateLoadingIp(null);
    setExposureLoadingIp(null);
    setSshLaunchLoadingIp(null);
    setSshLaunchResult(null);
  };

  const handleLaunchSsh = async () => {
    if (!buildingView) {
      return;
    }

    setSshLaunchLoadingIp(buildingView.ipAddress);
    setSshLaunchResult(null);

    try {
      const response = await fetch(`/api/launch-ssh?ip=${encodeURIComponent(buildingView.ipAddress)}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
        },
      });
      const json = (await response.json()) as SshLaunchResponse & { details?: string };

      if (!response.ok) {
        setSshLaunchResult({
          provider: 'ssh_launch',
          status: 'error',
          ipAddress: buildingView.ipAddress,
          error: json.error ?? json.details ?? `SSH launch failed with status ${response.status}`,
          statusSummary: json.statusSummary ?? 'Unable to open the local SSH client.',
        });
        return;
      }

      setSshLaunchResult(json);
    } catch (error) {
      setSshLaunchResult({
        provider: 'ssh_launch',
        status: 'error',
        ipAddress: buildingView.ipAddress,
        error: error instanceof Error ? error.message : 'Unknown SSH launch error',
        statusSummary: 'Unable to open the local SSH client.',
      });
    } finally {
      setSshLaunchLoadingIp(null);
    }
  };

  const handleEnterStreetView = () => {
    setLayoutMode('street');
    setStreetStep(7);
    setStreetLateralOffset(0);
    setStreetHeading(0);
  };

  const handleOpenBuildingFromStreet = (building: StreetBuilding) => {
    handleFlagClick({
      ipAddress: building.ipAddress,
      label: building.label,
      color: building.color,
      buildingFamily: building.buildingFamily,
      buildingHeight: building.buildingHeight,
    });
  };



  const getCurrentRangeLabel = (): string => {
    if (gridSystemMode === 'grid2') {
      const thirdEnd = grid2Position.innerThirdStart + GRID2_WINDOW_SIZE - 1;
      const fourthEnd = grid2Position.innerFourthStart + GRID2_WINDOW_SIZE - 1;
      return `Grid 2: outer point ${grid2Position.outerFirstOctet}.${grid2Position.outerSecondOctet}; inner neighborhood n3=${grid2Position.innerThirdStart}-${thirdEnd}, n4=${grid2Position.innerFourthStart}-${fourthEnd}`;
    }

    if (zoomLevel === 0) return 'Grid 1: Top-level View';
    if (zoomLevel === 1) return `Grid 1: ${currentPosition.firstOctet}.x.x.x`;
    if (zoomLevel === 2) return `Grid 1: ${currentPosition.firstOctet}.${currentPosition.secondOctet}.x.x`;
    return `Grid 1: ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.x`;
  };

  const getInstructionText = (): string => {
    if (layoutMode === 'street') {
      return `Street level view of the current ${streetOrientation} street ${streetIndex + 1}. Use W/S or arrow keys to move, A/D to sidestep, and left/right arrows to turn.`;
    }

    if (gridSystemMode === 'grid2') {
      return 'Grid 2 maps n1.n2.n3.n4 as inner point n3,n4 inside outer point n1,n2. Only the local 16 by 16 neighborhood is rendered; use the Grid 2 controls or mouse wheel to move through the larger 256 by 256 inner grid. Single-click a building or square for building view; double-click to select that exact IP.';
    }

    if (zoomLevel === 0) {
      return lookupMode === 'rdap'
        ? 'Single-click a building or square for building view; double-click to zoom into a first-octet block. Heights use public service exposure data. Hover for live ownership and registration data.'
        : 'Single-click a building or square for building view; double-click to zoom into a first-octet block. Heights use public service exposure data. Hover for hostname data from reverse DNS, with scan-data fallback when PTR is absent.';
    }

    if (zoomLevel === 1) {
      return `Viewing the 256 second-octet values under ${currentPosition.firstOctet}.0.0.0/8. Heights use public service exposure for each representative IP.`;
    }

    if (zoomLevel === 2) {
      return `Viewing the 256 third-octet values under ${currentPosition.firstOctet}.${currentPosition.secondOctet}.0.0/16. Heights use public service exposure for each representative IP.`;
    }

    return lookupMode === 'rdap'
      ? `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Single-click a building or square for building view. Hover a building to fetch live RDAP ownership and registration data.`
      : `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Single-click a building or square for building view. Hover a building to fetch hostname data.`;
  };

  const isBackDisabled = layoutMode !== 'street' && (gridSystemMode === 'grid2' || zoomLevel === 0);
  const multiplayerStatusLabel = multiplayer.isConfigured
    ? multiplayer.status.charAt(0).toUpperCase() + multiplayer.status.slice(1)
    : 'Offline';
  const userLocationLabel = playerLocation.kind === 'ip'
    ? playerLocation.ipAddress
    : `intersection ${playerLocation.ipAddresses.join(' / ')}`;
  const handlePointerTargetChange = (cell: MultiplayerCell) => {
    setPointerTarget(cell);
  };
  const handleSendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    multiplayer.sendMessage(chatDraft);
    setChatDraft('');
  };

  return (
    <div className="h-screen overflow-hidden bg-white text-black flex flex-col">
      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3">
        <header className="shrink-0 bg-white text-black p-3 rounded-lg">
          <div className="flex flex-col gap-3 lg:flex-row lg:justify-between lg:items-start">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Burning Chrome</h1>
            </div>

            <div className="flex flex-col items-start lg:items-end gap-3">
              <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
                <div
                  className="max-w-[min(22rem,calc(100vw-12rem))] truncate self-center text-xs font-medium text-gray-700"
                  title={`Location: ${userLocationLabel}`}
                >
                  Location: {userLocationLabel}
                </div>
                <div
                  className="relative"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setIsOptionsOpen(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setIsOptionsOpen((open) => !open)}
                    className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                    aria-expanded={isOptionsOpen}
                    aria-haspopup="menu"
                  >
                    Options
                  </button>
                  {isOptionsOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-lg border border-gray-300 bg-white py-1 text-sm text-gray-900 shadow-xl" role="menu">
                      <button
                        type="button"
                        onClick={() => {
                          handleBack();
                          setIsOptionsOpen(false);
                        }}
                        disabled={isBackDisabled}
                        className={`block w-full px-3 py-2 text-left ${isBackDisabled ? 'cursor-not-allowed text-gray-400' : 'hover:bg-gray-100 active:bg-gray-200'}`}
                        role="menuitem"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleReset();
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleResetView();
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        Reset camera
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleGridSystemChange('grid1');
                          setIsOptionsOpen(false);
                        }}
                        className={`block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200 ${gridSystemMode === 'grid1' ? 'font-semibold' : ''}`}
                        role="menuitem"
                      >
                        Grid 1
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleGridSystemChange('grid2');
                          setIsOptionsOpen(false);
                        }}
                        className={`block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200 ${gridSystemMode === 'grid2' ? 'font-semibold' : ''}`}
                        role="menuitem"
                      >
                        Grid 2
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleEnterStreetView();
                          setIsOptionsOpen(false);
                        }}
                        className={`block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200 ${layoutMode === 'street' ? 'font-semibold' : ''}`}
                        role="menuitem"
                      >
                        Street level
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setInfoDisplayMode((prev) => (prev === 'structured' ? 'prose' : 'structured'));
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        {infoDisplayMode === 'prose' ? 'Prose Mode' : 'Data Mode'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative group">
                  <button
                    type="button"
                    className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                  >
                    More Info
                  </button>
                  <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-gray-300 bg-white p-4 text-sm leading-relaxed text-gray-800 shadow-xl group-hover:block group-hover:pointer-events-auto group-focus-within:block group-focus-within:pointer-events-auto">
                    <p className="font-medium text-gray-950">3D IPv4 city grid with public-exposure-based heights and live RDAP/hostname lookups</p>
                    <p className="mt-2 italic">{getCurrentRangeLabel()}</p>
                    <p className="mt-2">{getInstructionText()}</p>
                    <p className="mt-3 text-xs text-gray-700">Current height source: Shodan InternetDB</p>
                    <p className="mt-1 text-xs text-gray-700">Selected routing target: {activeTargetIp}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        {layoutMode === 'grid' && gridSystemMode === 'grid2' && !buildingView && (
          <div className="shrink-0 bg-white text-black border border-gray-300 rounded-lg shadow-lg p-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="text-sm">
                <span className="block font-medium mb-1">Outer n1</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={grid2Position.outerFirstOctet}
                  onChange={(event) => updateGrid2Octet('outerFirstOctet', event.target.value)}
                  className="w-20 rounded border border-gray-400 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="block font-medium mb-1">Outer n2</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={grid2Position.outerSecondOctet}
                  onChange={(event) => updateGrid2Octet('outerSecondOctet', event.target.value)}
                  className="w-20 rounded border border-gray-400 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="block font-medium mb-1">Start n3</span>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={grid2Position.innerThirdStart}
                  onChange={(event) => updateGrid2Octet('innerThirdStart', event.target.value)}
                  className="w-20 rounded border border-gray-400 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="block font-medium mb-1">Start n4</span>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={grid2Position.innerFourthStart}
                  onChange={(event) => updateGrid2Octet('innerFourthStart', event.target.value)}
                  className="w-20 rounded border border-gray-400 px-2 py-1 text-sm"
                />
              </label>
              <div className="text-xs text-gray-700 pb-1">
                Current visible range: {getGrid2IpFromCell(grid2Position, 0, 0)} through {getGrid2IpFromCell(grid2Position, 15, 15)}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-sm font-medium">Move neighborhood:</span>
              <button onClick={() => moveGrid2Window(-16, 0)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n3 ?16</button>
              <button onClick={() => moveGrid2Window(16, 0)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n3 +16</button>
              <button onClick={() => moveGrid2Window(0, -16)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n4 ?16</button>
              <button onClick={() => moveGrid2Window(0, 16)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n4 +16</button>
              <button onClick={() => moveGrid2Window(-1, 0)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n3 ?1</button>
              <button onClick={() => moveGrid2Window(1, 0)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n3 +1</button>
              <button onClick={() => moveGrid2Window(0, -1)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n4 ?1</button>
              <button onClick={() => moveGrid2Window(0, 1)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">n4 +1</button>
            </div>

            <p className="text-xs text-gray-700">
              Mouse wheel moves n3 by four cells; Shift + mouse wheel moves n4 by four cells.
            </p>
          </div>
        )}

        {layoutMode === 'street' && !buildingView && (
          <div className="shrink-0 bg-white text-black border border-gray-300 rounded-lg shadow-lg p-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-sm font-medium">Street type:</span>
              <button
                onClick={() => setStreetOrientation('row')}
                className={`px-3 py-1.5 rounded-md text-sm border ${streetOrientation === 'row' ? 'bg-gray-400 text-black border-gray-500' : 'bg-gray-200 text-gray-900 border-gray-400'}`}
              >
                Row street
              </button>
              <button
                onClick={() => setStreetOrientation('column')}
                className={`px-3 py-1.5 rounded-md text-sm border ${streetOrientation === 'column' ? 'bg-gray-400 text-black border-gray-500' : 'bg-gray-200 text-gray-900 border-gray-400'}`}
              >
                Column street
              </button>

              <span className="text-sm font-medium ml-2">Index:</span>
              <button onClick={() => setStreetIndex((prev) => Math.max(0, prev - 1))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Previous</button>
              <span className="text-sm">{streetIndex + 1} / 16</span>
              <button onClick={() => setStreetIndex((prev) => Math.min(15, prev + 1))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Next</button>
              {streetExposureLoading && <span className="text-sm text-blue-700">Loading street data.</span>}
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <button onClick={() => setStreetStep((prev) => Math.min(15, prev + 1))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Forward</button>
              <button onClick={() => setStreetStep((prev) => Math.max(0, prev - 1))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Back</button>
              <button onClick={() => setStreetLateralOffset((prev) => Math.max(-1.8, prev - 0.5))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Step left</button>
              <button onClick={() => setStreetLateralOffset((prev) => Math.min(1.8, prev + 0.5))} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Step right</button>
              <button onClick={() => setStreetHeading((prev) => prev + 0.12)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Turn left</button>
              <button onClick={() => setStreetHeading((prev) => prev - 0.12)} className="px-3 py-1.5 rounded-md text-sm bg-gray-200 border border-gray-400">Turn right</button>
            </div>
          </div>
        )}

        {buildingView ? (
          <div className="flex-1 min-h-0 flex flex-col gap-3 lg:flex-row">
            <div className="relative flex-1 min-h-[260px] lg:flex-[1.35] rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]">
              <Canvas
                key={`building-${buildingView.ipAddress}`}
                camera={{ position: [0, 3.6, 8.5], fov: 42 }}
                shadows
              >
                <BuildingDetailScene
                  building={buildingView}
                  directoryEntries={buildingDirectoryEntries}
                  onExit={handleExitBuildingView}
                />
                <OrbitControls
                  enablePan={false}
                  enableZoom
                  enableRotate
                  minDistance={5.5}
                  maxDistance={12}
                  minPolarAngle={Math.PI / 4}
                  maxPolarAngle={Math.PI / 2.1}
                  target={[0, 1.9, 0]}
                />
              </Canvas>
            </div>

            <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
              <div className="font-bold text-lg">Building view: {buildingView.ipAddress}</div>
              <div className="text-sm text-gray-600 mt-1">
                Use Return to grid to leave building view.
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleExitBuildingView}
                    className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                  >
                    Return to grid
                  </button>

                  <button
                    onClick={handleLaunchSsh}
                    disabled={sshLaunchLoadingIp === buildingView.ipAddress}
                    className={`px-3 py-2 rounded-md text-sm font-medium ${sshLaunchLoadingIp === buildingView.ipAddress ? 'bg-gray-300 text-gray-500 border border-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400'}`}
                    title="Open the local SSH client"
                  >
                    {sshLaunchLoadingIp === buildingView.ipAddress ? 'Opening SSH.' : 'Open SSH client'}
                  </button>

                  {websiteCandidate && (
                    <a
                      href={websiteCandidate.primaryUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                      title={`Open ${websiteCandidate.hostname}`}
                    >
                      Open website
                    </a>
                  )}
                </div>

                {websiteCandidate && (
                  <div className="text-sm text-gray-700">
                    Website candidate: {websiteCandidate.hostname}
                    {websiteCandidate.secondaryUrl ? (
                      <div className="text-xs text-gray-600 mt-1">
                        Tries HTTPS first. HTTP may also be available at {websiteCandidate.secondaryUrl}
                      </div>
                    ) : null}
                  </div>
                )}

                {sshLaunchResult && sshLaunchResult.ipAddress === buildingView.ipAddress && (
                  <div className={`text-sm ${sshLaunchResult.status === 'ready' ? 'text-green-700' : 'text-red-700'}`}>
                    {sshLaunchResult.statusSummary ?? sshLaunchResult.error}
                    {sshLaunchResult.command ? (
                      <div className="text-xs text-gray-600 mt-1 break-all">Command: {sshLaunchResult.command}</div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="mt-4 space-y-5">
                <div>
                  <div className="font-semibold">Public-facing services</div>
                  {exposureLoadingIp ? (
                    <div className="text-sm text-blue-700 mt-1">Looking up exposure data for {exposureLoadingIp}...</div>
                  ) : exposureResult ? (
                    <div className="space-y-3 mt-2">
                      <div className="space-y-2">
                        {getExposureSummarySentences(exposureResult).map((sentence) => (
                          <div key={sentence} className="text-sm text-gray-700">
                            {sentence}
                          </div>
                        ))}
                      </div>

                      <div className="text-xs bg-gray-100 rounded p-3 space-y-1">
                        <div><span className="text-gray-600">Observed service count:</span> {exposureResult.serviceCount}</div>
                        <div><span className="text-gray-600">Observed open ports:</span> {exposureResult.openPortCount}</div>
                        {exposureResult.topPorts.length > 0 && (
                          <div><span className="text-gray-600">Top ports:</span> {exposureResult.topPorts.join(', ')}</div>
                        )}
                        {exposureResult.hostnames.length > 0 && (
                          <div className="break-all"><span className="text-gray-600">Hostnames:</span> {exposureResult.hostnames.join(', ')}</div>
                        )}
                      </div>

                      {exposureResult.error && <div className="text-sm text-red-700">{exposureResult.error}</div>}
                      {exposureResult.warning && <div className="text-sm text-blue-700">{exposureResult.warning}</div>}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600 mt-2">No exposure data available yet.</div>
                  )}
                </div>

                <div>
                  <div className="font-semibold">HTTPS certificate</div>
                  {certificateLoadingIp ? (
                    <div className="text-sm text-blue-700 mt-1">Looking up HTTPS certificate for {certificateLoadingIp}...</div>
                  ) : certificateResult ? (
                    certificateResult.status === 'error' ? (
                      <div className="mt-2 space-y-2">
                        <div className="text-sm text-red-700">
                          {certificateResult.statusSummary ?? certificateResult.error ?? 'No HTTPS certificate data available.'}
                        </div>
                        {certificateResult.attemptedHosts && certificateResult.attemptedHosts.length > 0 && (
                          <div className="text-xs text-gray-600">
                            Attempted: {certificateResult.attemptedHosts.join(', ')}
                          </div>
                        )}
                        {certificateResult.warning && <div className="text-sm text-blue-700">{certificateResult.warning}</div>}
                      </div>
                    ) : (
                      <div className="space-y-3 mt-2">
                        <div className={`text-sm ${
                          getCertificateStatusTone(certificateResult) === 'ok'
                            ? 'text-green-700'
                            : getCertificateStatusTone(certificateResult) === 'warn'
                              ? 'text-amber-700'
                              : 'text-red-700'
                        }`}>
                          {certificateResult.statusSummary ?? 'HTTPS certificate retrieved successfully.'}
                        </div>

                        <div className="text-xs bg-gray-100 rounded p-3 space-y-1">
                          <div><span className="text-gray-600">Connected to:</span> {certificateResult.host}:{certificateResult.port}</div>
                          {certificateResult.lookupMode && (
                            <div><span className="text-gray-600">Lookup method:</span> {certificateResult.lookupMode === 'direct_ip' ? 'Direct IP TLS' : 'Hostname-based SNI retry'}</div>
                          )}
                          {certificateResult.subjectCn && <div><span className="text-gray-600">Subject CN:</span> {certificateResult.subjectCn}</div>}
                          {certificateResult.issuerCn && <div><span className="text-gray-600">Issuer:</span> {certificateResult.issuerCn}</div>}
                          {certificateResult.validFrom && <div><span className="text-gray-600">Valid from:</span> {certificateResult.validFrom}</div>}
                          {certificateResult.validTo && <div><span className="text-gray-600">Valid to:</span> {certificateResult.validTo}</div>}
                          {typeof certificateResult.authorized === 'boolean' && (
                            <div><span className="text-gray-600">Authorized:</span> {certificateResult.authorized ? 'yes' : 'no'}</div>
                          )}
                          {certificateResult.authorizationError && (
                            <div><span className="text-gray-600">Authorization issue:</span> {certificateResult.authorizationError}</div>
                          )}
                          {certificateResult.serialNumber && <div><span className="text-gray-600">Serial:</span> {certificateResult.serialNumber}</div>}
                          {certificateResult.fingerprint256 && <div className="break-all"><span className="text-gray-600">SHA-256:</span> {certificateResult.fingerprint256}</div>}
                        </div>

                        {certificateResult.attemptedHosts && certificateResult.attemptedHosts.length > 0 && (
                          <div className="text-xs text-gray-600">
                            Attempted: {certificateResult.attemptedHosts.join(', ')}
                          </div>
                        )}

                        {certificateResult.subjectAltNames.length > 0 && (
                          <div>
                            <div className="text-sm font-medium text-gray-700 mb-1">Subject alternative names</div>
                            <div className="space-y-1">
                              {certificateResult.subjectAltNames.map((name) => (
                                <div key={name} className="text-xs bg-gray-100 rounded p-2 break-all">
                                  {name}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {certificateResult.warning && <div className="text-sm text-blue-700">{certificateResult.warning}</div>}
                      </div>
                    )
                  ) : (
                    <div className="text-sm text-gray-600 mt-2">No HTTPS certificate data available yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : layoutMode === 'street' ? (
          <div className="flex-1 min-h-0 flex justify-center">
            <div className="relative w-full h-full min-h-[260px] rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]">
              <Canvas camera={{ position: [0, 2.1, -56], fov: 62 }} shadows>
                <StreetScene
                  streetBuildings={streetBuildings}
                  streetStep={streetStep}
                  lateralOffset={streetLateralOffset}
                  heading={streetHeading}
                  onOpenBuilding={handleOpenBuildingFromStreet}
                />
              </Canvas>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex justify-center">
            <div
              ref={gridContainerRef}
              className="relative w-full h-full min-h-[260px] rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]"
              onWheel={(event) => {
                if (gridSystemMode !== 'grid2' || layoutMode !== 'grid') {
                  return;
                }
                event.preventDefault();
                const direction = event.deltaY > 0 ? 4 : -4;
                if (event.shiftKey) {
                  moveGrid2Window(0, direction);
                } else {
                  moveGrid2Window(direction, 0);
                }
              }}
            >
              <Canvas
                key={`${layoutMode}-${viewResetKey}`}
                camera={{ position: [0, 16, 22], fov: 45 }}
                shadows
                onCreated={({ camera }) => {
                  cameraRef.current = camera as THREE.PerspectiveCamera;
                }}
              >
                <fog attach="fog" args={['#111827', 18, 42]} />
                <ambientLight intensity={0.6} />
                <pointLight position={[10, 16, 10]} intensity={1.05} />
                <directionalLight position={[-8, 12, 8]} intensity={0.85} castShadow />
                <IPGrid
                  zoomLevel={zoomLevel}
                  currentPosition={currentPosition}
                  getIPColor={getIPColor}
                  handleGridClick={handleGridClick}
                  onFlagClick={handleFlagClick}
                  lookupMode={lookupMode}
                  gridSystemMode={gridSystemMode}
                  grid2Position={grid2Position}
                  onHoverInfoHtml={setBottomInfoHtml}
                  onHoverCellChange={handlePointerTargetChange}
                  infoDisplayMode={infoDisplayMode}
                  remoteUsers={multiplayer.others}
                />
                <OrbitControls
                  ref={controlsRef}
                  enablePan
                  enableZoom
                  enableRotate
                  minPolarAngle={Math.PI / 6}
                  maxPolarAngle={Math.PI / 2.1}
                  target={[0, 0, 0]}
                />
              </Canvas>
            </div>
          </div>
        )}

        {layoutMode === 'grid' && !buildingView && (
          <div
            className="shrink-0 rounded-lg shadow-lg border border-gray-300 min-h-[96px] max-h-[18vh] px-3 py-2"
            style={{ backgroundColor: '#ffffff', color: '#000000' }}
          >
            <div className="max-h-[calc(18vh-1rem)] overflow-auto">
              {bottomInfoHtml ? (
                <div
                  className={infoDisplayMode === 'prose'
                    ? "text-sm leading-relaxed max-w-5xl [&_.font-bold]:text-base [&_.font-bold]:mb-2 [&_p]:mb-2 [&_.text-gray-600]:text-gray-700 [&_.text-blue-700]:text-blue-700 [&_.text-red-700]:text-red-700"
                    : "grid gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-3 text-sm leading-snug [&_.font-bold]:md:col-span-2 [&_.font-bold]:xl:col-span-3 [&_.font-bold]:text-base [&_.font-bold]:mb-1 [&_.space-y-1]:contents [&_.pt-1]:contents [&_.mt-2]:contents [&_.text-gray-400]:text-gray-600 [&_.text-gray-300]:text-gray-700 [&_.text-blue-300]:text-blue-700 [&_.text-blue-700]:text-blue-700 [&_.text-red-300]:text-red-700 [&_.text-red-700]:text-red-700 [&_.bg-gray-800]:bg-gray-100 [&_.bg-gray-100]:bg-gray-100 [&_.bg-gray-800]:p-1.5 [&_.bg-gray-100]:p-1.5 [&_.bg-gray-800]:rounded [&_.bg-gray-100]:rounded"}
                  dangerouslySetInnerHTML={{ __html: bottomInfoHtml }}
                />
              ) : (
                <div>&nbsp;</div>
              )}
            </div>
          </div>
        )}

        <div className="shrink-0 bg-white text-black border border-gray-300 rounded-lg shadow-sm p-2">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${
                  multiplayer.status === 'online'
                    ? 'bg-green-500'
                    : multiplayer.status === 'connecting'
                      ? 'bg-amber-500'
                      : 'bg-gray-400'
                }`} />
                <span className="font-semibold text-gray-700">{multiplayerStatusLabel}</span>
                <span className="text-gray-500">|</span>
                <span className="truncate text-gray-700">
                  {multiplayer.currentUser.displayName}
                </span>
                <span className="text-gray-500">|</span>
                <span className="text-gray-700">
                  {multiplayer.others.length} nearby
                </span>
              </div>
              <div className="mt-1 text-xs text-gray-500 break-all">{multiplayerRoomKey}</div>
            </div>

            <div className="w-full lg:max-w-xl">
              <div className="max-h-16 overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 text-sm">
                {multiplayer.messages.length > 0 ? (
                  multiplayer.messages.map((message) => (
                    <div key={message.id} className="flex gap-1 py-0.5">
                      <span className="font-semibold" style={{ color: message.color }}>
                        {message.displayName}:
                      </span>
                      <span className="break-words text-gray-800">{message.body}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-gray-500">
                    {multiplayer.isConfigured ? 'No room messages yet.' : 'Supabase env vars not configured.'}
                  </div>
                )}
              </div>
              <form onSubmit={handleSendChat} className="mt-2 flex gap-2">
                <input
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value.slice(0, 300))}
                  disabled={!multiplayer.isConfigured || multiplayer.status !== 'online'}
                  maxLength={300}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  placeholder={multiplayer.isConfigured ? 'Message this location' : 'Multiplayer offline'}
                />
                <button
                  type="submit"
                  disabled={!chatDraft.trim() || !multiplayer.isConfigured || multiplayer.status !== 'online'}
                  className="rounded border border-gray-400 bg-gray-200 px-3 py-1 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>

        {showHeightLegend && (
          <div className="shrink-0 max-h-[16vh] overflow-auto bg-white text-black border border-gray-300 p-2 rounded-lg">
            {layoutMode === 'grid' ? (
              <>
                <h3 className="font-semibold mb-2">Building Height = public service exposure</h3>
                <div className="h-6 rounded bg-gradient-to-r from-gray-500 via-blue-500 to-purple-500" />
                <div className="flex justify-between text-xs mt-1">
                  <span>No observed services</span><span>Several services</span><span>Many observed services</span>
                </div>
                <p className="text-sm mt-2 text-gray-700">
                  Heights use public scan data from Shodan InternetDB. This is a proxy for public exposure and importance, not actual traffic volume.
                </p>
              </>
            ) : (
              <>
                <h3 className="font-semibold mb-2">Routing mode</h3>
                <p className="text-sm text-gray-700">
                  The center node is the selected target IP. Each outer node is a RIPE Atlas probe, and intermediate nodes are individual traceroute hops returned by that probe. Curved lines show the measured path hop by hop.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
