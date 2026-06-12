import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import IPGrid, { type GridCellBuilding } from './components/IPGrid';
import {
  getExactLocationKey,
  getMultiplayerRoomKey,
  getPlayerLocationDisplay,
  useMultiplayerPresence,
  type MultiplayerCell,
  type MultiplayerPresence,
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
  x: number;
  y: number;
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
type StreetHeading = 0 | 1 | 2 | 3;
type SwipeDirection = 'up' | 'down' | 'left' | 'right';
type Grid2ArrowDirection = 'north' | 'south' | 'east' | 'west';

type Grid2Position = {
  outerFirstOctet: number;
  outerSecondOctet: number;
  innerThirdStart: number;
  innerFourthStart: number;
};

type PlayerLocation = MultiplayerPlayerLocation;

const GRID2_WINDOW_SIZE = 16;
const GRID_SIZE = 16;
const GRID_SPACING = 1.9;
const GRID_OFFSET = (GRID_SIZE * GRID_SPACING) / 2 - GRID_SPACING / 2;
const STREET_GRID_SIZE = 16;
const STREET_GRID_SPACING = 1.9;
const STREET_GRID_OFFSET = (STREET_GRID_SIZE * STREET_GRID_SPACING) / 2 - STREET_GRID_SPACING / 2;
const DEFAULT_GRID2_POSITION: Grid2Position = {
  outerFirstOctet: 128,
  outerSecondOctet: 220,
  innerThirdStart: 0,
  innerFourthStart: 0,
};
const DEFAULT_GRID_POSITION: GridPosition = {
  firstOctet: 0,
  secondOctet: 0,
  thirdOctet: 0,
  fourthOctet: 0,
};
// Starts the local user near the visible foreground of the top-level grid.
const DEFAULT_PLAYER_CELL = { x: 7, y: 15 };
const DEFAULT_GRID2_PLAYER_CELL = { x: 0, y: 0 };

function clampOctet(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampGrid2WindowStart(value: number): number {
  return Math.max(0, Math.min(256 - GRID2_WINDOW_SIZE, Math.round(value)));
}

function clampStreetCell(value: number): number {
  return Math.max(0, Math.min(STREET_GRID_SIZE - 1, Math.round(value)));
}

function Grid2ArrowIcon({ direction }: { direction: Grid2ArrowDirection }) {
  const rotation =
    direction === 'north' ? 0 :
    direction === 'east' ? 90 :
    direction === 'south' ? 180 :
    270;

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-8 w-8"
      style={{ color: '#111827', transform: `rotate(${rotation}deg)` }}
    >
      <path d="M12 3L4 11H9V21H15V11H20L12 3Z" fill="currentColor" />
    </svg>
  );
}

function getGridCellFromWorldTarget(target: THREE.Vector3): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(GRID_SIZE - 1, Math.round((target.x + GRID_OFFSET) / GRID_SPACING))),
    y: Math.max(0, Math.min(GRID_SIZE - 1, Math.round((target.z + GRID_OFFSET) / GRID_SPACING))),
  };
}

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

function getPlayerLocationForGridCell(
  gridSystemMode: GridSystemMode,
  zoomLevel: number,
  currentPosition: GridPosition,
  grid2Position: Grid2Position,
  x: number,
  y: number
): PlayerLocation {
  const cellX = Math.max(0, Math.min(15, Math.round(x)));
  const cellY = Math.max(0, Math.min(15, Math.round(y)));
  return {
    kind: 'ip',
    ipAddress: getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, cellX, cellY),
    x: cellX,
    y: cellY,
  };
}

function getPlayerCell(playerLocation: PlayerLocation): { x: number; y: number } {
  if (playerLocation.kind === 'ip') {
    return {
      x: Math.max(0, Math.min(15, Math.round(playerLocation.x ?? 7))),
      y: Math.max(0, Math.min(15, Math.round(playerLocation.y ?? 7))),
    };
  }

  if (playerLocation.kind === 'building') {
    return { x: 7, y: 7 };
  }

  return {
    x: Math.max(0, Math.min(15, Math.round(playerLocation.x))),
    y: Math.max(0, Math.min(15, Math.round(playerLocation.y))),
  };
}

function getPlayerLocationForStreetPosition(
  streetPlayerX: number,
  streetPlayerY: number,
  gridSystemMode: GridSystemMode,
  zoomLevel: number,
  currentPosition: GridPosition,
  grid2Position: Grid2Position
): PlayerLocation {
  const x = clampStreetCell(streetPlayerX);
  const y = clampStreetCell(streetPlayerY);
  const adjacentX = Math.min(STREET_GRID_SIZE - 1, x + 1);
  const adjacentY = Math.min(STREET_GRID_SIZE - 1, y + 1);
  const ipAddresses = [
    getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, x, y),
    getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, adjacentX, y),
    getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, x, adjacentY),
    getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, adjacentX, adjacentY),
  ];
  return {
    kind: 'intersection',
    x,
    y,
    ipAddresses: [...new Set(ipAddresses)].sort(),
  };
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

function getStreetCellWorldPosition(x: number, y: number): { x: number; z: number } {
  return {
    x: clampStreetCell(x) * STREET_GRID_SPACING - STREET_GRID_OFFSET + STREET_GRID_SPACING / 2,
    z: clampStreetCell(y) * STREET_GRID_SPACING - STREET_GRID_OFFSET + STREET_GRID_SPACING / 2,
  };
}

function getStreetHeadingVector(heading: StreetHeading): { dx: number; dy: number } {
  if (heading === 1) {
    return { dx: 1, dy: 0 };
  }
  if (heading === 2) {
    return { dx: 0, dy: 1 };
  }
  if (heading === 3) {
    return { dx: -1, dy: 0 };
  }
  return { dx: 0, dy: -1 };
}

function getStreetViewpointForBuilding(cell: GridCellBuilding): { x: number; y: number; heading: StreetHeading } {
  const x = clampStreetCell(cell.x);
  const y = clampStreetCell(cell.y);

  if (y < STREET_GRID_SIZE - 1) {
    return { x, y: y + 1, heading: 0 };
  }
  if (y > 0) {
    return { x, y: y - 1, heading: 2 };
  }
  if (x < STREET_GRID_SIZE - 1) {
    return { x: x + 1, y, heading: 3 };
  }
  return { x: Math.max(0, x - 1), y, heading: 1 };
}

function StreetGridCamera({
  streetPlayerX,
  streetPlayerY,
  heading,
  focusCell,
}: {
  streetPlayerX: number;
  streetPlayerY: number;
  heading: StreetHeading;
  focusCell?: { x: number; y: number } | null;
}) {
  const { camera } = useThree();

  useEffect(() => {
    const position = getStreetCellWorldPosition(streetPlayerX, streetPlayerY);
    const headingVector = getStreetHeadingVector(heading);
    const focusPosition = focusCell ? getStreetCellWorldPosition(focusCell.x, focusCell.y) : null;
    camera.position.set(position.x, 1.55, position.z);
    camera.lookAt(
      focusPosition ? focusPosition.x : position.x + headingVector.dx * STREET_GRID_SPACING * 3,
      focusPosition ? 1.05 : 1.35,
      focusPosition ? focusPosition.z : position.z + headingVector.dy * STREET_GRID_SPACING * 3
    );
    camera.updateProjectionMatrix();
  }, [camera, streetPlayerX, streetPlayerY, heading, focusCell?.x, focusCell?.y]);

  return null;
}


function App() {
  const [zoomLevel, setZoomLevel] = useState<number>(0);
  const [currentPosition, setCurrentPosition] = useState<GridPosition>(DEFAULT_GRID_POSITION);
  const [showHeightLegend, setShowHeightLegend] = useState<boolean>(false);
  const [lookupMode, setLookupMode] = useState<LookupMode>('rdap');
  const [infoDisplayMode, setInfoDisplayMode] = useState<InfoDisplayMode>('structured');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('grid');
  const [gridSystemMode, setGridSystemMode] = useState<GridSystemMode>('grid1');
  const [grid2Position, setGrid2Position] = useState<Grid2Position>(DEFAULT_GRID2_POSITION);
  const [streetPlayerX, setStreetPlayerX] = useState<number>(7);
  const [streetPlayerY, setStreetPlayerY] = useState<number>(7);
  const [streetHeading, setStreetHeading] = useState<StreetHeading>(0);
  const [selectedTargetIp, setSelectedTargetIp] = useState<string>(
    () => {
      const initialLocation = getPlayerLocationForGridCell('grid1', 0, DEFAULT_GRID_POSITION, DEFAULT_GRID2_POSITION, DEFAULT_PLAYER_CELL.x, DEFAULT_PLAYER_CELL.y);
      return initialLocation.kind === 'ip' ? initialLocation.ipAddress : '247.0.0.0';
    }
  );
  const [playerLocation, setPlayerLocation] = useState<PlayerLocation>(
    () => getPlayerLocationForGridCell('grid1', 0, DEFAULT_GRID_POSITION, DEFAULT_GRID2_POSITION, DEFAULT_PLAYER_CELL.x, DEFAULT_PLAYER_CELL.y)
  );
  const [viewResetKey, setViewResetKey] = useState(0);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);

  const controlsRef = useRef<any>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const currentHoverCellRef = useRef<GridCellBuilding | null>(null);
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
  const [displayNameDraft, setDisplayNameDraft] = useState('');

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
  const playerLocationIp =
    playerLocation.kind === 'ip' || playerLocation.kind === 'building'
      ? playerLocation.ipAddress
      : activeTargetIp;
  const multiplayerRoomKey = useMemo(
    () => getMultiplayerRoomKey(gridSystemMode, zoomLevel, currentPosition, grid2Position),
    [gridSystemMode, zoomLevel, currentPosition, grid2Position]
  );
  const chatLocationKey = useMemo(() => getExactLocationKey(playerLocation), [playerLocation]);
  const multiplayer = useMultiplayerPresence({
    roomKey: multiplayerRoomKey,
    chatLocationKey,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    pointerTarget,
    playerLocation,
    selectedIp: playerLocationIp,
  });
  useEffect(() => {
    setDisplayNameDraft(multiplayer.currentUser.displayName);
  }, [multiplayer.currentUser.displayName]);
  useEffect(() => {
    setPointerTarget(undefined);
    currentHoverCellRef.current = null;
  }, [multiplayerRoomKey]);

  useEffect(() => {
    if (layoutMode !== 'grid' || buildingView) {
      currentHoverCellRef.current = null;
    }
  }, [layoutMode, buildingView]);

  useEffect(() => {
    if (layoutMode !== 'street' || buildingView) {
      return;
    }

    setPlayerLocation(getPlayerLocationForStreetPosition(
      streetPlayerX,
      streetPlayerY,
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position
    ));
  }, [
    layoutMode,
    buildingView,
    streetPlayerX,
    streetPlayerY,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
  ]);

  const websiteCandidate = useMemo(
    () => getWebsiteCandidate(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );
  const buildingDirectoryEntries = useMemo(
    () => getBuildingDirectoryEntries(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );

  const moveToIpLocation = (ipAddress: string, kind: 'ip' | 'building' = 'ip') => {
    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(ipAddress);
    setLayoutMode('grid');
    setBuildingView(null);
    setSelectedTargetIp(ipAddress);

    if (gridSystemMode === 'grid2') {
      const nextGrid2Position = {
        outerFirstOctet: firstOctet,
        outerSecondOctet: secondOctet,
        innerThirdStart: clampGrid2WindowStart(Math.floor(thirdOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
        innerFourthStart: clampGrid2WindowStart(Math.floor(fourthOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
      };
      const x = fourthOctet - nextGrid2Position.innerFourthStart;
      const y = thirdOctet - nextGrid2Position.innerThirdStart;
      setGrid2Position(nextGrid2Position);
      setPlayerLocation(kind === 'building' ? { kind: 'building', ipAddress, outside: true } : { kind: 'ip', ipAddress, x, y });
      return;
    }

    setZoomLevel(3);
    setCurrentPosition({
      firstOctet,
      secondOctet,
      thirdOctet,
      fourthOctet: 0,
    });
    setPlayerLocation(kind === 'building'
      ? { kind: 'building', ipAddress, outside: true }
      : {
          kind: 'ip',
          ipAddress,
          x: fourthOctet % 16,
          y: Math.floor(fourthOctet / 16),
        });
  };

  const handleRemoteUserClick = (user: MultiplayerPresence) => {
    const location = user.playerLocation;
    if (!location) {
      return;
    }

    if (location.kind === 'ip') {
      moveToIpLocation(location.ipAddress, 'ip');
      return;
    }

    if (location.kind === 'building') {
      moveToIpLocation(location.ipAddress, 'building');
      return;
    }

    setLayoutMode('street');
    setBuildingView(null);
    setPlayerLocation(location);
    setSelectedTargetIp(location.ipAddresses[0] ?? activeTargetIp);
    const deltaX = clampStreetCell(location.x) - streetPlayerX;
    const deltaY = clampStreetCell(location.y) - streetPlayerY;
    if (Math.abs(deltaX) >= Math.abs(deltaY) && deltaX !== 0) {
      setStreetHeading(deltaX > 0 ? 1 : 3);
    } else if (deltaY !== 0) {
      setStreetHeading(deltaY > 0 ? 2 : 0);
    }
    setStreetPlayerX(clampStreetCell(location.x));
    setStreetPlayerY(clampStreetCell(location.y));
  };

  const enterStreetAtCell = (cell: GridCellBuilding) => {
    const x = clampStreetCell(cell.x);
    const y = clampStreetCell(cell.y);
    setSelectedTargetIp(cell.ipAddress);
    setBuildingView(null);
    setLayoutMode('street');
    setStreetPlayerX(x);
    setStreetPlayerY(y);
    setPlayerLocation(getPlayerLocationForStreetPosition(
      x,
      y,
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position
    ));
  };

  const handleGridCellClick = (cell: GridCellBuilding) => {
    const targetCell = layoutMode === 'grid' && currentHoverCellRef.current
      ? currentHoverCellRef.current
      : cell;
    const viewpoint = getStreetViewpointForBuilding(targetCell);
    setStreetPlayerX(viewpoint.x);
    setStreetPlayerY(viewpoint.y);
    setStreetHeading(viewpoint.heading);
    handleFlagClick(targetCell);
  };

  const updateStreetPlayerPosition = (x: number, y: number, ipAddress?: string) => {
    const nextX = clampStreetCell(x);
    const nextY = clampStreetCell(y);
    const nextLocation = getPlayerLocationForStreetPosition(
      nextX,
      nextY,
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position
    );
    setStreetPlayerX(nextX);
    setStreetPlayerY(nextY);
    setPlayerLocation(nextLocation);
    setSelectedTargetIp(ipAddress ?? nextLocation.ipAddresses[0] ?? activeTargetIp);
  };

  const moveStreetByDirection = (direction: SwipeDirection) => {
    const forward = getStreetHeadingVector(streetHeading);
    const vectors: Record<SwipeDirection, { dx: number; dy: number }> = {
      up: forward,
      down: { dx: -forward.dx, dy: -forward.dy },
      left: { dx: -forward.dy, dy: forward.dx },
      right: { dx: forward.dy, dy: -forward.dx },
    };
    const vector = vectors[direction];
    updateStreetPlayerPosition(streetPlayerX + vector.dx, streetPlayerY + vector.dy);
  };

  const turnStreetBy = (delta: -1 | 1) => {
    setStreetHeading((prev) => ((prev + delta + 4) % 4) as StreetHeading);
  };

  const handleStreetCellClick = (cell: GridCellBuilding) => {
    updateStreetPlayerPosition(cell.x, cell.y, cell.ipAddress);
  };

  const handleStreetBuildingClick = (cell: GridCellBuilding) => {
    handleFlagClick(cell);
  };

  const handleCellDoubleClick = (cell: GridCellBuilding) => {
    const targetCell = layoutMode === 'grid' && currentHoverCellRef.current
      ? currentHoverCellRef.current
      : cell;
    setSelectedTargetIp(targetCell.ipAddress);

    if (gridSystemMode === 'grid2') {
      setPlayerLocation({ kind: 'ip', ipAddress: targetCell.ipAddress, x: targetCell.x, y: targetCell.y });
      return;
    }

    const [firstOctet, secondOctet, thirdOctet] = parseIpOctets(targetCell.ipAddress);
    setBuildingView(null);

    if (zoomLevel === 0) {
      setCurrentPosition({ firstOctet, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
      setZoomLevel(1);
      setPlayerLocation({ kind: 'ip', ipAddress: cell.ipAddress, x: 0, y: 0 });
    } else if (zoomLevel === 1) {
      setCurrentPosition((prev) => ({ ...prev, secondOctet, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(2);
      setPlayerLocation({ kind: 'ip', ipAddress: cell.ipAddress, x: 0, y: 0 });
    } else if (zoomLevel === 2) {
      setCurrentPosition((prev) => ({ ...prev, thirdOctet, fourthOctet: 0 }));
      setZoomLevel(3);
      setPlayerLocation({ kind: 'ip', ipAddress: cell.ipAddress, x: 0, y: 0 });
    } else {
      setPlayerLocation({ kind: 'ip', ipAddress: cell.ipAddress, x: cell.x, y: cell.y });
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
    const resetPlayerCell = gridSystemMode === 'grid2' ? DEFAULT_GRID2_PLAYER_CELL : DEFAULT_PLAYER_CELL;
    const nextPlayerLocation = getPlayerLocationForGridCell(
      gridSystemMode,
      0,
      DEFAULT_GRID_POSITION,
      DEFAULT_GRID2_POSITION,
      resetPlayerCell.x,
      resetPlayerCell.y
    );
    const nextTargetIp = nextPlayerLocation.kind === 'ip' ? nextPlayerLocation.ipAddress : '247.0.0.0';
    setLayoutMode('grid');
    setBuildingView(null);
    setZoomLevel(0);
    setCurrentPosition(DEFAULT_GRID_POSITION);
    setGrid2Position(DEFAULT_GRID2_POSITION);
    setSelectedTargetIp(nextTargetIp);
    setPlayerLocation(nextPlayerLocation);
    setStreetPlayerX(7);
    setStreetPlayerY(7);
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
    const nextGrid2Position = mode === 'grid2' ? DEFAULT_GRID2_POSITION : grid2Position;
    const nextPlayerCell = mode === 'grid2' ? DEFAULT_GRID2_PLAYER_CELL : DEFAULT_PLAYER_CELL;
    const nextPlayerLocation = getPlayerLocationForGridCell(mode, zoomLevel, currentPosition, nextGrid2Position, nextPlayerCell.x, nextPlayerCell.y);
    const nextTargetIp = nextPlayerLocation.kind === 'ip'
      ? nextPlayerLocation.ipAddress
      : mode === 'grid2'
        ? getGrid2IpFromCell(nextGrid2Position, nextPlayerCell.x, nextPlayerCell.y)
        : getRepresentativeTarget('grid1', zoomLevel, currentPosition, nextGrid2Position);
    setGridSystemMode(mode);
    if (mode === 'grid2') {
      setGrid2Position(DEFAULT_GRID2_POSITION);
    }
    setLayoutMode('grid');
    setBuildingView(null);
    setBottomInfoHtml('');
    setSelectedTargetIp(nextTargetIp);
    setPlayerLocation(nextPlayerLocation);
  };

  const moveGrid2Window = (thirdDelta: number, fourthDelta: number) => {
    const playerCell = getPlayerCell(playerLocation);
    setGrid2Position((prev) => {
      const next = {
        ...prev,
        innerThirdStart: clampGrid2WindowStart(prev.innerThirdStart + thirdDelta),
        innerFourthStart: clampGrid2WindowStart(prev.innerFourthStart + fourthDelta),
      };
      const nextPlayerLocation = getPlayerLocationForGridCell('grid2', zoomLevel, currentPosition, next, playerCell.x, playerCell.y);
      if (nextPlayerLocation.kind === 'ip') {
        setSelectedTargetIp(nextPlayerLocation.ipAddress);
      }
      setPlayerLocation(nextPlayerLocation);
      return next;
    });
    setBottomInfoHtml('');
  };

  const moveGrid2WindowByDirection = (direction: 'north' | 'south' | 'east' | 'west') => {
    if (direction === 'north') {
      moveGrid2Window(-GRID2_WINDOW_SIZE, 0);
    } else if (direction === 'south') {
      moveGrid2Window(GRID2_WINDOW_SIZE, 0);
    } else if (direction === 'west') {
      moveGrid2Window(0, -GRID2_WINDOW_SIZE);
    } else {
      moveGrid2Window(0, GRID2_WINDOW_SIZE);
    }
  };

  const updatePlayerLocationFromGridView = useCallback(() => {
    if (layoutMode !== 'grid' || buildingView || !controlsRef.current) {
      return;
    }

    const cell = getGridCellFromWorldTarget(controlsRef.current.target as THREE.Vector3);
    const nextLocation = getPlayerLocationForGridCell(
      gridSystemMode,
      zoomLevel,
      currentPosition,
      grid2Position,
      cell.x,
      cell.y
    );

    if (nextLocation.kind !== 'ip') {
      return;
    }

    setPlayerLocation((current) => {
      if (
        current.kind === 'ip' &&
        current.ipAddress === nextLocation.ipAddress &&
        current.x === nextLocation.x &&
        current.y === nextLocation.y
      ) {
        return current;
      }
      return nextLocation;
    });
    setSelectedTargetIp((current) => current === nextLocation.ipAddress ? current : nextLocation.ipAddress);
  }, [layoutMode, buildingView, gridSystemMode, zoomLevel, currentPosition, grid2Position]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || layoutMode !== 'street' || buildingView) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const useSidewaysMovement = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);

      if (useSidewaysMovement) {
        const sidewaysDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (sidewaysDelta === 0) {
          return;
        }
        moveStreetByDirection(sidewaysDelta > 0 ? 'right' : 'left');
        return;
      }

      if (event.deltaY === 0) {
        return;
      }

      moveStreetByDirection(event.deltaY > 0 ? 'down' : 'up');
    };

    container.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [
    layoutMode,
    buildingView,
    streetHeading,
    streetPlayerX,
    streetPlayerY,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    activeTargetIp,
  ]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || layoutMode !== 'street' || buildingView) {
      return;
    }

    const dragThreshold = 24;
    let pointerStart: { x: number; y: number; turnMode: boolean } | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return;
      }
      pointerStart = {
        x: event.clientX,
        y: event.clientY,
        turnMode: event.button === 2 || event.altKey || event.shiftKey,
      };
      if (pointerStart.turnMode) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerStart) {
        return;
      }

      const deltaX = event.clientX - pointerStart.x;
      const deltaY = event.clientY - pointerStart.y;

      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < dragThreshold) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (pointerStart.turnMode && Math.abs(deltaX) >= Math.abs(deltaY)) {
        turnStreetBy(deltaX > 0 ? 1 : -1);
      } else if (Math.abs(deltaX) > Math.abs(deltaY)) {
        moveStreetByDirection(deltaX > 0 ? 'right' : 'left');
      } else {
        moveStreetByDirection(deltaY < 0 ? 'up' : 'down');
      }

      pointerStart = {
        x: event.clientX,
        y: event.clientY,
        turnMode: pointerStart.turnMode,
      };
    };

    const clearPointerDrag = () => {
      pointerStart = null;
    };

    const preventStreetContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    container.addEventListener('pointerdown', handlePointerDown, { capture: true });
    container.addEventListener('pointermove', handlePointerMove, { capture: true });
    container.addEventListener('pointerup', clearPointerDrag, { capture: true });
    container.addEventListener('pointercancel', clearPointerDrag, { capture: true });
    container.addEventListener('contextmenu', preventStreetContextMenu, { capture: true });
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      container.removeEventListener('pointermove', handlePointerMove, { capture: true });
      container.removeEventListener('pointerup', clearPointerDrag, { capture: true });
      container.removeEventListener('pointercancel', clearPointerDrag, { capture: true });
      container.removeEventListener('contextmenu', preventStreetContextMenu, { capture: true });
    };
  }, [
    layoutMode,
    buildingView,
    streetHeading,
    streetPlayerX,
    streetPlayerY,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    activeTargetIp,
  ]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || layoutMode !== 'street' || buildingView) {
      return;
    }

    const swipeThreshold = 32;
    let touchStart: { x: number; y: number } | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        touchStart = null;
        return;
      }
      touchStart = { x: touch.clientX, y: touch.clientY };
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (touchStart) {
        event.preventDefault();
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!touchStart) {
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch) {
        touchStart = null;
        return;
      }

      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      touchStart = null;

      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < swipeThreshold) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        turnStreetBy(deltaX > 0 ? 1 : -1);
        return;
      }

      moveStreetByDirection(deltaY < 0 ? 'up' : 'down');
    };

    container.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', handleTouchEnd, { capture: true, passive: false });
    return () => {
      container.removeEventListener('touchstart', handleTouchStart, { capture: true });
      container.removeEventListener('touchmove', handleTouchMove, { capture: true });
      container.removeEventListener('touchend', handleTouchEnd, { capture: true });
    };
  }, [
    layoutMode,
    buildingView,
    streetHeading,
    streetPlayerX,
    streetPlayerY,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    activeTargetIp,
  ]);

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
    setPlayerLocation({ kind: 'building', ipAddress: building.ipAddress, outside: true });
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
      return 'Hover over a location for information. Click on it to go to that location. Scroll or drag up/down to move forward or backward. Use horizontal scroll, Shift-scroll, or horizontal dragging to move left and right. Swipe left or right, or right/modified-drag horizontally, to turn. Click a building to enter it.';
    }

    if (gridSystemMode === 'grid2') {
      return 'Grid 2 maps n1.n2.n3.n4 as inner point n3,n4 inside outer point n1,n2. Only the local 16 by 16 neighborhood is rendered; use the Grid 2 controls to move through the larger 256 by 256 inner grid. Single-click a building or square for street level; double-click to select that exact IP.';
    }

    if (zoomLevel === 0) {
      return lookupMode === 'rdap'
        ? 'Single-click a building or square for street level; double-click to zoom into a first-octet block. Heights use public service exposure data. Hover for live ownership and registration data.'
        : 'Single-click a building or square for street level; double-click to zoom into a first-octet block. Heights use public service exposure data. Hover for hostname data from reverse DNS, with scan-data fallback when PTR is absent.';
    }

    if (zoomLevel === 1) {
      return `Viewing the 256 second-octet values under ${currentPosition.firstOctet}.0.0.0/8. Heights use public service exposure for each representative IP.`;
    }

    if (zoomLevel === 2) {
      return `Viewing the 256 third-octet values under ${currentPosition.firstOctet}.${currentPosition.secondOctet}.0.0/16. Heights use public service exposure for each representative IP.`;
    }

    return lookupMode === 'rdap'
      ? `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Single-click a building or square for street level. Hover a building to fetch live RDAP ownership and registration data.`
      : `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Single-click a building or square for street level. Hover a building to fetch hostname data.`;
  };

  const isBackDisabled = layoutMode !== 'street' && (gridSystemMode === 'grid2' || zoomLevel === 0);
  const multiplayerStatusLabel = multiplayer.isConfigured
    ? multiplayer.status === 'error'
      ? 'Offline'
      : multiplayer.status.charAt(0).toUpperCase() + multiplayer.status.slice(1)
    : 'Offline';
  const nearbyUsers = multiplayer.others;
  const userLocationLabel = getPlayerLocationDisplay(playerLocation);
  const handlePointerTargetChange = (cell: GridCellBuilding) => {
    currentHoverCellRef.current = cell;
    setPointerTarget(cell);
  };
  const handleSendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    multiplayer.sendMessage(chatDraft);
    setChatDraft('');
  };
  const handleSaveDisplayName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = displayNameDraft.trim().slice(0, 24);
    if (!cleaned) {
      setDisplayNameDraft(multiplayer.currentUser.displayName);
      return;
    }

    if (multiplayer.updateDisplayName(cleaned)) {
      setDisplayNameDraft(cleaned);
    }
  };

  const renderStreetSceneCanvas = (viewKey: string, focusCell?: { x: number; y: number } | null) => {
    const focusPosition = focusCell ? getStreetCellWorldPosition(focusCell.x, focusCell.y) : null;

    return (
      <div
        ref={gridContainerRef}
        className="relative w-full h-full min-h-[260px] touch-none rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]"
      >
        <Canvas
          key={viewKey}
          camera={{ position: [0, 1.55, 0], fov: 62 }}
          shadows
          onCreated={({ camera }) => {
            cameraRef.current = camera as THREE.PerspectiveCamera;
          }}
        >
          <fog attach="fog" args={['#111827', 12, 46]} />
          <ambientLight intensity={0.68} />
          <pointLight position={[10, 16, 10]} intensity={1.05} />
          <directionalLight position={[-8, 12, 8]} intensity={0.85} castShadow />
          <StreetGridCamera
            streetPlayerX={streetPlayerX}
            streetPlayerY={streetPlayerY}
            heading={streetHeading}
            focusCell={focusCell}
          />
          <IPGrid
            zoomLevel={zoomLevel}
            currentPosition={currentPosition}
            getIPColor={getIPColor}
            onCellClick={handleStreetCellClick}
            onCellDoubleClick={handleStreetCellClick}
            onBuildingClick={handleStreetBuildingClick}
            onBuildingDoubleClick={handleStreetBuildingClick}
            lookupMode={lookupMode}
            gridSystemMode={gridSystemMode}
            grid2Position={grid2Position}
            onHoverInfoHtml={setBottomInfoHtml}
            onHoverCellChange={handlePointerTargetChange}
            infoDisplayMode={infoDisplayMode}
            remoteUsers={multiplayer.others}
            onRemoteUserClick={handleRemoteUserClick}
            selectedBuildingIp={buildingView?.ipAddress}
            selectedBuildingFlagImageUrl={buildingView?.flagImageUrl}
            selectedBuildingCountryCodeLabel={buildingView?.countryCodeLabel}
          />
          {focusPosition && (
            <OrbitControls
              ref={controlsRef}
              enablePan
              enableZoom
              enableRotate
              onChange={updatePlayerLocationFromGridView}
              minPolarAngle={Math.PI / 6}
              maxPolarAngle={Math.PI / 2.1}
              target={[focusPosition.x, 1.05, focusPosition.z]}
            />
          )}
        </Canvas>
      </div>
    );
  };

  return (
    <div className="h-screen overflow-hidden bg-white text-black flex flex-col">
      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3">
        <header className="shrink-0 bg-white text-black p-3 rounded-lg">
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0 lg:pr-4">
              <h1 className="text-2xl font-bold">Burning Chrome</h1>
            </div>

            <div className="min-w-0 lg:px-4 lg:pt-1" />

            <div className="flex flex-col items-start lg:items-end gap-3 lg:pl-4">
              <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
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
                    className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                    aria-expanded={isOptionsOpen}
                    aria-haspopup="menu"
                  >
                    Menu
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
                        Return to Main Level
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
                        Re-Center the Camera
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
                          setInfoDisplayMode((prev) => (prev === 'structured' ? 'prose' : 'structured'));
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        {infoDisplayMode === 'prose' ? 'Switch to Data Mode' : 'Switch to Prose Mode'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative group">
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                  >
                    Info and Instructions
                  </button>
                  <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-gray-300 bg-white p-4 text-sm leading-relaxed text-gray-800 shadow-xl group-hover:block group-hover:pointer-events-auto group-focus-within:block group-focus-within:pointer-events-auto">
                    <p className="font-medium text-gray-950">3D IPv4 city grid with public-exposure-based heights and live RDAP/hostname lookups</p>
                    <p className="mt-2 text-xs italic text-gray-700">Hover over a location for information. Click on it to go to that location. Double-click on it to tunnel down to the next level of addresses.</p>
                    <p className="mt-2 italic">{getCurrentRangeLabel()}</p>
                    <p className="mt-2">{getInstructionText()}</p>
                    <p className="mt-2 text-xs text-gray-700">Faint street streaks are ambient visual motion. Brighter routing streaks represent recent BGP events affecting visible ASN neighborhoods when such events are available.</p>
                    <p className="mt-3 text-xs text-gray-700">Current height source: Shodan InternetDB</p>
                    <p className="mt-1 text-xs text-gray-700">Selected routing target: {activeTargetIp}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        {buildingView ? (
          <div className="flex-1 min-h-0 flex flex-col gap-3 lg:flex-row">
            <div className="relative flex-1 min-h-[260px] lg:flex-[1.35]">
              {renderStreetSceneCanvas(
                `building-street-${viewResetKey}-${buildingView.ipAddress}`,
                { x: buildingView.x, y: buildingView.y }
              )}
            </div>

            <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
              <div className="font-bold text-lg">Street and Building View: {buildingView.ipAddress}</div>
              <div className="text-sm text-gray-600 mt-1">
                Use "Return to Grid" to leave Street and Building View.
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleExitBuildingView}
                    className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                  >
                    Return to Grid
                  </button>

                  <button
                    onClick={handleLaunchSsh}
                    disabled={sshLaunchLoadingIp === buildingView.ipAddress}
                    className={`px-3 py-2 rounded-md text-sm font-medium ${sshLaunchLoadingIp === buildingView.ipAddress ? 'bg-gray-300 text-gray-500 border border-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400'}`}
                    title="Open the local SSH client"
                  >
                    {sshLaunchLoadingIp === buildingView.ipAddress ? 'Opening SSH...' : 'Open SSH client'}
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

                <div>
                  <div className="font-semibold">Directory</div>
                  {buildingDirectoryEntries.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {buildingDirectoryEntries.map((entry) => (
                        <a
                          key={entry.hostname}
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer"
                          title={entry.hostname}
                          className="block rounded bg-gray-100 p-2 text-xs text-blue-700 underline break-all hover:bg-gray-200"
                        >
                          {entry.hostname}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600 mt-2">No websites identified.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : layoutMode === 'street' ? (
          <div className="flex-1 min-h-0 flex justify-center">
            {renderStreetSceneCanvas(`street-${viewResetKey}`)}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex justify-center">
            <div
              ref={gridContainerRef}
              className="relative w-full h-full min-h-[260px] rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]"
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
                  onCellClick={handleGridCellClick}
                  onCellDoubleClick={handleCellDoubleClick}
                  lookupMode={lookupMode}
                  gridSystemMode={gridSystemMode}
                  grid2Position={grid2Position}
                  onHoverInfoHtml={setBottomInfoHtml}
                  onHoverCellChange={handlePointerTargetChange}
                  infoDisplayMode={infoDisplayMode}
                  remoteUsers={multiplayer.others}
                  onRemoteUserClick={handleRemoteUserClick}
                />
                <OrbitControls
                  ref={controlsRef}
                  enablePan
                  enableZoom
                  enableRotate
                  onChange={updatePlayerLocationFromGridView}
                  minPolarAngle={Math.PI / 6}
                  maxPolarAngle={Math.PI / 2.1}
                  target={[0, 0, 0]}
                />
              </Canvas>
              {gridSystemMode === 'grid2' && (
                <>
                  <button
                    type="button"
                    aria-label="Move Grid 2 window north"
                    onClick={() => moveGrid2WindowByDirection('north')}
                    disabled={grid2Position.innerThirdStart <= 0}
                    className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-lg border border-gray-500 bg-white/80 px-4 py-2 text-base font-semibold text-gray-900 shadow-lg backdrop-blur-sm hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Grid2ArrowIcon direction="north" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move Grid 2 window south"
                    onClick={() => moveGrid2WindowByDirection('south')}
                    disabled={grid2Position.innerThirdStart >= 256 - GRID2_WINDOW_SIZE}
                    className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-gray-500 bg-white/80 px-4 py-2 text-base font-semibold text-gray-900 shadow-lg backdrop-blur-sm hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Grid2ArrowIcon direction="south" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move Grid 2 window west"
                    onClick={() => moveGrid2WindowByDirection('west')}
                    disabled={grid2Position.innerFourthStart <= 0}
                    className="absolute left-3 top-1/2 z-20 -translate-y-1/2 rounded-lg border border-gray-500 bg-white/80 px-4 py-2 text-base font-semibold text-gray-900 shadow-lg backdrop-blur-sm hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Grid2ArrowIcon direction="west" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move Grid 2 window east"
                    onClick={() => moveGrid2WindowByDirection('east')}
                    disabled={grid2Position.innerFourthStart >= 256 - GRID2_WINDOW_SIZE}
                    className="absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-lg border border-gray-500 bg-white/80 px-4 py-2 text-base font-semibold text-gray-900 shadow-lg backdrop-blur-sm hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Grid2ArrowIcon direction="east" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {!buildingView && (
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
                  {nearbyUsers.length} nearby
                  {nearbyUsers.length > 0 && nearbyUsers.length <= 3 && (
                    <>
                      :{' '}
                      {nearbyUsers.map((user, index) => {
                        const displayName = user.displayName?.trim() || 'Explorer';
                        return (
                          <span key={user.userId}>
                            {index > 0 && ', '}
                            <button
                              type="button"
                              onClick={() => handleRemoteUserClick(user)}
                              className="text-blue-700 underline-offset-2 hover:underline"
                              title={`Go to ${displayName}`}
                            >
                              {displayName}
                            </button>
                          </span>
                        );
                      })}
                    </>
                  )}
                </span>
              </div>
              <div className="mt-1 text-xs text-gray-500 break-all">Location: {userLocationLabel}</div>
              <form onSubmit={handleSaveDisplayName} className="mt-2 flex max-w-xs items-center gap-2 text-xs">
                <label className="shrink-0 font-medium text-gray-700" htmlFor="display-name-input">
                  Name:
                </label>
                <input
                  id="display-name-input"
                  value={displayNameDraft}
                  onChange={(event) => setDisplayNameDraft(event.target.value.slice(0, 24))}
                  maxLength={24}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-900"
                />
                <button
                  type="submit"
                  disabled={!displayNameDraft.trim()}
                  className="rounded border border-gray-400 bg-gray-200 px-2 py-1 text-xs font-medium text-gray-900 shadow-sm hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Save
                </button>
              </form>
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
                  disabled={!multiplayer.isConfigured || multiplayer.status !== 'online' || chatLocationKey === 'unknown'}
                  maxLength={300}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  placeholder={multiplayer.isConfigured ? 'Message this location' : 'Multiplayer offline'}
                />
                <button
                  type="submit"
                  disabled={!chatDraft.trim() || !multiplayer.isConfigured || multiplayer.status !== 'online' || chatLocationKey === 'unknown'}
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
