import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import IPGrid, { type GridCellBuilding, type PublicWebEnrichmentContext } from './components/IPGrid';
import {
  getCanonicalChatLocationKey,
  getMultiplayerGridKey,
  getPlayerLocationDisplay,
  useMultiplayerPresence,
  type MultiplayerCell,
  type MultiplayerPresence,
  type MultiplayerPlayerLocation,
  type MultiplayerStartingLocation,
  type MultiplayerStartingLocationSource,
} from './hooks/useMultiplayerPresence';
import { isSupabaseConfigured, supabase, supabaseUrlHost } from './lib/supabaseClient';

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
  organizationName?: string;
};

type DirectoryEntry = {
  hostname: string;
  url: string;
};

type DomainSearchResult = {
  label: string;
  domain?: string;
  ip: string;
  source?: string;
  description?: string;
};

type BookmarkEntry = {
  ipAddress: string;
  organizationName?: string;
  note: string;
};

type SharedBookmarkEntry = BookmarkEntry & {
  userId: string;
  updatedAt?: string;
};

type PublicWebEnrichmentStatus = 'default' | 'loading' | 'summary' | 'error';

type PublicWebEnrichmentState = {
  status: PublicWebEnrichmentStatus;
  ipAddress?: string;
  synopsis?: string;
  message?: string;
};

type PublicWebFailureReason =
  | 'not_configured'
  | 'invalid_context'
  | 'provider_timeout'
  | 'provider_credentials'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'provider_unreachable'
  | 'provider_invalid_json'
  | 'provider_unexpected_format'
  | 'no_reliable_result';

type PublicWebEnrichmentResponse = {
  status?: 'ready' | 'not_found' | 'error';
  ipAddress?: string;
  synopsis?: string;
  reason?: PublicWebFailureReason;
  message?: string;
  cached?: boolean;
};

type UserBookmarkRow = {
  user_id: string;
  ip_address: string;
  organization_name: string | null;
  note: string | null;
  updated_at: string | null;
};

type StartingLocationPreference = 'default' | 'last_location' | 'random_grid1' | 'random_grid2' | 'specific';

type StartingLocationPreferenceState = {
  preference: StartingLocationPreference;
  specificIp: string;
};

type StoredLastLocation = {
  gridSystemMode?: GridSystemMode;
  viewMode?: 'grid' | 'street' | 'building';
  zoomLevel?: number;
  currentPosition?: GridPosition;
  grid2Position?: Grid2Position;
  playerLocation?: PlayerLocation;
  selectedIp?: string;
  streetPlayerX?: number;
  streetPlayerY?: number;
  streetHeading?: StreetHeading;
  streetTargetCell?: GridCellBuilding | null;
  streetFocusCell?: StreetFocusCell | null;
  buildingView?: BuildingViewState | null;
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

type StreetFocusCell = {
  x: number;
  y: number;
};

type PlayerLocation = MultiplayerPlayerLocation;

const GRID2_WINDOW_SIZE = 16;
const GRID_SIZE = 16;
const STREET_GRID_SIZE = 16;
const STREET_GRID_SPACING = 1.9;
const STREET_GRID_OFFSET = (STREET_GRID_SIZE * STREET_GRID_SPACING) / 2 - STREET_GRID_SPACING / 2;
const DEFAULT_GRID2_POSITION: Grid2Position = {
  outerFirstOctet: 128,
  outerSecondOctet: 220,
  innerThirdStart: 0,
  innerFourthStart: 0,
};
const MAX_AVATAR_FILE_BYTES = 10 * 1024 * 1024;
const AVATAR_BUCKET = 'avatars';
const BOOKMARKS_STORAGE_PREFIX = 'cyberspace.bookmarks';
const DEBUG_PRESENCE = false;
const DEBUG_REMOTE_AVATARS = false;
const DEBUG_AVATAR_PIPELINE = false;
const TOUCH_WEBGL_DPR: [number, number] = [1, 1.5];
const miniAvatarModelLoader = new GLTFLoader();
const miniAvatarModelCache = new Map<string, Promise<THREE.Group>>();

function isConstrainedWebGLDevice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const hasTouch = window.navigator.maxTouchPoints > 0;
  const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const lacksHover = window.matchMedia?.('(hover: none)').matches ?? false;

  return hasTouch || hasCoarsePointer || lacksHover;
}

function getCanvasDpr(): [number, number] | undefined {
  return isConstrainedWebGLDevice() ? TOUCH_WEBGL_DPR : undefined;
}

function validateAvatarFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.glb')) {
    return 'Choose a .glb avatar file.';
  }
  if (file.size > MAX_AVATAR_FILE_BYTES) {
    return 'Avatar file must be 10 MB or smaller.';
  }
  return null;
}

function getAvatarStoragePath(userId: string): string {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'user';
  return `${safeUserId}/avatar.glb`;
}

function getVersionedAvatarUrl(publicUrl: string): string {
  const version = Date.now().toString();
  try {
    const url = new URL(publicUrl);
    url.searchParams.set('v', version);
    return url.toString();
  } catch {
    return `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${version}`;
  }
}

function getBookmarksStorageKey(userId: string): string {
  return `${BOOKMARKS_STORAGE_PREFIX}.${userId}`;
}

function readStoredBookmarks(userId: string): BookmarkEntry[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const storedValue = window.localStorage.getItem(getBookmarksStorageKey(userId));
    if (!storedValue) {
      return [];
    }
    const parsedValue = JSON.parse(storedValue);
    if (!Array.isArray(parsedValue)) {
      return [];
    }

    const seen = new Set<string>();
    return parsedValue
      .filter((item): item is string | Record<string, unknown> => typeof item === 'string' || Boolean(item && typeof item === 'object'))
      .map((item) => {
        const ipAddress = typeof item === 'string'
          ? item
          : typeof item.ipAddress === 'string' && isValidIpv4(item.ipAddress)
            ? item.ipAddress
            : '';
        if (!ipAddress || seen.has(ipAddress)) {
          return null;
        }
        seen.add(ipAddress);
        const organizationName = typeof item !== 'string' && typeof item.organizationName === 'string' && item.organizationName.trim()
          ? item.organizationName.trim()
          : undefined;
        const note = typeof item !== 'string' && typeof item.note === 'string' ? item.note : '';
        return { ipAddress, organizationName, note };
      })
      .filter((item): item is BookmarkEntry => Boolean(item));
  } catch {
    return [];
  }
}

function writeStoredBookmarks(userId: string, bookmarks: BookmarkEntry[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(getBookmarksStorageKey(userId), JSON.stringify(bookmarks));
}

function cloneMiniAvatarScene(scene: THREE.Group): THREE.Group {
  return scene.clone(true);
}

function disposeMiniAvatarScene(scene: THREE.Object3D): void {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else {
      material?.dispose();
    }
  });
}

function normalizeMiniAvatarScene(scene: THREE.Group): THREE.Group | null {
  const clone = cloneMiniAvatarScene(scene);
  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const root = new THREE.Group();
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (Number.isFinite(maxDimension) && maxDimension > 0) {
    clone.position.sub(center);
    root.scale.setScalar(1.35 / maxDimension);
  } else {
    disposeMiniAvatarScene(clone);
    return null;
  }
  root.add(clone);
  return root;
}

function loadMiniAvatarScene(avatarUrl: string): Promise<THREE.Group> {
  const cached = miniAvatarModelCache.get(avatarUrl);
  if (cached) {
    return cached;
  }

  const request = new Promise<THREE.Group>((resolve, reject) => {
    miniAvatarModelLoader.load(avatarUrl, (gltf) => resolve(gltf.scene), undefined, reject);
  }).catch((error) => {
    miniAvatarModelCache.delete(avatarUrl);
    throw error;
  });
  miniAvatarModelCache.set(avatarUrl, request);
  return request;
}

function MiniDefaultAvatar({ color }: { color: string }) {
  return (
    <mesh>
      <sphereGeometry args={[0.56, 24, 24]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.28} />
    </mesh>
  );
}

function MiniCustomAvatar({ avatarUrl, color }: { avatarUrl?: string; color: string }) {
  const [model, setModel] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let isActive = true;
    setModel(null);

    if (!avatarUrl) {
      return () => {
        isActive = false;
      };
    }

    void loadMiniAvatarScene(avatarUrl)
      .then((scene) => {
        if (isActive) {
          setModel(normalizeMiniAvatarScene(scene));
        }
      })
      .catch(() => {
        if (isActive) {
          setModel(null);
        }
      });

    return () => {
      isActive = false;
    };
  }, [avatarUrl]);

  useEffect(() => () => {
    if (model) {
      disposeMiniAvatarScene(model);
    }
  }, [model]);

  return model ? <primitive object={model} /> : <MiniDefaultAvatar color={color} />;
}

function MiniUserAvatar({
  user,
  ariaLabel,
  renderCustomOnConstrainedDevice = false,
}: {
  user: MultiplayerPresence;
  ariaLabel?: string;
  renderCustomOnConstrainedDevice?: boolean;
}) {
  const renderWebGLAvatar = !isConstrainedWebGLDevice() || (renderCustomOnConstrainedDevice && Boolean(user.avatarUrl));

  return (
    <div
      className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-gray-300 bg-white"
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      {renderWebGLAvatar ? (
        <Canvas camera={{ position: [0, 0, 2.4], fov: 38 }}>
          <ambientLight intensity={0.85} />
          <directionalLight position={[2, 2, 3]} intensity={0.9} />
          <MiniCustomAvatar avatarUrl={user.avatarUrl} color={user.color} />
        </Canvas>
      ) : (
        <div className="h-full w-full" style={{ backgroundColor: user.color }} />
      )}
    </div>
  );
}

function getAvatarUrlDebugInfo(avatarUrl?: string) {
  const value = avatarUrl?.trim() ?? '';
  const lowerValue = value.toLowerCase();
  return {
    avatarUrlExists: Boolean(value),
    avatarUrl: value,
    startsWithHttp: /^https?:\/\//i.test(value),
    startsWithBlob: lowerValue.startsWith('blob:'),
    startsWithFile: lowerValue.startsWith('file:'),
    startsWithLocalhost:
      lowerValue.includes('localhost') ||
      lowerValue.includes('127.0.0.1') ||
      lowerValue.includes('[::1]'),
  };
}
const DEFAULT_GRID_POSITION: GridPosition = {
  firstOctet: 0,
  secondOctet: 0,
  thirdOctet: 0,
  fourthOctet: 0,
};
// Starts the local user near the visible foreground of the top-level grid.
const DEFAULT_PLAYER_CELL = { x: 7, y: 15 };
const DEFAULT_STARTING_LOCATION_IP = '247.0.0.0';
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

function isValidIpv4(value: string): boolean {
  const parts = value.trim().split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const octet = Number.parseInt(part, 10);
    return octet >= 0 && octet <= 255 && String(octet) === part;
  });
}

function getDefaultStartingLocation(): MultiplayerStartingLocation {
  return {
    gridSystemMode: 'grid1',
    source: 'default',
    ipAddress: DEFAULT_STARTING_LOCATION_IP,
    zoomLevel: 0,
    currentPosition: DEFAULT_GRID_POSITION,
    x: DEFAULT_PLAYER_CELL.x,
    y: DEFAULT_PLAYER_CELL.y,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStartingLocationPreference(
  source: unknown,
  startingLocation: unknown
): StartingLocationPreferenceState {
  if (source === 'last_location') {
    return { preference: 'last_location', specificIp: '' };
  }

  if (source === 'random' && isRecord(startingLocation)) {
    return {
      preference: startingLocation.gridSystemMode === 'grid2' || startingLocation.randomScope === 'grid2'
        ? 'random_grid2'
        : 'random_grid1',
      specificIp: '',
    };
  }

  if (source === 'user_preference' && isRecord(startingLocation) && typeof startingLocation.ipAddress === 'string') {
    return {
      preference: 'specific',
      specificIp: isValidIpv4(startingLocation.ipAddress) ? startingLocation.ipAddress : '',
    };
  }

  return { preference: 'default', specificIp: '' };
}

function getSpecificStartingLocation(ipAddress: string): MultiplayerStartingLocation {
  const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(ipAddress);
  return {
    gridSystemMode: 'grid1',
    source: 'user_preference',
    ipAddress,
    zoomLevel: 3,
    currentPosition: {
      firstOctet,
      secondOctet,
      thirdOctet,
      fourthOctet: 0,
    },
    x: fourthOctet % GRID_SIZE,
    y: Math.floor(fourthOctet / GRID_SIZE),
  };
}

function getStartingLocationForPreference(
  preference: StartingLocationPreference,
  specificIp: string,
  lastLocation?: PlayerLocation
): { source: MultiplayerStartingLocationSource; startingLocation: MultiplayerStartingLocation } {
  if (preference === 'last_location') {
    return {
      source: 'last_location',
      startingLocation: {
        source: 'last_location',
        lastLocation,
      },
    };
  }

  if (preference === 'random_grid1') {
    return {
      source: 'random',
      startingLocation: {
        gridSystemMode: 'grid1',
        source: 'random',
        randomScope: 'grid1',
      },
    };
  }

  if (preference === 'random_grid2') {
    return {
      source: 'random',
      startingLocation: {
        gridSystemMode: 'grid2',
        source: 'random',
        randomScope: 'grid2',
      },
    };
  }

  if (preference === 'specific') {
    return {
      source: 'user_preference',
      startingLocation: getSpecificStartingLocation(specificIp),
    };
  }

  return {
    source: 'default',
    startingLocation: getDefaultStartingLocation(),
  };
}

function getRandomGrid1StartingLocation(): MultiplayerStartingLocation {
  const zoomLevel = Math.floor(Math.random() * 4);
  const firstOctet = Math.floor(Math.random() * 256);
  const secondOctet = Math.floor(Math.random() * 256);
  const thirdOctet = Math.floor(Math.random() * 256);
  const fourthOctet = Math.floor(Math.random() * 256);
  const currentPosition = {
    firstOctet: zoomLevel >= 1 ? firstOctet : 0,
    secondOctet: zoomLevel >= 2 ? secondOctet : 0,
    thirdOctet: zoomLevel >= 3 ? thirdOctet : 0,
    fourthOctet: 0,
  };
  const visibleOctet =
    zoomLevel === 0 ? firstOctet :
    zoomLevel === 1 ? secondOctet :
    zoomLevel === 2 ? thirdOctet :
    fourthOctet;
  const ipAddress =
    zoomLevel === 0 ? `${firstOctet}.0.0.0` :
    zoomLevel === 1 ? `${firstOctet}.${secondOctet}.0.0` :
    zoomLevel === 2 ? `${firstOctet}.${secondOctet}.${thirdOctet}.0` :
    `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;

  return {
    gridSystemMode: 'grid1',
    source: 'user_preference',
    ipAddress,
    zoomLevel,
    currentPosition,
    x: visibleOctet % GRID_SIZE,
    y: Math.floor(visibleOctet / GRID_SIZE),
  };
}

function getRandomGrid2StartingLocation(): MultiplayerStartingLocation {
  const firstOctet = Math.floor(Math.random() * 256);
  const secondOctet = Math.floor(Math.random() * 256);
  const thirdOctet = Math.floor(Math.random() * 256);
  const fourthOctet = Math.floor(Math.random() * 256);
  const grid2Position = {
    outerFirstOctet: firstOctet,
    outerSecondOctet: secondOctet,
    innerThirdStart: clampGrid2WindowStart(Math.floor(thirdOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
    innerFourthStart: clampGrid2WindowStart(Math.floor(fourthOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
  };

  return {
    gridSystemMode: 'grid2',
    source: 'user_preference',
    ipAddress: `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`,
    grid2Position,
    x: fourthOctet - grid2Position.innerFourthStart,
    y: thirdOctet - grid2Position.innerThirdStart,
  };
}

function getValidPlayerLocation(value: unknown): PlayerLocation | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === 'ip' && typeof value.ipAddress === 'string' && isValidIpv4(value.ipAddress)) {
    return {
      kind: 'ip',
      ipAddress: value.ipAddress,
      x: typeof value.x === 'number' ? value.x : undefined,
      y: typeof value.y === 'number' ? value.y : undefined,
    };
  }

  if (value.kind === 'building' && typeof value.ipAddress === 'string' && isValidIpv4(value.ipAddress)) {
    return {
      kind: 'building',
      ipAddress: value.ipAddress,
      outside: true,
    };
  }

  return null;
}

function getStoredGridPosition(value: unknown): GridPosition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    firstOctet: typeof value.firstOctet === 'number' ? clampOctet(value.firstOctet) : 0,
    secondOctet: typeof value.secondOctet === 'number' ? clampOctet(value.secondOctet) : 0,
    thirdOctet: typeof value.thirdOctet === 'number' ? clampOctet(value.thirdOctet) : 0,
    fourthOctet: typeof value.fourthOctet === 'number' ? clampOctet(value.fourthOctet) : 0,
  };
}

function getStoredGrid2Position(value: unknown): Grid2Position | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    outerFirstOctet: typeof value.outerFirstOctet === 'number' ? clampOctet(value.outerFirstOctet) : DEFAULT_GRID2_POSITION.outerFirstOctet,
    outerSecondOctet: typeof value.outerSecondOctet === 'number' ? clampOctet(value.outerSecondOctet) : DEFAULT_GRID2_POSITION.outerSecondOctet,
    innerThirdStart: typeof value.innerThirdStart === 'number' ? clampGrid2WindowStart(value.innerThirdStart) : DEFAULT_GRID2_POSITION.innerThirdStart,
    innerFourthStart: typeof value.innerFourthStart === 'number' ? clampGrid2WindowStart(value.innerFourthStart) : DEFAULT_GRID2_POSITION.innerFourthStart,
  };
}

function getStoredBuildingView(value: unknown): BuildingViewState | null {
  if (!isRecord(value) || typeof value.ipAddress !== 'string' || !isValidIpv4(value.ipAddress)) {
    return null;
  }

  const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(value.ipAddress);
  return {
    x: typeof value.x === 'number' ? clampStreetCell(value.x) : fourthOctet % GRID_SIZE,
    y: typeof value.y === 'number' ? clampStreetCell(value.y) : thirdOctet % GRID_SIZE,
    ipAddress: value.ipAddress,
    label: typeof value.label === 'number' ? value.label : 0,
    color: typeof value.color === 'string' ? value.color : '#6B7280',
    buildingFamily:
      value.buildingFamily === 'tower' || value.buildingFamily === 'stepped' || value.buildingFamily === 'fort'
        ? value.buildingFamily
        : 'block',
    buildingHeight: typeof value.buildingHeight === 'number' ? value.buildingHeight : 1,
    flagImageUrl: typeof value.flagImageUrl === 'string' ? value.flagImageUrl : null,
    countryCodeLabel: typeof value.countryCodeLabel === 'string' ? value.countryCodeLabel : undefined,
    asn: typeof value.asn === 'string' ? value.asn : undefined,
    asnName: typeof value.asnName === 'string' ? value.asnName : undefined,
    route: typeof value.route === 'string' ? value.route : undefined,
    asnColor: typeof value.asnColor === 'string' ? value.asnColor : undefined,
    organizationName: typeof value.organizationName === 'string' ? value.organizationName : undefined,
  };
}

function getStoredLastLocation(value: unknown): StoredLastLocation | null {
  const directLocation = getValidPlayerLocation(value);
  if (directLocation) {
    return { playerLocation: directLocation, selectedIp: directLocation.ipAddress };
  }

  if (!isRecord(value)) {
    return null;
  }

  const playerLocation = getValidPlayerLocation(value.playerLocation);
  const selectedIp = typeof value.selectedIp === 'string' && isValidIpv4(value.selectedIp)
    ? value.selectedIp
    : playerLocation?.ipAddress;

  if (!playerLocation && !selectedIp) {
    return null;
  }

  return {
    gridSystemMode: value.gridSystemMode === 'grid2' ? 'grid2' : 'grid1',
    viewMode: value.viewMode === 'street' || value.viewMode === 'building' ? value.viewMode : 'grid',
    zoomLevel: typeof value.zoomLevel === 'number' ? value.zoomLevel : undefined,
    currentPosition: getStoredGridPosition(value.currentPosition),
    grid2Position: getStoredGrid2Position(value.grid2Position),
    playerLocation,
    selectedIp,
    streetPlayerX: typeof value.streetPlayerX === 'number' ? clampStreetCell(value.streetPlayerX) : undefined,
    streetPlayerY: typeof value.streetPlayerY === 'number' ? clampStreetCell(value.streetPlayerY) : undefined,
    streetHeading:
      value.streetHeading === 0 || value.streetHeading === 1 || value.streetHeading === 2 || value.streetHeading === 3
        ? value.streetHeading
        : undefined,
    streetTargetCell: isRecord(value.streetTargetCell) ? value.streetTargetCell as GridCellBuilding : null,
    streetFocusCell: isRecord(value.streetFocusCell) ? value.streetFocusCell as StreetFocusCell : null,
    buildingView: getStoredBuildingView(value.buildingView),
  };
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

function getVisibleCoordinateRangeLabel(
  gridSystemMode: GridSystemMode,
  zoomLevel: number,
  currentPosition: GridPosition,
  grid2Position: Grid2Position
): string {
  return `${getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, 0, 0)} to ${getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, GRID_SIZE - 1, GRID_SIZE - 1)}`;
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

  return { x: 7, y: 7 };
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
  return {
    kind: 'ip',
    ipAddress: getGridAwareIpFromCell(gridSystemMode, zoomLevel, currentPosition, grid2Position, x, y),
    x,
    y,
  };
}

function getEffectivePresenceLocationKey(presence: Pick<MultiplayerPresence, 'playerLocation' | 'selectedIp' | 'locationKey'>): string {
  const location = presence.playerLocation;
  if (location?.kind === 'ip') {
    return `ip:${location.ipAddress}`;
  }
  if (location?.kind === 'building') {
    return `building:${location.ipAddress}`;
  }
  if (presence.selectedIp) {
    return `ip:${presence.selectedIp}`;
  }

  const rawLocationMatch = presence.locationKey.match(/(?:^|:)(ip|building):([^:]+)/);
  return rawLocationMatch ? `${rawLocationMatch[1]}:${rawLocationMatch[2]}` : 'unknown';
}

function areUsersAtSameEffectiveLocation(
  localPresence: Pick<MultiplayerPresence, 'playerLocation' | 'selectedIp' | 'locationKey'>,
  remotePresence: Pick<MultiplayerPresence, 'playerLocation' | 'selectedIp' | 'locationKey'>
): boolean {
  const localLocationKey = getEffectivePresenceLocationKey(localPresence);
  const remoteLocationKey = getEffectivePresenceLocationKey(remotePresence);
  return localLocationKey !== 'unknown' && localLocationKey === remoteLocationKey;
}

function getStreetEntryForTargetCell(cell: GridCellBuilding): {
  playerX: number;
  playerY: number;
  heading: StreetHeading;
  focusCell: StreetFocusCell;
} {
  const targetX = clampStreetCell(cell.x);
  const targetY = clampStreetCell(cell.y);
  const candidates: Array<{ playerX: number; playerY: number; heading: StreetHeading }> = [
    { playerX: targetX, playerY: targetY + 1, heading: 0 },
    { playerX: targetX, playerY: targetY - 1, heading: 2 },
    { playerX: targetX + 1, playerY: targetY, heading: 3 },
    { playerX: targetX - 1, playerY: targetY, heading: 1 },
  ];
  const entry = candidates.find(
    (candidate) =>
      candidate.playerX >= 0 &&
      candidate.playerX < STREET_GRID_SIZE &&
      candidate.playerY >= 0 &&
      candidate.playerY < STREET_GRID_SIZE
  ) ?? { playerX: targetX, playerY: targetY, heading: 0 };

  return {
    ...entry,
    focusCell: { x: targetX, y: targetY },
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

function getStreetBuildingWorldPosition(x: number, y: number): { x: number; z: number } {
  return {
    x: clampStreetCell(x) * STREET_GRID_SPACING - STREET_GRID_OFFSET,
    z: clampStreetCell(y) * STREET_GRID_SPACING - STREET_GRID_OFFSET,
  };
}

function getFocusedStreetCameraPosition(focusCell: StreetFocusCell, heading: StreetHeading): { x: number; z: number } {
  const target = getStreetBuildingWorldPosition(focusCell.x, focusCell.y);

  if (heading === 0) {
    return { x: target.x, z: target.z + STREET_GRID_SPACING };
  }

  if (heading === 2) {
    return { x: target.x, z: target.z - STREET_GRID_SPACING };
  }

  if (heading === 1) {
    return { x: target.x - STREET_GRID_SPACING, z: target.z };
  }

  return { x: target.x + STREET_GRID_SPACING, z: target.z };
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
    const focusPosition = focusCell ? getStreetBuildingWorldPosition(focusCell.x, focusCell.y) : null;
    const cameraPosition = focusCell ? getFocusedStreetCameraPosition(focusCell, heading) : position;
    camera.up.set(0, 1, 0);
    camera.position.set(cameraPosition.x, 1.55, cameraPosition.z);
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
  const canvasDpr = useMemo(() => getCanvasDpr(), []);
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
  const [streetTargetCell, setStreetTargetCell] = useState<GridCellBuilding | null>(null);
  const [streetFocusCell, setStreetFocusCell] = useState<StreetFocusCell | null>(null);
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showWhoPanel, setShowWhoPanel] = useState(false);
  const [showBookmarksPanel, setShowBookmarksPanel] = useState(false);
  const [showLocationPreferencesPanel, setShowLocationPreferencesPanel] = useState(false);
  const [showStreetAndBuildingPanel, setShowStreetAndBuildingPanel] = useState(true);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [bookmarksStorageUserId, setBookmarksStorageUserId] = useState<string | null>(null);
  const [followedUserIds, setFollowedUserIds] = useState<string[]>([]);
  const [followStatus, setFollowStatus] = useState('');
  const [followedBookmarks, setFollowedBookmarks] = useState<SharedBookmarkEntry[]>([]);
  const [followedBookmarksStatus, setFollowedBookmarksStatus] = useState('');
  const [isFollowedBookmarksLoading, setIsFollowedBookmarksLoading] = useState(false);
  const [bookmarksSharingStatus, setBookmarksSharingStatus] = useState('');
  const [startingLocationPreference, setStartingLocationPreference] = useState<StartingLocationPreference>('default');
  const [specificStartingLocationIp, setSpecificStartingLocationIp] = useState('');
  const [startingLocationValidation, setStartingLocationValidation] = useState('');
  const [startingLocationStatus, setStartingLocationStatus] = useState('');
  const [isStartingLocationLoading, setIsStartingLocationLoading] = useState(false);
  const [isStartingLocationSaving, setIsStartingLocationSaving] = useState(false);
  const [isStartupPreferenceReady, setIsStartupPreferenceReady] = useState(false);

  const appContainerRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<any>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const currentHoverCellRef = useRef<GridCellBuilding | null>(null);
  const startupPreferenceAppliedRef = useRef(false);
  const lastLocationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocationPayloadKeyRef = useRef('');
  const latestPresenceRef = useRef<MultiplayerPresence | null>(null);
  const latestStoredLastLocationRef = useRef<StoredLastLocation | null>(null);
  const latestDefaultStartupStateRef = useRef(true);
  const publicWebAbortRef = useRef<AbortController | null>(null);
  const displayedHoverIpRef = useRef<string | null>(null);
  const lastNewHoveredIpRef = useRef<string | null>(null);
  const learnMoreButtonIpRef = useRef<string | null>(null);
  const [bottomInfoHtml, setBottomInfoHtml] = useState<string>('');
  const [displayedHoverIp, setDisplayedHoverIp] = useState<string | null>(null);
  const [publicWebContext, setPublicWebContext] = useState<PublicWebEnrichmentContext | null>(null);
  const [publicWebState, setPublicWebState] = useState<PublicWebEnrichmentState>({ status: 'default' });
  const [learnMoreButtonIp, setLearnMoreButtonIp] = useState<string | null>(null);
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
  const [avatarUploadStatus, setAvatarUploadStatus] = useState('');
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DomainSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);

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
  function applyPlayerLocation(nextLocation: PlayerLocation, options?: { selectedIp?: string }) {
    setPlayerLocation(nextLocation);

    const nextIp =
      options?.selectedIp ??
      (nextLocation.kind === 'ip' || nextLocation.kind === 'building'
        ? nextLocation.ipAddress
        : undefined);

    if (nextIp) {
      setSelectedTargetIp(nextIp);
    }
  }

  const playerLocationIp =
    playerLocation.kind === 'ip' || playerLocation.kind === 'building'
      ? playerLocation.ipAddress
      : activeTargetIp;
  const multiplayerGridKey = useMemo(
    () => getMultiplayerGridKey(gridSystemMode, zoomLevel, currentPosition, grid2Position),
    [gridSystemMode, zoomLevel, currentPosition, grid2Position]
  );
  const multiplayerViewMode = buildingView ? 'building' : layoutMode === 'street' ? 'street' : 'grid';
  const chatLocationKey = useMemo(
    () => getCanonicalChatLocationKey(playerLocation),
    [playerLocation]
  );
  const multiplayer = useMultiplayerPresence({
    gridKey: multiplayerGridKey,
    chatLocationKey,
    gridSystemMode,
    viewMode: multiplayerViewMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    pointerTarget,
    playerLocation,
    selectedIp: playerLocationIp,
  });
  latestPresenceRef.current = multiplayer.currentPresence;
  latestDefaultStartupStateRef.current =
    layoutMode === 'grid' &&
    !buildingView &&
    gridSystemMode === 'grid1' &&
    zoomLevel === 0 &&
    playerLocation.kind === 'ip' &&
    playerLocation.ipAddress === DEFAULT_STARTING_LOCATION_IP;

  const applyDefaultStartupLocation = () => {
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setGridSystemMode('grid1');
    setGrid2Position(DEFAULT_GRID2_POSITION);
    setZoomLevel(0);
    setCurrentPosition(DEFAULT_GRID_POSITION);
    applyPlayerLocation({
      kind: 'ip',
      ipAddress: DEFAULT_STARTING_LOCATION_IP,
      x: DEFAULT_PLAYER_CELL.x,
      y: DEFAULT_PLAYER_CELL.y,
    }, { selectedIp: DEFAULT_STARTING_LOCATION_IP });
  };

  const applyGrid1StartingLocation = (startingLocation: Extract<MultiplayerStartingLocation, { gridSystemMode: 'grid1' }>) => {
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setGridSystemMode('grid1');
    setGrid2Position(DEFAULT_GRID2_POSITION);
    setZoomLevel(startingLocation.zoomLevel);
    setCurrentPosition(startingLocation.currentPosition);
    applyPlayerLocation({
      kind: 'ip',
      ipAddress: startingLocation.ipAddress,
      x: startingLocation.x,
      y: startingLocation.y,
    }, { selectedIp: startingLocation.ipAddress });
  };

  const applyGrid2StartingLocation = (startingLocation: Extract<MultiplayerStartingLocation, { gridSystemMode: 'grid2' }>) => {
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setGridSystemMode('grid2');
    setGrid2Position(startingLocation.grid2Position);
    applyPlayerLocation({
      kind: 'ip',
      ipAddress: startingLocation.ipAddress,
      x: startingLocation.x,
      y: startingLocation.y,
    }, { selectedIp: startingLocation.ipAddress });
  };

  const applyStoredLastLocation = (storedLocation: StoredLastLocation | null): boolean => {
    const selectedIp = storedLocation?.selectedIp ?? storedLocation?.playerLocation?.ipAddress;
    if (!storedLocation || !selectedIp || !isValidIpv4(selectedIp)) {
      return false;
    }

    if (storedLocation.viewMode === 'building' && storedLocation.buildingView) {
      setGridSystemMode(storedLocation.gridSystemMode ?? 'grid1');
      if (storedLocation.grid2Position) {
        setGrid2Position(storedLocation.grid2Position);
      }
      if (typeof storedLocation.zoomLevel === 'number') {
        setZoomLevel(storedLocation.zoomLevel);
      }
      if (storedLocation.currentPosition) {
        setCurrentPosition(storedLocation.currentPosition);
      }
      setLayoutMode('street');
      setShowStreetAndBuildingPanel(true);
      setStreetPlayerX(storedLocation.streetPlayerX ?? storedLocation.buildingView.x);
      setStreetPlayerY(storedLocation.streetPlayerY ?? storedLocation.buildingView.y);
      setStreetHeading(storedLocation.streetHeading ?? 0);
      setStreetTargetCell(storedLocation.streetTargetCell ?? null);
      setStreetFocusCell(storedLocation.streetFocusCell ?? null);
      setBuildingView(storedLocation.buildingView);
      applyPlayerLocation({ kind: 'building', ipAddress: storedLocation.buildingView.ipAddress, outside: true }, { selectedIp: storedLocation.buildingView.ipAddress });
      return true;
    }

    if (storedLocation.viewMode === 'street' && storedLocation.playerLocation) {
      setGridSystemMode(storedLocation.gridSystemMode ?? 'grid1');
      if (storedLocation.grid2Position) {
        setGrid2Position(storedLocation.grid2Position);
      }
      if (typeof storedLocation.zoomLevel === 'number') {
        setZoomLevel(storedLocation.zoomLevel);
      }
      if (storedLocation.currentPosition) {
        setCurrentPosition(storedLocation.currentPosition);
      }
      setLayoutMode('street');
      setShowStreetAndBuildingPanel(true);
      setBuildingView(null);
      setStreetPlayerX(storedLocation.streetPlayerX ?? storedLocation.playerLocation.x ?? DEFAULT_PLAYER_CELL.x);
      setStreetPlayerY(storedLocation.streetPlayerY ?? storedLocation.playerLocation.y ?? DEFAULT_PLAYER_CELL.y);
      setStreetHeading(storedLocation.streetHeading ?? 0);
      setStreetTargetCell(storedLocation.streetTargetCell ?? null);
      setStreetFocusCell(storedLocation.streetFocusCell ?? null);
      applyPlayerLocation(storedLocation.playerLocation, { selectedIp });
      return true;
    }

    moveToIpLocation(
      selectedIp,
      storedLocation.playerLocation?.kind === 'building' ? 'building' : 'ip',
      storedLocation.gridSystemMode ?? 'grid1'
    );
    return true;
  };

  const applySavedStartingLocation = (
    source: unknown,
    startingLocation: unknown,
    lastLocation: unknown
  ) => {
    if (source === 'user_preference' && isRecord(startingLocation) && typeof startingLocation.ipAddress === 'string' && isValidIpv4(startingLocation.ipAddress)) {
      moveToIpLocation(startingLocation.ipAddress, 'ip', startingLocation.gridSystemMode === 'grid2' ? 'grid2' : 'grid1');
      return;
    }

    if (source === 'random' && isRecord(startingLocation) && (startingLocation.gridSystemMode === 'grid2' || startingLocation.randomScope === 'grid2')) {
      applyGrid2StartingLocation(getRandomGrid2StartingLocation() as Extract<MultiplayerStartingLocation, { gridSystemMode: 'grid2' }>);
      return;
    }

    if (source === 'random') {
      applyGrid1StartingLocation(getRandomGrid1StartingLocation() as Extract<MultiplayerStartingLocation, { gridSystemMode: 'grid1' }>);
      return;
    }

    if (source === 'last_location') {
      if (!applyStoredLastLocation(getStoredLastLocation(lastLocation))) {
        applyDefaultStartupLocation();
      }
      return;
    }

    applyDefaultStartupLocation();
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    handleFullscreenChange();
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);
  useEffect(() => {
    setDisplayNameDraft(multiplayer.currentUser.displayName);
  }, [multiplayer.currentUser.displayName]);
  useEffect(() => {
    setBookmarks(readStoredBookmarks(multiplayer.currentUser.userId));
    setBookmarksStorageUserId(multiplayer.currentUser.userId);
  }, [multiplayer.currentUser.userId]);
  useEffect(() => {
    if (bookmarksStorageUserId !== multiplayer.currentUser.userId) {
      return;
    }
    writeStoredBookmarks(multiplayer.currentUser.userId, bookmarks);
  }, [bookmarks, bookmarksStorageUserId, multiplayer.currentUser.userId]);
  useEffect(() => {
    if (!supabase || !isSupabaseConfigured || bookmarksStorageUserId !== multiplayer.currentUser.userId || bookmarks.length === 0) {
      return;
    }

    let isActive = true;
    const rows = bookmarks
      .filter((bookmark) => isValidIpv4(bookmark.ipAddress))
      .map((bookmark) => ({
        user_id: multiplayer.currentUser.userId,
        ip_address: bookmark.ipAddress,
        organization_name: bookmark.organizationName ?? null,
        note: bookmark.note,
      }));

    if (rows.length === 0) {
      return;
    }

    void supabase
      .from('user_bookmarks')
      .upsert(rows, { onConflict: 'user_id,ip_address' })
      .then(({ error }) => {
        if (!isActive) {
          return;
        }
        setBookmarksSharingStatus(error ? 'Could not share saved locations.' : '');
      });

    return () => {
      isActive = false;
    };
  }, [bookmarks, bookmarksStorageUserId, multiplayer.currentUser.userId]);
  useEffect(() => {
    setFollowStatus('');
    setFollowedUserIds([]);

    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    let isActive = true;
    void supabase
      .from('user_follows')
      .select('followed_user_id')
      .eq('follower_user_id', multiplayer.currentUser.userId)
      .then(({ data, error }) => {
        if (!isActive) {
          return;
        }
        if (error) {
          setFollowStatus('Could not load follows.');
          return;
        }

        const nextFollowedUserIds = Array.from(new Set(
          (data ?? [])
            .map((row) => typeof row.followed_user_id === 'string' ? row.followed_user_id : '')
            .filter(Boolean)
        ));
        setFollowedUserIds(nextFollowedUserIds);
      });

    return () => {
      isActive = false;
    };
  }, [multiplayer.currentUser.userId]);
  useEffect(() => {
    setFollowedBookmarksStatus('');
    setFollowedBookmarks([]);

    if (!supabase || !isSupabaseConfigured || followedUserIds.length === 0) {
      setIsFollowedBookmarksLoading(false);
      return;
    }

    if (!showBookmarksPanel) {
      return;
    }

    let isActive = true;
    setIsFollowedBookmarksLoading(true);
    void supabase
      .from('user_bookmarks')
      .select('user_id, ip_address, organization_name, note, updated_at')
      .in('user_id', followedUserIds)
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => {
        if (!isActive) {
          return;
        }
        setIsFollowedBookmarksLoading(false);
        if (error) {
          setFollowedBookmarksStatus('Could not load followed users saved locations.');
          return;
        }

        setFollowedBookmarks(((data ?? []) as UserBookmarkRow[])
          .filter((row) => typeof row.ip_address === 'string' && isValidIpv4(row.ip_address))
          .map((row) => ({
            userId: row.user_id,
            ipAddress: row.ip_address,
            organizationName: row.organization_name?.trim() || undefined,
            note: row.note ?? '',
            updatedAt: row.updated_at ?? undefined,
          })));
      });

    return () => {
      isActive = false;
    };
  }, [followedUserIds, showBookmarksPanel]);
  useEffect(() => {
    if (startupPreferenceAppliedRef.current) {
      return;
    }

    if (!supabase || !isSupabaseConfigured) {
      startupPreferenceAppliedRef.current = true;
      setIsStartupPreferenceReady(true);
      return;
    }

    let isActive = true;
    startupPreferenceAppliedRef.current = true;

    void (async () => {
      const [{ data: preferenceData, error: preferenceError }, { data: lastLocationData }] = await Promise.all([
        supabase
          .from('multiplayer_presence')
          .select('starting_location, starting_location_source, last_location')
          .eq('user_id', multiplayer.currentUser.userId)
          .not('starting_location_source', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1),
        supabase
          .from('multiplayer_presence')
          .select('last_location')
          .eq('user_id', multiplayer.currentUser.userId)
          .not('last_location', 'is', null)
          .order('last_location_recorded_at', { ascending: false })
          .limit(1),
      ]);

      if (!isActive) {
        return;
      }

      if (!latestDefaultStartupStateRef.current) {
        setIsStartupPreferenceReady(true);
        return;
      }

      if (preferenceError) {
        applyDefaultStartupLocation();
        setIsStartupPreferenceReady(true);
        return;
      }

      const preferenceRow = Array.isArray(preferenceData) ? preferenceData[0] : undefined;
      const lastLocationRow = Array.isArray(lastLocationData) ? lastLocationData[0] : undefined;
      applySavedStartingLocation(
        preferenceRow?.starting_location_source,
        preferenceRow?.starting_location,
        lastLocationRow?.last_location ?? preferenceRow?.last_location
      );
      setIsStartupPreferenceReady(true);
    })();

    return () => {
      isActive = false;
    };
  }, [multiplayer.currentUser.userId]);
  useEffect(() => {
    if (!showLocationPreferencesPanel) {
      return;
    }

    setStartingLocationPreference('default');
    setSpecificStartingLocationIp('');
    setStartingLocationValidation('');
    setStartingLocationStatus('');

    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    let isActive = true;
    setIsStartingLocationLoading(true);

    void (async () => {
      const { data, error } = await supabase
        .from('multiplayer_presence')
        .select('starting_location, starting_location_source')
        .eq('user_id', multiplayer.currentUser.userId)
        .not('starting_location_source', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (!isActive) {
        return;
      }

      setIsStartingLocationLoading(false);

      if (error) {
        setStartingLocationValidation('Could not load saved preference.');
        return;
      }

      const row = Array.isArray(data) ? data[0] : undefined;
      const saved = readStartingLocationPreference(
        row?.starting_location_source,
        row?.starting_location
      );
      setStartingLocationPreference(saved.preference);
      setSpecificStartingLocationIp(saved.specificIp);
    })();

    return () => {
      isActive = false;
    };
  }, [showLocationPreferencesPanel, multiplayer.currentUser.userId]);
  useEffect(() => {
    setPointerTarget(undefined);
    currentHoverCellRef.current = null;
    displayedHoverIpRef.current = null;
    lastNewHoveredIpRef.current = null;
    learnMoreButtonIpRef.current = null;
    setDisplayedHoverIp(null);
    setLearnMoreButtonIp(null);
  }, [multiplayerGridKey]);

  useEffect(() => {
    if (layoutMode !== 'grid' || buildingView) {
      currentHoverCellRef.current = null;
      displayedHoverIpRef.current = null;
      lastNewHoveredIpRef.current = null;
      learnMoreButtonIpRef.current = null;
      setDisplayedHoverIp(null);
      setLearnMoreButtonIp(null);
    }
  }, [layoutMode, buildingView]);

  useEffect(() => {
    if (layoutMode !== 'street' || buildingView) {
      return;
    }

    if (streetTargetCell) {
      applyPlayerLocation({
        kind: 'ip',
        ipAddress: streetTargetCell.ipAddress,
        x: clampStreetCell(streetTargetCell.x),
        y: clampStreetCell(streetTargetCell.y),
      });
    } else {
      applyPlayerLocation(getPlayerLocationForStreetPosition(
        streetPlayerX,
        streetPlayerY,
        gridSystemMode,
        zoomLevel,
        currentPosition,
        grid2Position
      ));
    }
  }, [
    layoutMode,
    buildingView,
    streetPlayerX,
    streetPlayerY,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    streetTargetCell,
  ]);

  const websiteCandidate = useMemo(
    () => getWebsiteCandidate(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );
  const buildingDirectoryEntries = useMemo(
    () => getBuildingDirectoryEntries(exposureResult, certificateResult),
    [exposureResult, certificateResult]
  );

  const moveToIpLocation = (ipAddress: string, kind: 'ip' | 'building' = 'ip', targetGridSystemMode: GridSystemMode = gridSystemMode) => {
    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(ipAddress);
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setGridSystemMode(targetGridSystemMode);
    if (targetGridSystemMode === 'grid2') {
      const nextGrid2Position = {
        outerFirstOctet: firstOctet,
        outerSecondOctet: secondOctet,
        innerThirdStart: clampGrid2WindowStart(Math.floor(thirdOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
        innerFourthStart: clampGrid2WindowStart(Math.floor(fourthOctet / GRID2_WINDOW_SIZE) * GRID2_WINDOW_SIZE),
      };
      const x = fourthOctet - nextGrid2Position.innerFourthStart;
      const y = thirdOctet - nextGrid2Position.innerThirdStart;
      setGrid2Position(nextGrid2Position);
      applyPlayerLocation(
        kind === 'building' ? { kind: 'building', ipAddress, outside: true } : { kind: 'ip', ipAddress, x, y },
        { selectedIp: ipAddress }
      );
      return;
    }

    setGrid2Position(DEFAULT_GRID2_POSITION);
    setZoomLevel(3);
    setCurrentPosition({
      firstOctet,
      secondOctet,
      thirdOctet,
      fourthOctet: 0,
    });
    applyPlayerLocation(
      kind === 'building'
        ? { kind: 'building', ipAddress, outside: true }
        : {
            kind: 'ip',
            ipAddress,
            x: fourthOctet % 16,
            y: Math.floor(fourthOctet / 16),
          },
      { selectedIp: ipAddress }
    );
  };

  const normalizeSearchResults = (value: unknown): DomainSearchResult[] => {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { results?: unknown }).results)) {
      return [];
    }

    return (value as { results: unknown[] }).results
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => {
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        const ip = typeof item.ip === 'string' ? item.ip.trim() : '';
        if (!label || !isValidIpv4(ip)) {
          return null;
        }
        return {
          label,
          ip,
          domain: typeof item.domain === 'string' && item.domain.trim() ? item.domain.trim() : undefined,
          source: typeof item.source === 'string' && item.source.trim() ? item.source.trim() : undefined,
          description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined,
        } satisfies DomainSearchResult;
      })
      .filter((item): item is DomainSearchResult => Boolean(item));
  };

  const runDomainSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      return;
    }

    setSearchLoading(true);
    setSearchError('');
    setSearchResults([]);
    setShowSearchOverlay(true);

    try {
      const response = await fetch(`/api/domain-search?q=${encodeURIComponent(query)}`);
      const json = await response.json();
      if (!response.ok) {
        const message = json && typeof json.error === 'string' ? json.error : 'Search failed.';
        throw new Error(message);
      }
      setSearchResults(normalizeSearchResults(json));
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchResultClick = (result: DomainSearchResult) => {
    if (!isValidIpv4(result.ip)) {
      setSearchError('Search returned an invalid IPv4 address.');
      setShowSearchOverlay(true);
      return;
    }

    setShowSearchOverlay(false);
    setSearchError('');
    moveToIpLocation(result.ip, 'ip');
  };

  const getPresenceIpLocation = (user: MultiplayerPresence): string | null => {
    if (user.playerLocation?.kind === 'ip' || user.playerLocation?.kind === 'building') {
      return user.playerLocation.ipAddress;
    }
    if (user.selectedIp && isValidIpv4(user.selectedIp)) {
      return user.selectedIp;
    }
    return null;
  };

  const handleRemoteUserClick = (user: MultiplayerPresence) => {
    const location = user.playerLocation;
    const fallbackIp = getPresenceIpLocation(user);
    if (!location) {
      if (fallbackIp) {
        moveToIpLocation(fallbackIp, 'ip');
      }
      return;
    }

    if (location.kind === 'ip') {
      moveToIpLocation(location.ipAddress, 'ip');
      return;
    }

    if (location.kind === 'building') {
      moveToIpLocation(location.ipAddress, 'building');
    }
  };

  const handleToggleFollowUser = (user: MultiplayerPresence) => {
    if (!supabase || !isSupabaseConfigured || user.userId === multiplayer.currentUser.userId) {
      return;
    }

    const isFollowing = followedUserIds.includes(user.userId);
    setFollowStatus('');
    setFollowedUserIds((current) => (
      isFollowing
        ? current.filter((userId) => userId !== user.userId)
        : Array.from(new Set([...current, user.userId]))
    ));

    const request = isFollowing
      ? supabase
        .from('user_follows')
        .delete()
        .eq('follower_user_id', multiplayer.currentUser.userId)
        .eq('followed_user_id', user.userId)
      : supabase
        .from('user_follows')
        .insert({
          follower_user_id: multiplayer.currentUser.userId,
          followed_user_id: user.userId,
        });

    void request.then(({ error }) => {
      if (!error) {
        return;
      }
      setFollowStatus(isFollowing ? 'Could not unfollow user.' : 'Could not follow user.');
      setFollowedUserIds((current) => (
        isFollowing
          ? Array.from(new Set([...current, user.userId]))
          : current.filter((userId) => userId !== user.userId)
      ));
    });
  };

  const getCurrentBookmarkOrganizationName = (): string | undefined => {
    const matchingCells = [
      currentHoverCellRef.current,
      streetTargetCell,
      buildingView,
    ];
    const matchingCell = matchingCells.find((cell) => cell?.ipAddress === playerLocationIp);
    return matchingCell?.organizationName?.trim() || undefined;
  };

  const handleAddBookmark = () => {
    if (!isValidIpv4(playerLocationIp)) {
      return;
    }

    const organizationName = getCurrentBookmarkOrganizationName();
    setBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.ipAddress === playerLocationIp);
      if (existing) {
        if (!existing.organizationName && organizationName) {
          return current.map((bookmark) => (
            bookmark.ipAddress === playerLocationIp ? { ...bookmark, organizationName } : bookmark
          ));
        }
        return current;
      }
      return [...current, { ipAddress: playerLocationIp, organizationName, note: '' }];
    });
  };

  const handleBookmarkClick = (bookmark: BookmarkEntry) => {
    moveToIpLocation(bookmark.ipAddress, 'ip');
  };

  const handleBookmarkNoteChange = (ipAddress: string, note: string) => {
    setBookmarks((current) => current.map((bookmark) => (
      bookmark.ipAddress === ipAddress ? { ...bookmark, note } : bookmark
    )));
  };

  const handleSaveStartingLocationPreference = () => {
    const specificIp = specificStartingLocationIp.trim();
    setStartingLocationValidation('');
    setStartingLocationStatus('');

    if (startingLocationPreference === 'specific' && !isValidIpv4(specificIp)) {
      setStartingLocationValidation('Enter a valid IPv4 address.');
      return;
    }

    if (!supabase || !isSupabaseConfigured) {
      setStartingLocationValidation('Could not save preference.');
      return;
    }

    const { source, startingLocation } = getStartingLocationForPreference(
      startingLocationPreference,
      specificIp,
      playerLocation
    );
    const currentPresence = multiplayer.currentPresence;
    const now = new Date().toISOString();

    setIsStartingLocationSaving(true);
    void (async () => {
      const { error } = await supabase
        .from('multiplayer_presence')
        .upsert({
          presence_id: currentPresence.presenceId,
          session_id: currentPresence.sessionId,
          user_id: currentPresence.userId,
          display_name: currentPresence.displayName,
          color: currentPresence.color,
          avatar_url: currentPresence.avatarUrl ?? null,
          avatar_type: currentPresence.avatarType ?? 'default',
          location_key: currentPresence.locationKey,
          grid_system_mode: currentPresence.gridSystemMode,
          view_mode: currentPresence.viewMode,
          zoom_level: currentPresence.zoomLevel,
          current_position: currentPresence.currentPosition,
          grid2_position: currentPresence.grid2Position,
          player_location: currentPresence.playerLocation ?? null,
          pointer_target: currentPresence.pointerTarget ?? null,
          hovered_cell: currentPresence.hoveredCell ?? null,
          selected_ip: currentPresence.selectedIp ?? null,
          chat_location_key: currentPresence.chatLocationKey ?? null,
          last_seen: now,
          starting_location: startingLocation,
          starting_location_source: source,
          last_location: currentStoredLastLocation,
          last_location_recorded_at: now,
        }, { onConflict: 'presence_id' });

      setIsStartingLocationSaving(false);

      if (error) {
        setStartingLocationValidation('Could not save preference.');
        return;
      }

      setSpecificStartingLocationIp(specificIp);
      setStartingLocationStatus('Saved');
    })();
  };

  const loadStreetTargetDetails = (target: { ipAddress: string }) => {
    setCertificateLoadingIp(target.ipAddress);
    setExposureLoadingIp(target.ipAddress);
    setCertificateResult(null);
    setExposureResult(null);
    setSshLaunchLoadingIp(null);
    setSshLaunchResult(null);

    void (async () => {
      try {
        const response = await fetch(`/api/https-certificate?ip=${encodeURIComponent(target.ipAddress)}`);
        const json = (await response.json()) as HttpsCertificateResponse & { details?: string };

        if (!response.ok) {
          setCertificateResult({
            provider: 'https_certificate',
            ipAddress: target.ipAddress,
            status: 'error',
            host: target.ipAddress,
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
          ipAddress: target.ipAddress,
          status: 'error',
          host: target.ipAddress,
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
          body: JSON.stringify({ ipAddresses: [target.ipAddress] }),
        });
        const json = (await response.json()) as { records?: ExposureRecord[]; error?: string; details?: string };

        if (!response.ok) {
          setExposureResult({
            ipAddress: target.ipAddress,
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
          ipAddress: target.ipAddress,
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
          ipAddress: target.ipAddress,
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

  const enterStreetAtCell = (cell: GridCellBuilding) => {
    const entry = getStreetEntryForTargetCell(cell);
    setBuildingView(null);
    setLayoutMode('street');
    setShowStreetAndBuildingPanel(true);
    setStreetTargetCell(cell);
    setStreetFocusCell(entry.focusCell);
    setStreetPlayerX(entry.playerX);
    setStreetPlayerY(entry.playerY);
    setStreetHeading(entry.heading);
    applyPlayerLocation({
      kind: 'ip',
      ipAddress: cell.ipAddress,
      x: clampStreetCell(cell.x),
      y: clampStreetCell(cell.y),
    }, { selectedIp: cell.ipAddress });
    loadStreetTargetDetails(cell);
  };

  const handleGridCellClick = (cell: GridCellBuilding) => {
    const targetCell =
      layoutMode === 'grid' && !buildingView && currentHoverCellRef.current
        ? currentHoverCellRef.current
        : cell;

    applyPlayerLocation({
      kind: 'ip',
      ipAddress: targetCell.ipAddress,
      x: targetCell.x,
      y: targetCell.y,
    }, { selectedIp: targetCell.ipAddress });
  };

  const handleEnterStreetViewFromMenu = () => {
    if (playerLocation.kind !== 'ip') {
      return;
    }

    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(playerLocation.ipAddress);
    const x = gridSystemMode === 'grid2'
      ? fourthOctet - grid2Position.innerFourthStart
      : zoomLevel === 0
        ? firstOctet % GRID_SIZE
        : zoomLevel === 1
          ? secondOctet % GRID_SIZE
          : zoomLevel === 2
            ? thirdOctet % GRID_SIZE
            : fourthOctet % GRID_SIZE;
    const y = gridSystemMode === 'grid2'
      ? thirdOctet - grid2Position.innerThirdStart
      : zoomLevel === 0
        ? Math.floor(firstOctet / GRID_SIZE)
        : zoomLevel === 1
          ? Math.floor(secondOctet / GRID_SIZE)
          : zoomLevel === 2
            ? Math.floor(thirdOctet / GRID_SIZE)
            : Math.floor(fourthOctet / GRID_SIZE);

    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
      return;
    }

    enterStreetAtCell({
      x,
      y,
      ipAddress: playerLocation.ipAddress,
      label: y * GRID_SIZE + x,
      color: getIPColor(firstOctet, secondOctet, thirdOctet, fourthOctet),
      buildingFamily: 'block',
      buildingHeight: 1,
    });
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
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setStreetPlayerX(nextX);
    setStreetPlayerY(nextY);
    applyPlayerLocation(nextLocation, { selectedIp: ipAddress ?? nextLocation.ipAddress });
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
    setStreetFocusCell(null);
    setStreetHeading((prev) => ((prev + delta + 4) % 4) as StreetHeading);
  };

  const handleStreetCellClick = (cell: GridCellBuilding) => {
    updateStreetPlayerPosition(cell.x, cell.y, cell.ipAddress);
  };

  const handleStreetBuildingClick = (cell: GridCellBuilding) => {
    handleEnterBuildingView(cell);
  };

  const handleCellDoubleClick = (cell: GridCellBuilding) => {
    void cell;
  };

  const handleGrid1OctetUp = () => {
    if (layoutMode !== 'grid' || buildingView || gridSystemMode !== 'grid1' || zoomLevel === 0) {
      return;
    }

    handleBack();
  };

  const handleGrid1OctetDown = () => {
    if (layoutMode !== 'grid' || buildingView || gridSystemMode !== 'grid1' || zoomLevel >= 3 || !isValidIpv4(playerLocationIp)) {
      return;
    }

    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = parseIpOctets(playerLocationIp);

    if (zoomLevel === 0) {
      setCurrentPosition({ firstOctet, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
      setZoomLevel(1);
      applyPlayerLocation({
        kind: 'ip',
        ipAddress: playerLocationIp,
        x: secondOctet % GRID_SIZE,
        y: Math.floor(secondOctet / GRID_SIZE),
      }, { selectedIp: playerLocationIp });
    } else if (zoomLevel === 1) {
      setCurrentPosition((prev) => ({ ...prev, secondOctet, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(2);
      applyPlayerLocation({
        kind: 'ip',
        ipAddress: playerLocationIp,
        x: thirdOctet % GRID_SIZE,
        y: Math.floor(thirdOctet / GRID_SIZE),
      }, { selectedIp: playerLocationIp });
    } else if (zoomLevel === 2) {
      setCurrentPosition((prev) => ({ ...prev, thirdOctet, fourthOctet: 0 }));
      setZoomLevel(3);
      applyPlayerLocation({
        kind: 'ip',
        ipAddress: playerLocationIp,
        x: fourthOctet % GRID_SIZE,
        y: Math.floor(fourthOctet / GRID_SIZE),
      }, { selectedIp: playerLocationIp });
    }
  };

  const handleToggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    const fullscreenTarget = appContainerRef.current ?? document.documentElement;
    void fullscreenTarget.requestFullscreen();
  };

  const handleBack = () => {
    if (layoutMode === 'street') {
      const nextLocation = streetTargetCell
        ? {
            kind: 'ip' as const,
            ipAddress: streetTargetCell.ipAddress,
            x: clampStreetCell(streetTargetCell.x),
            y: clampStreetCell(streetTargetCell.y),
          }
        : getPlayerLocationForGridCell(
            gridSystemMode,
            zoomLevel,
            currentPosition,
            grid2Position,
            streetPlayerX,
            streetPlayerY
          );
      applyPlayerLocation(nextLocation);
      setBuildingView(null);
      setLayoutMode('grid');
      setStreetTargetCell(null);
      setStreetFocusCell(null);
      return;
    }

    if (gridSystemMode === 'grid2') {
      return;
    }

    if (zoomLevel === 1) {
      const nextLocation = { kind: 'ip' as const, ipAddress: `${currentPosition.firstOctet}.0.0.0`, x: currentPosition.firstOctet % GRID_SIZE, y: Math.floor(currentPosition.firstOctet / GRID_SIZE) };
      setCurrentPosition({ firstOctet: 0, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
      setZoomLevel(0);
      applyPlayerLocation(nextLocation);
      return;
    }

    if (zoomLevel === 2) {
      const nextLocation = { kind: 'ip' as const, ipAddress: `${currentPosition.firstOctet}.${currentPosition.secondOctet}.0.0`, x: currentPosition.secondOctet % GRID_SIZE, y: Math.floor(currentPosition.secondOctet / GRID_SIZE) };
      setCurrentPosition((prev) => ({ ...prev, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(1);
      applyPlayerLocation(nextLocation);
      return;
    }

    if (zoomLevel === 3) {
      const nextLocation = { kind: 'ip' as const, ipAddress: `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0`, x: currentPosition.thirdOctet % GRID_SIZE, y: Math.floor(currentPosition.thirdOctet / GRID_SIZE) };
      setCurrentPosition((prev) => ({ ...prev, thirdOctet: 0, fourthOctet: 0 }));
      setZoomLevel(2);
      applyPlayerLocation(nextLocation);
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
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setZoomLevel(0);
    setCurrentPosition(DEFAULT_GRID_POSITION);
    setGrid2Position(DEFAULT_GRID2_POSITION);
    applyPlayerLocation(nextPlayerLocation);
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
    setGridSystemMode(mode);
    if (mode === 'grid2') {
      setGrid2Position(DEFAULT_GRID2_POSITION);
    }
    setLayoutMode('grid');
    setBuildingView(null);
    setStreetTargetCell(null);
    setStreetFocusCell(null);
    setBottomInfoHtml('');
    applyPlayerLocation(nextPlayerLocation, {
      selectedIp: nextPlayerLocation.kind === 'ip'
        ? nextPlayerLocation.ipAddress
        : mode === 'grid2'
          ? getGrid2IpFromCell(nextGrid2Position, nextPlayerCell.x, nextPlayerCell.y)
          : getRepresentativeTarget('grid1', zoomLevel, currentPosition, nextGrid2Position),
    });
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
      applyPlayerLocation(nextPlayerLocation);
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
        const nextDisplayedHoverIp = currentHoverCellRef.current?.ipAddress ?? displayedHoverIpRef.current;
        setBottomInfoHtml(activeHtml);
        displayedHoverIpRef.current = nextDisplayedHoverIp;
        setDisplayedHoverIp(nextDisplayedHoverIp);
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


  const handleEnterBuildingView = (building: BuildingViewState) => {
    setBuildingView(building);
    setStreetTargetCell(building);
    setStreetFocusCell({ x: clampStreetCell(building.x), y: clampStreetCell(building.y) });
    applyPlayerLocation({ kind: 'building', ipAddress: building.ipAddress, outside: true });
    loadStreetTargetDetails(building);
  };

  const handleExitBuildingView = () => {
    setBuildingView(null);
    setStreetFocusCell(streetTargetCell ? { x: clampStreetCell(streetTargetCell.x), y: clampStreetCell(streetTargetCell.y) } : null);
    setCertificateLoadingIp(null);
    setExposureLoadingIp(null);
    setSshLaunchLoadingIp(null);
    setSshLaunchResult(null);
  };

  const handleLaunchSsh = async () => {
    const target = buildingView ?? streetTargetCell;
    if (!target) {
      return;
    }

    setSshLaunchLoadingIp(target.ipAddress);
    setSshLaunchResult(null);

    try {
      const response = await fetch(`/api/launch-ssh?ip=${encodeURIComponent(target.ipAddress)}`, {
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
          ipAddress: target.ipAddress,
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
        ipAddress: target.ipAddress,
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
  const visibleCoordinateRangeLabel = getVisibleCoordinateRangeLabel(
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position
  );
  const multiplayerStatusLabel = multiplayer.isConfigured
    ? multiplayer.status === 'error'
      ? 'Offline'
      : multiplayer.status.charAt(0).toUpperCase() + multiplayer.status.slice(1)
    : 'Offline';
  const nearbyUsers = useMemo(
    () => multiplayer.others.filter((user) => areUsersAtSameEffectiveLocation(multiplayer.currentPresence, user)),
    [multiplayer.currentPresence, multiplayer.others]
  );
  const avatarUsers = useMemo(
    () => [multiplayer.currentPresence, ...multiplayer.others],
    [multiplayer.currentPresence, multiplayer.others]
  );
  const whoPanelUsers = avatarUsers;
  const followedUserIdSet = useMemo(() => new Set(followedUserIds), [followedUserIds]);
  const followedUserDisplayNames = useMemo(() => {
    const displayNames = new Map<string, string>();
    avatarUsers.forEach((user) => {
      const displayName = user.displayName?.trim();
      if (displayName) {
        displayNames.set(user.userId, displayName);
      }
    });
    return displayNames;
  }, [avatarUsers]);
  const showGridSidePanel = showWhoPanel || showBookmarksPanel || showLocationPreferencesPanel;
  const currentStoredLastLocation = useMemo<StoredLastLocation>(() => ({
    gridSystemMode,
    viewMode: multiplayerViewMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    playerLocation,
    selectedIp: playerLocationIp,
    streetPlayerX,
    streetPlayerY,
    streetHeading,
    streetTargetCell,
    streetFocusCell,
    buildingView,
  }), [
    gridSystemMode,
    multiplayerViewMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    playerLocation,
    playerLocationIp,
    streetPlayerX,
    streetPlayerY,
    streetHeading,
    streetTargetCell,
    streetFocusCell,
    buildingView,
  ]);
  const currentStoredLastLocationKey = useMemo(
    () => JSON.stringify(currentStoredLastLocation),
    [currentStoredLastLocation]
  );
  latestStoredLastLocationRef.current = currentStoredLastLocation;

  const saveLastLocation = (storedLocation: StoredLastLocation | null) => {
    const currentPresence = latestPresenceRef.current;
    const selectedIp = storedLocation?.selectedIp ?? storedLocation?.playerLocation?.ipAddress;
    if (!supabase || !isSupabaseConfigured || !currentPresence || !storedLocation || !selectedIp || !isValidIpv4(selectedIp)) {
      return;
    }

    const now = new Date().toISOString();
    void supabase
      .from('multiplayer_presence')
      .upsert({
        presence_id: currentPresence.presenceId,
        session_id: currentPresence.sessionId,
        user_id: currentPresence.userId,
        display_name: currentPresence.displayName,
        color: currentPresence.color,
        avatar_url: currentPresence.avatarUrl ?? null,
        avatar_type: currentPresence.avatarType ?? 'default',
        location_key: currentPresence.locationKey,
        grid_system_mode: currentPresence.gridSystemMode,
        view_mode: currentPresence.viewMode,
        zoom_level: currentPresence.zoomLevel,
        current_position: currentPresence.currentPosition,
        grid2_position: currentPresence.grid2Position,
        player_location: currentPresence.playerLocation ?? null,
        pointer_target: currentPresence.pointerTarget ?? null,
        hovered_cell: currentPresence.hoveredCell ?? null,
        selected_ip: currentPresence.selectedIp ?? selectedIp,
        chat_location_key: currentPresence.chatLocationKey ?? null,
        last_seen: now,
        last_location: storedLocation,
        last_location_recorded_at: now,
      }, { onConflict: 'presence_id' });
  };

  useEffect(() => {
    if (!isStartupPreferenceReady || !supabase || !isSupabaseConfigured) {
      return;
    }

    if (lastLocationPayloadKeyRef.current === currentStoredLastLocationKey) {
      return;
    }

    lastLocationPayloadKeyRef.current = currentStoredLastLocationKey;
    if (lastLocationSaveTimerRef.current) {
      clearTimeout(lastLocationSaveTimerRef.current);
    }
    lastLocationSaveTimerRef.current = setTimeout(() => {
      saveLastLocation(latestStoredLastLocationRef.current);
      lastLocationSaveTimerRef.current = null;
    }, 2500);

    return () => {
      if (lastLocationSaveTimerRef.current) {
        clearTimeout(lastLocationSaveTimerRef.current);
        lastLocationSaveTimerRef.current = null;
      }
    };
  }, [isStartupPreferenceReady, currentStoredLastLocationKey]);

  useEffect(() => {
    const saveCurrentLastLocation = () => {
      saveLastLocation(latestStoredLastLocationRef.current);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentLastLocation();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', saveCurrentLastLocation);
    window.addEventListener('beforeunload', saveCurrentLastLocation);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', saveCurrentLastLocation);
      window.removeEventListener('beforeunload', saveCurrentLastLocation);
    };
  }, []);
  useEffect(() => {
    if (!DEBUG_PRESENCE && !DEBUG_REMOTE_AVATARS && !DEBUG_AVATAR_PIPELINE) {
      return;
    }

    const summarizeUsers = (users: MultiplayerPresence[]) => users.map((user) => ({
      presenceId: user.presenceId,
      sessionId: user.sessionId,
      userId: user.userId,
      name: user.displayName,
      locationKey: user.locationKey,
      effectiveLocationKey: getEffectivePresenceLocationKey(user),
      selectedIp: user.selectedIp,
      playerLocation: user.playerLocation,
      gridMode: user.gridSystemMode,
      viewMode: user.viewMode,
      nearbyMatch: areUsersAtSameEffectiveLocation(multiplayer.currentPresence, user),
      ...getAvatarUrlDebugInfo(user.avatarUrl),
    }));

    console.info('DEBUG_PRESENCE nearby filter', {
      chatLocationKey,
      localEffectiveLocationKey: getEffectivePresenceLocationKey(multiplayer.currentPresence),
      localPlayerLocation: multiplayer.currentPresence.playerLocation,
      localSelectedIp: multiplayer.currentPresence.selectedIp,
      beforeCount: multiplayer.others.length,
      before: summarizeUsers(multiplayer.others),
      afterCount: nearbyUsers.length,
      after: summarizeUsers(nearbyUsers),
      avatarRenderCount: avatarUsers.length,
      avatarUsers: summarizeUsers(avatarUsers),
    });
  }, [chatLocationKey, multiplayer.currentPresence, multiplayer.others, nearbyUsers, avatarUsers]);
  useEffect(() => {
    if (!DEBUG_AVATAR_PIPELINE) {
      return;
    }
    console.info('DEBUG_AVATAR_PIPELINE local currentPresence', {
      presenceId: multiplayer.currentPresence.presenceId,
      sessionId: multiplayer.currentPresence.sessionId,
      userId: multiplayer.currentPresence.userId,
      name: multiplayer.currentPresence.displayName,
      avatarType: multiplayer.currentPresence.avatarType,
      ...getAvatarUrlDebugInfo(multiplayer.currentPresence.avatarUrl),
    });
  }, [multiplayer.currentPresence]);
  const userLocationLabel = getPlayerLocationDisplay(playerLocation);
  const streetPanelTargetIp = streetTargetCell?.ipAddress ?? selectedTargetIp ?? activeTargetIp;
  const streetPanelOrganizationName = streetTargetCell?.organizationName?.trim();
  const isChatDisabled =
    !multiplayer.isConfigured ||
    multiplayer.status !== 'online' ||
    chatLocationKey === 'unknown' ||
    !multiplayer.isChatReady;
  const isShoutDisabled =
    !multiplayer.isConfigured ||
    multiplayer.status !== 'online' ||
    !multiplayer.isShoutReady;
  const isMessageInputDisabled = isChatDisabled && isShoutDisabled;
  const chatPlaceholder = !multiplayer.isConfigured
    ? 'Multiplayer offline'
    : multiplayer.status !== 'online'
      ? 'Multiplayer offline'
      : chatLocationKey === 'unknown'
        ? 'Location unavailable'
        : !multiplayer.isChatReady
          ? 'Connecting to this location...'
          : 'Write a message';
  const handlePointerTargetChange = (cell: GridCellBuilding | null) => {
    if (!cell) {
      currentHoverCellRef.current = null;
      setPointerTarget(undefined);
      return;
    }

    currentHoverCellRef.current = cell;
    if (lastNewHoveredIpRef.current !== cell.ipAddress) {
      lastNewHoveredIpRef.current = cell.ipAddress;
      learnMoreButtonIpRef.current = cell.ipAddress;
      setLearnMoreButtonIp(cell.ipAddress);
    }
    setPointerTarget(cell);
  };

  const handleGridHoverInfoHtml = (html: string) => {
    const nextDisplayedHoverIp = currentHoverCellRef.current?.ipAddress ?? displayedHoverIpRef.current;
    setBottomInfoHtml(html);
    displayedHoverIpRef.current = nextDisplayedHoverIp;
    setDisplayedHoverIp(nextDisplayedHoverIp);
  };

  const handlePublicWebContextChange = (context: PublicWebEnrichmentContext | null) => {
    setPublicWebContext(context);
    setPublicWebState((current) => {
      if (current.status === 'default' || current.ipAddress === context?.ipAddress) {
        return current;
      }
      publicWebAbortRef.current?.abort();
      publicWebAbortRef.current = null;
      return { status: 'default' };
    });
  };

  const canLearnMore = Boolean(
    publicWebContext &&
    displayedHoverIp === publicWebContext.ipAddress &&
    (
      publicWebContext.organizationName ||
      publicWebContext.networkName ||
      publicWebContext.domain ||
      publicWebContext.asnName ||
      publicWebContext.contacts?.length ||
      publicWebContext.hostnames?.length ||
      publicWebContext.reverseDnsHostnames?.length
    )
  );
  const isPublicWebActive =
    publicWebState.status !== 'default' &&
    publicWebState.ipAddress === displayedHoverIp &&
    publicWebContext?.ipAddress === displayedHoverIp;
  const shouldShowLearnMoreButton = canLearnMore && learnMoreButtonIp === displayedHoverIp;

  const handleLearnMore = () => {
    if (
      !publicWebContext ||
      !shouldShowLearnMoreButton ||
      (publicWebState.status === 'loading' && publicWebState.ipAddress === publicWebContext.ipAddress)
    ) {
      return;
    }

    const requestedContext = publicWebContext;
    const controller = new AbortController();
    publicWebAbortRef.current?.abort();
    publicWebAbortRef.current = controller;
    setPublicWebState({ status: 'loading', ipAddress: requestedContext.ipAddress });

    void (async () => {
      try {
        const response = await fetch('/api/exa-enrich', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(requestedContext),
          signal: controller.signal,
        });
        const json = (await response.json()) as PublicWebEnrichmentResponse;

        if (
          controller.signal.aborted ||
          publicWebAbortRef.current !== controller ||
          displayedHoverIpRef.current !== requestedContext.ipAddress ||
          learnMoreButtonIpRef.current !== requestedContext.ipAddress
        ) {
          return;
        }

        if (response.ok && json.status === 'ready' && json.ipAddress === requestedContext.ipAddress && json.synopsis) {
          setPublicWebState({
            status: 'summary',
            ipAddress: requestedContext.ipAddress,
            synopsis: json.synopsis,
          });
          learnMoreButtonIpRef.current = null;
          setLearnMoreButtonIp((current) => (
            current === requestedContext.ipAddress ? null : current
          ));
          return;
        }

        const controlledMessage = typeof json.message === 'string' && (!json.ipAddress || json.ipAddress === requestedContext.ipAddress)
          ? json.message
          : undefined;
        setPublicWebState({ status: 'error', ipAddress: requestedContext.ipAddress, message: controlledMessage });
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        if (
          publicWebAbortRef.current !== controller ||
          displayedHoverIpRef.current !== requestedContext.ipAddress ||
          learnMoreButtonIpRef.current !== requestedContext.ipAddress
        ) {
          return;
        }
        setPublicWebState({
          status: 'error',
          ipAddress: requestedContext.ipAddress,
          message: 'The Learn More request could not be completed.',
        });
      } finally {
        if (publicWebAbortRef.current === controller) {
          publicWebAbortRef.current = null;
        }
      }
    })();
  };

  useEffect(() => () => {
    publicWebAbortRef.current?.abort();
  }, []);

  const handleSendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sent = multiplayer.sendMessage(chatDraft);
    if (sent) {
      setChatDraft('');
    }
  };
  const handleShoutChat = () => {
    const sent = multiplayer.sendShout(chatDraft);
    if (sent) {
      setChatDraft('');
    }
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

  const uploadAvatarGlb = async (file: File): Promise<{ publicUrl: string; verificationWarning?: string }> => {
    if (!supabase || !isSupabaseConfigured) {
      throw new Error('Supabase Storage is not configured.');
    }

    const userId = multiplayer.currentUser.userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'user';
    const storagePath = getAvatarStoragePath(userId);
    console.info('Avatar upload target', {
      userId: multiplayer.currentUser.userId,
      sessionId: multiplayer.currentUser.sessionId,
      presenceId: multiplayer.currentUser.presenceId,
      fileName: file.name,
      browserFileType: file.type,
      targetContentType: 'model/gltf-binary',
      supabaseHost: supabaseUrlHost,
      bucket: AVATAR_BUCKET,
      path: storagePath,
    });
    const sharedUserIdUsers = multiplayer.others.filter((user) => user.userId === multiplayer.currentUser.userId);
    if (sharedUserIdUsers.length > 0) {
      console.warn('Avatar upload path is shared by multiple live clients with the same userId', {
        userId: multiplayer.currentUser.userId,
        sessionId: multiplayer.currentUser.sessionId,
        presenceId: multiplayer.currentUser.presenceId,
        path: storagePath,
        otherClients: sharedUserIdUsers.map((user) => ({
          sessionId: user.sessionId,
          presenceId: user.presenceId,
          name: user.displayName,
        })),
      });
    }

    // Browsers may report .glb files as application/octet-stream, so force the GLB MIME type.
    const uploadResult = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(storagePath, file, {
        upsert: true,
        contentType: 'model/gltf-binary',
        cacheControl: '3600',
      });
    console.info('Avatar upload result', uploadResult);

    if (uploadResult.error) {
      throw uploadResult.error;
    }

    let verificationWarning: string | undefined;
    const listResult = await supabase.storage.from(AVATAR_BUCKET).list(userId);
    console.info('Avatar post-upload listing result', listResult);
    if (listResult.error) {
      console.warn('Avatar upload verification list failed', listResult.error);
    } else if (!listResult.data?.some((item) => item.name === 'avatar.glb')) {
      verificationWarning = 'Avatar uploaded, but verification did not find avatar.glb in the expected folder.';
      console.warn('Avatar upload verification did not find avatar.glb in expected folder', {
        bucket: AVATAR_BUCKET,
        folder: userId,
        path: storagePath,
        listData: listResult.data,
      });
    }

    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(storagePath);
    if (!data.publicUrl) {
      throw new Error('Avatar uploaded, but no public URL was returned.');
    }
    const versionedPublicUrl = getVersionedAvatarUrl(data.publicUrl);
    console.info('Avatar public URL', {
      userId: multiplayer.currentUser.userId,
      sessionId: multiplayer.currentUser.sessionId,
      presenceId: multiplayer.currentUser.presenceId,
      path: storagePath,
      publicUrl: versionedPublicUrl,
    });

    return { publicUrl: versionedPublicUrl, verificationWarning };
  };

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    const validationError = validateAvatarFile(file);
    if (validationError) {
      setAvatarUploadStatus(validationError);
      return;
    }

    setIsAvatarUploading(true);
    setAvatarUploadStatus('Uploading avatar...');
    try {
      const { publicUrl, verificationWarning } = await uploadAvatarGlb(file);
      const wasAvatarUrlAccepted = multiplayer.updateAvatarUrl(publicUrl);
      if (DEBUG_REMOTE_AVATARS || DEBUG_AVATAR_PIPELINE) {
        console.info('DEBUG_AVATAR_PIPELINE local presence avatar update', {
          accepted: wasAvatarUrlAccepted,
          presenceId: multiplayer.currentUser.presenceId,
          sessionId: multiplayer.currentUser.sessionId,
          userId: multiplayer.currentUser.userId,
          name: multiplayer.currentUser.displayName,
          ...getAvatarUrlDebugInfo(publicUrl),
          avatarType: 'glb',
          location: playerLocationIp,
          gridMode: gridSystemMode,
        });
      }
      if (!wasAvatarUrlAccepted) {
        console.warn('Avatar public URL was not accepted for presence', getAvatarUrlDebugInfo(publicUrl));
        setAvatarUploadStatus('Avatar uploaded to Storage, but the public URL was not accepted for presence.');
        return;
      }
      setAvatarUploadStatus(verificationWarning ?? 'Avatar uploaded');
    } catch (error) {
      console.error('Avatar upload failed', error);
      setAvatarUploadStatus(`Avatar upload failed: ${error instanceof Error ? error.message : 'Storage unavailable'}`);
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const handleClearAvatar = () => {
    multiplayer.clearAvatar();
    setAvatarUploadStatus('Using default avatar');
  };

  const renderWhoPanel = () => (
    <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
      <div className="font-bold text-lg">Who</div>
      <div className="mt-3 space-y-2">
        {whoPanelUsers.length > 0 ? (
          whoPanelUsers.map((user) => {
            const displayName = user.displayName?.trim() || 'Explorer';
            const ipAddress = getPresenceIpLocation(user);
            const canFollowUser = isSupabaseConfigured && user.userId !== multiplayer.currentUser.userId;
            const isFollowingUser = followedUserIdSet.has(user.userId);
            return (
              <div key={user.presenceId || user.sessionId} className="flex min-w-0 items-center gap-2 rounded bg-gray-100 p-2 text-sm">
                <MiniUserAvatar user={user} />
                <div className="min-w-0 flex-1 truncate font-semibold text-gray-900">
                  {displayName}
                  {canFollowUser && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleToggleFollowUser(user);
                      }}
                      className="ml-1 text-xs font-normal text-blue-700 underline hover:text-blue-900"
                    >
                      {isFollowingUser ? '(unfollow)' : '(follow)'}
                    </button>
                  )}
                </div>
                {ipAddress ? (
                  <button
                    type="button"
                    onClick={() => handleRemoteUserClick(user)}
                    className="shrink-0 font-mono text-xs text-blue-700 underline break-all hover:text-blue-900"
                  >
                    {ipAddress}
                  </button>
                ) : (
                  <div className="shrink-0 text-xs text-gray-600">Unknown location</div>
                )}
              </div>
            );
          })
        ) : (
          <div className="text-sm text-gray-600">No users online.</div>
        )}
      </div>
      {followStatus && <div className="mt-3 text-xs text-red-700">{followStatus}</div>}
      <button
        type="button"
        onClick={() => setShowWhoPanel(false)}
        className="mt-4 w-full px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
      >
        Close this panel
      </button>
    </div>
  );

  const renderBookmarksPanel = () => (
    <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="font-bold text-lg">Your Saved Locations</div>
        <button
          type="button"
          onClick={handleAddBookmark}
          className="shrink-0 px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
        >
          Add this Location
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {bookmarks.length > 0 ? (
          bookmarks.map((bookmark) => (
            <div key={bookmark.ipAddress} className="rounded bg-gray-100 p-2 text-sm">
              <button
                type="button"
                onClick={() => handleBookmarkClick(bookmark)}
                className="block font-mono text-xs text-blue-700 underline break-all hover:text-blue-900"
              >
                {bookmark.ipAddress}
              </button>
              {bookmark.organizationName && (
                <div className="mt-1 text-sm text-gray-700 break-words">{bookmark.organizationName}</div>
              )}
              <input
                type="text"
                value={bookmark.note}
                onChange={(event) => handleBookmarkNoteChange(bookmark.ipAddress, event.target.value)}
                className="mt-2 w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-900"
              />
            </div>
          ))
        ) : (
          <div className="text-sm text-gray-600">No saved locations.</div>
        )}
      </div>
      {bookmarksSharingStatus && <div className="mt-3 text-xs text-red-700">{bookmarksSharingStatus}</div>}
      <div className="mt-4 border-t border-gray-200 pt-3">
        <div className="font-bold text-lg">Bookmarked by Others</div>
        <div className="mt-3 space-y-2">
          {!isSupabaseConfigured ? (
            <div className="text-sm text-gray-600">Supabase env vars not configured.</div>
          ) : followedUserIds.length === 0 ? (
            <div className="text-sm text-gray-600">Follow users from the Who panel to see their saved locations here.</div>
          ) : isFollowedBookmarksLoading ? (
            <div className="text-sm text-gray-600">Loading saved locations...</div>
          ) : followedBookmarks.length > 0 ? (
            followedBookmarks.map((bookmark) => {
              const displayName = followedUserDisplayNames.get(bookmark.userId) ?? 'Followed user';
              return (
                <div key={`${bookmark.userId}-${bookmark.ipAddress}`} className="rounded bg-gray-100 p-2 text-sm">
                  <button
                    type="button"
                    onClick={() => handleBookmarkClick(bookmark)}
                    className="block font-mono text-xs text-blue-700 underline break-all hover:text-blue-900"
                  >
                    {bookmark.ipAddress}
                  </button>
                  <div className="mt-1 text-xs text-gray-600 break-words">{displayName}</div>
                  {bookmark.organizationName && (
                    <div className="mt-1 text-sm text-gray-700 break-words">{bookmark.organizationName}</div>
                  )}
                  {bookmark.note && (
                    <div className="mt-2 text-xs text-gray-900 break-words">{bookmark.note}</div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-sm text-gray-600">No saved locations from followed users yet.</div>
          )}
        </div>
        {followedBookmarksStatus && <div className="mt-3 text-xs text-red-700">{followedBookmarksStatus}</div>}
      </div>
      <button
        type="button"
        onClick={() => setShowBookmarksPanel(false)}
        className="mt-4 w-full px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
      >
        Close this panel
      </button>
    </div>
  );

  const renderLocationPreferencesPanel = () => (
    <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
      <div className="font-bold text-lg">Location Preferences</div>
      <div className="mt-3 rounded bg-gray-100 p-2 text-sm">
        <div className="font-semibold text-gray-900">Starting Location</div>
        <div className="mt-2 space-y-2">
          {[
            ['default', 'Default'],
            ['last_location', 'Last Location'],
            ['random_grid1', 'Random Location'],
            ['specific', 'Specific Location'],
          ].map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-gray-900">
              <input
                type="radio"
                name="starting-location"
                value={value}
                checked={startingLocationPreference === value}
                onChange={() => {
                  setStartingLocationPreference(value as StartingLocationPreference);
                  setStartingLocationValidation('');
                  setStartingLocationStatus('');
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {startingLocationPreference === 'specific' && (
          <input
            type="text"
            value={specificStartingLocationIp}
            onChange={(event) => {
              setSpecificStartingLocationIp(event.target.value);
              setStartingLocationValidation('');
              setStartingLocationStatus('');
            }}
            className="mt-3 w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-900"
            placeholder="IPv4 address"
          />
        )}
        {isStartingLocationLoading && (
          <div className="mt-2 text-xs text-gray-600">Loading...</div>
        )}
        {startingLocationValidation && (
          <div className="mt-2 text-xs text-red-700">{startingLocationValidation}</div>
        )}
        {startingLocationStatus && (
          <div className="mt-2 text-xs text-green-700">{startingLocationStatus}</div>
        )}
        <button
          type="button"
          onClick={handleSaveStartingLocationPreference}
          disabled={isStartingLocationLoading || isStartingLocationSaving}
          className="mt-3 px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
        >
          {isStartingLocationSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <button
        type="button"
        onClick={() => setShowLocationPreferencesPanel(false)}
        className="mt-4 w-full px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
      >
        Close this panel
      </button>
    </div>
  );

  const renderStreetAndBuildingInfoPanel = (
    target: { ipAddress: string; organizationName?: string | null },
    onReturn: () => void,
    helperText: string,
    onClose: () => void
  ) => (
    <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
      <div className="font-bold text-lg">Street and Building View: {target.ipAddress}</div>
      {target.organizationName?.trim() && (
        <div className="text-sm text-gray-700 mt-1">{target.organizationName.trim()}</div>
      )}
      <div className="text-sm text-gray-600 mt-1">{helperText}</div>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onReturn}
            className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
          >
            Return to Grid
          </button>

          <button
            type="button"
            onClick={handleLaunchSsh}
            disabled={sshLaunchLoadingIp === target.ipAddress}
            className={`px-3 py-2 rounded-md text-sm font-medium ${sshLaunchLoadingIp === target.ipAddress ? 'bg-gray-300 text-gray-500 border border-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400'}`}
            title="Open the local SSH client"
          >
            {sshLaunchLoadingIp === target.ipAddress ? 'Opening SSH...' : 'Open SSH client'}
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

        {sshLaunchResult && sshLaunchResult.ipAddress === target.ipAddress && (
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
                <div className={certificateResult.error === 'HTTPS certificate lookup timed out.' ? 'text-sm' : 'text-sm text-red-700'}>
                  {certificateResult.error === 'HTTPS certificate lookup timed out.'
                    ? 'No certificate identified.'
                    : certificateResult.statusSummary ?? certificateResult.error ?? 'No HTTPS certificate data available.'}
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
      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
      >
        Close this panel
      </button>
    </div>
  );

  const renderStreetSceneCanvas = (viewKey: string, focusCell?: { x: number; y: number } | null) => {
    const focusPosition = focusCell ? getStreetBuildingWorldPosition(focusCell.x, focusCell.y) : null;

    return (
      <div
        ref={gridContainerRef}
        className="relative w-full h-full min-h-[260px] touch-none rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]"
      >
        <Canvas
          key={viewKey}
          camera={{ position: [0, 1.55, 0], fov: 62 }}
          dpr={canvasDpr}
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
            onHoverInfoHtml={handleGridHoverInfoHtml}
            onHoverEnrichmentContext={handlePublicWebContextChange}
            onHoverCellChange={handlePointerTargetChange}
            infoDisplayMode={infoDisplayMode}
            // Visual avatar rendering must receive all active users. Do not replace this with `nearbyUsers`; exact-location filtering is only for chat/proximity UI.
            remoteUsers={avatarUsers}
            onRemoteUserClick={handleRemoteUserClick}
            selectedBuildingIp={buildingView?.ipAddress}
            selectedBuildingFlagImageUrl={buildingView?.flagImageUrl}
            selectedBuildingCountryCodeLabel={buildingView?.countryCodeLabel}
          />
          {focusPosition && (
            <OrbitControls
              key={`street-controls-${viewKey}`}
              ref={controlsRef}
              enablePan
              enableZoom
              enableRotate
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
    <div ref={appContainerRef} className="h-screen overflow-hidden bg-white text-black flex flex-col">
      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3">
        <header className="shrink-0 bg-white text-black p-3 rounded-lg">
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0 lg:pr-4">
              <h1 className="text-2xl font-bold">Burning Chrome</h1>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runDomainSearch();
              }}
              className="flex min-w-0 justify-center lg:px-4 lg:pt-1"
            >
              <div className="flex w-full min-w-0 max-w-xl gap-2">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search by domain or IP address..."
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
                  aria-label="Search domain or organization"
                />
                <button
                  type="submit"
                  disabled={!searchQuery.trim() || searchLoading}
                  className="shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  {searchLoading ? 'Searching...' : 'Search'}
                </button>
              </div>
            </form>

            <div className="flex flex-col items-start lg:items-end gap-3 lg:pl-4">
              <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
                <div
                  className="relative"
                  onMouseEnter={() => setIsOptionsOpen(true)}
                  onMouseLeave={() => setIsOptionsOpen(false)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setIsOptionsOpen(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setIsOptionsOpen(true)}
                    onFocus={() => setIsOptionsOpen(true)}
                    className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                    aria-expanded={isOptionsOpen}
                    aria-haspopup="menu"
                  >
                    Menu
                  </button>
                  {isOptionsOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-visible rounded-lg border border-gray-300 bg-white py-1 text-sm text-gray-900 shadow-xl" role="menu">
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
                          handleToggleFullscreen();
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        {isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowWhoPanel(true);
                          setShowBookmarksPanel(false);
                          setShowLocationPreferencesPanel(false);
                          setLayoutMode('grid');
                          setBuildingView(null);
                          setStreetTargetCell(null);
                          setStreetFocusCell(null);
                          setBottomInfoHtml('');
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        Who
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowBookmarksPanel(true);
                          setShowWhoPanel(false);
                          setShowLocationPreferencesPanel(false);
                          setLayoutMode('grid');
                          setBuildingView(null);
                          setStreetTargetCell(null);
                          setStreetFocusCell(null);
                          setBottomInfoHtml('');
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        Bookmarks
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowLocationPreferencesPanel(true);
                          setShowWhoPanel(false);
                          setShowBookmarksPanel(false);
                          setLayoutMode('grid');
                          setBuildingView(null);
                          setStreetTargetCell(null);
                          setStreetFocusCell(null);
                          setBottomInfoHtml('');
                          setIsOptionsOpen(false);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                        role="menuitem"
                      >
                        Location Preferences
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
                      <div className="relative group">
                        <button
                          type="button"
                          className="block w-full px-3 py-2 text-left hover:bg-gray-100 active:bg-gray-200"
                          role="menuitem"
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
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        {showSearchOverlay && (
          <div className="fixed inset-x-4 top-28 bottom-28 z-40 flex items-start justify-center bg-black/20 p-4">
            <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-gray-400 bg-white text-gray-950 shadow-2xl">
              <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <div>
                  <div className="text-base font-semibold">Search results</div>
                  <div className="text-xs text-gray-600">{searchQuery.trim()}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowSearchOverlay(false)}
                  className="rounded border border-gray-400 bg-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-900 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                >
                  Close
                </button>
              </div>

              <div className="max-h-[60vh] overflow-auto p-4">
                {searchLoading ? (
                  <div className="text-sm text-gray-700">Searching...</div>
                ) : searchError ? (
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{searchError}</div>
                ) : searchResults.length === 0 ? (
                  <div className="text-sm text-gray-700">No results found.</div>
                ) : (
                  <div className="space-y-2">
                    {searchResults.map((result) => (
                      <button
                        key={`${result.ip}-${result.domain ?? result.label}`}
                        type="button"
                        onClick={() => handleSearchResultClick(result)}
                        className="block w-full rounded-md border border-gray-200 bg-gray-50 p-3 text-left shadow-sm hover:border-gray-400 hover:bg-gray-100 active:bg-gray-200"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-semibold text-gray-950">{result.label}</span>
                          <span className="font-mono text-sm text-gray-800">{result.ip}</span>
                        </div>
                        {result.domain && <div className="mt-1 text-sm text-blue-700">{result.domain}</div>}
                        {result.description && <div className="mt-1 text-sm text-gray-700">{result.description}</div>}
                        {result.source && <div className="mt-1 text-xs text-gray-500">Source: {result.source}</div>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

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
              {buildingView.organizationName?.trim() && (
                <div className="text-sm text-gray-700 mt-1">{buildingView.organizationName.trim()}</div>
              )}
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
                        <div className={certificateResult.error === 'HTTPS certificate lookup timed out.' ? 'text-sm' : 'text-sm text-red-700'}>
                          {certificateResult.error === 'HTTPS certificate lookup timed out.'
                            ? 'No certificate identified.'
                            : certificateResult.statusSummary ?? certificateResult.error ?? 'No HTTPS certificate data available.'}
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
          <div className={`flex-1 min-h-0 flex ${showStreetAndBuildingPanel ? 'flex-col gap-3 lg:flex-row' : 'justify-center'}`}>
            <div className={`${showStreetAndBuildingPanel ? 'relative flex-1 min-h-[260px] lg:flex-[1.35]' : 'relative w-full h-full min-h-[260px]'}`}>
              {renderStreetSceneCanvas(`street-${viewResetKey}-${streetTargetCell?.ipAddress ?? 'none'}`, streetFocusCell)}
            </div>

            {showStreetAndBuildingPanel && (streetTargetCell ? (
              renderStreetAndBuildingInfoPanel(
                streetTargetCell,
                handleBack,
                'Use "Return to Grid" to leave Street and Building View.',
                () => setShowStreetAndBuildingPanel(false)
              )
            ) : (
              <div className="min-h-0 lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-3 overflow-auto">
                <div className="font-bold text-lg">Street and Building View: {streetPanelTargetIp}</div>
                {streetPanelOrganizationName && (
                  <div className="text-sm text-gray-700 mt-1">{streetPanelOrganizationName}</div>
                )}
                <div className="text-sm text-gray-600 mt-1">
                  Use "Return to Grid" to leave Street and Building View.
                </div>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={handleBack}
                    className="px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                  >
                    Return to Grid
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowStreetAndBuildingPanel(false)}
                  className="mt-4 w-full px-3 py-2 rounded-md text-sm font-medium bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400"
                >
                  Close this panel
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className={`flex-1 min-h-0 flex ${showGridSidePanel ? 'flex-col gap-3 lg:flex-row' : 'justify-center'}`}>
            <div
              ref={gridContainerRef}
              className={`${showGridSidePanel ? 'relative flex-1 min-h-[260px] lg:flex-[1.35]' : 'relative w-full h-full min-h-[260px]'} rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]`}
            >
              <Canvas
                key={`${layoutMode}-${viewResetKey}`}
                camera={{ position: [0, 16, 22], fov: 45 }}
                dpr={canvasDpr}
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
                  onBuildingClick={handleGridCellClick}
                  onBuildingDoubleClick={handleCellDoubleClick}
                  lookupMode={lookupMode}
                  gridSystemMode={gridSystemMode}
                  grid2Position={grid2Position}
                  onHoverInfoHtml={handleGridHoverInfoHtml}
                  onHoverEnrichmentContext={handlePublicWebContextChange}
                  onHoverCellChange={handlePointerTargetChange}
                  infoDisplayMode={infoDisplayMode}
                  // Visual avatar rendering must receive all active users. Do not replace this with `nearbyUsers`; exact-location filtering is only for chat/proximity UI.
                  remoteUsers={avatarUsers}
                  onRemoteUserClick={handleRemoteUserClick}
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
              <div className="pointer-events-none absolute left-3 top-3 z-10 font-bold text-black">
                {visibleCoordinateRangeLabel}
              </div>
              {gridSystemMode === 'grid1' && (
                <div className="absolute right-3 top-3 z-10 flex flex-col items-start gap-0.5">
                  {zoomLevel > 0 && (
                    <button
                      type="button"
                      aria-label="Go up one octet"
                      onClick={handleGrid1OctetUp}
                      className="text-black drop-shadow hover:text-gray-200 active:text-gray-300"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-6 w-6">
                        <path d="M8 2L2 9H6V14H10V9H14L8 2Z" fill="currentColor" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Open Street and Building View at current location"
                    onClick={handleEnterStreetViewFromMenu}
                    className="text-black drop-shadow hover:text-gray-200 active:text-gray-300"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-6 w-6">
                      <path d="M2 7.25L8 2L14 7.25V14H10V10H6V14H2V7.25Z" fill="currentColor" />
                    </svg>
                  </button>
                  {zoomLevel < 3 && (
                    <button
                      type="button"
                      aria-label="Go down one octet"
                      onClick={handleGrid1OctetDown}
                      className="text-black drop-shadow hover:text-gray-200 active:text-gray-300"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-6 w-6">
                        <path d="M8 14L14 7H10V2H6V7H2L8 14Z" fill="currentColor" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
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
            {showWhoPanel && renderWhoPanel()}
            {showBookmarksPanel && renderBookmarksPanel()}
            {showLocationPreferencesPanel && renderLocationPreferencesPanel()}
          </div>
        )}

        {!buildingView && (
          <div
            className="relative shrink-0 h-[18vh] rounded-lg shadow-lg border border-gray-300 px-3 py-2 overflow-hidden"
            style={{ backgroundColor: '#ffffff', color: '#000000' }}
          >
            {shouldShowLearnMoreButton && (
              <button
                type="button"
                onClick={handleLearnMore}
                disabled={publicWebState.status === 'loading' && publicWebState.ipAddress === displayedHoverIp}
                className="absolute right-3 top-2 z-10 rounded border border-gray-400 bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
              >
                Learn More
              </button>
            )}
            <div className={`h-full overflow-auto ${shouldShowLearnMoreButton ? 'pr-32' : ''}`}>
              {bottomInfoHtml ? (
                isPublicWebActive && publicWebContext ? (
                  <div className="text-sm leading-relaxed max-w-5xl [&_.font-bold]:text-base [&_.font-bold]:mb-2 [&_p]:mb-2">
                    <div dangerouslySetInnerHTML={{ __html: publicWebContext.headingHtml }} />
                    <div className="mt-2 text-gray-800">
                      {publicWebState.status === 'loading'
                        ? 'Searching the public web...'
                        : publicWebState.status === 'summary' && publicWebState.synopsis
                          ? publicWebState.synopsis
                          : publicWebState.message ?? 'No reliable public-web information was found for this location.'}
                    </div>
                  </div>
                ) : (
                  <div
                    className={infoDisplayMode === 'prose'
                      ? "text-sm leading-relaxed max-w-5xl [&_.font-bold]:text-base [&_.font-bold]:mb-2 [&_p]:mb-2 [&_.text-gray-600]:text-gray-700 [&_.text-blue-700]:text-blue-700 [&_.text-red-700]:text-red-700"
                      : "grid gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-3 text-sm leading-snug [&_.font-bold]:md:col-span-2 [&_.font-bold]:xl:col-span-3 [&_.font-bold]:text-base [&_.font-bold]:mb-1 [&_.space-y-1]:contents [&_.pt-1]:contents [&_.mt-2]:contents [&_.text-gray-400]:text-gray-600 [&_.text-gray-300]:text-gray-700 [&_.text-blue-300]:text-blue-700 [&_.text-blue-700]:text-blue-700 [&_.text-red-300]:text-red-700 [&_.text-red-700]:text-red-700 [&_.bg-gray-800]:bg-gray-100 [&_.bg-gray-100]:bg-gray-100 [&_.bg-gray-800]:p-1.5 [&_.bg-gray-100]:p-1.5 [&_.bg-gray-800]:rounded [&_.bg-gray-100]:rounded"}
                    dangerouslySetInnerHTML={{ __html: bottomInfoHtml }}
                  />
                )
              ) : (
                <div>&nbsp;</div>
              )}
            </div>
          </div>
        )}

        <div className="shrink-0 bg-white text-black border border-gray-300 rounded-lg shadow-sm p-2">
          <div className="grid gap-2 lg:grid-cols-[minmax(260px,1fr)_minmax(260px,auto)_minmax(320px,1.35fr)] lg:items-start">
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
                  {nearbyUsers.length === 0 ? 'No users nearby' : `${nearbyUsers.length} users nearby`}
                  {nearbyUsers.length > 0 && nearbyUsers.length <= 3 && (
                    <>
                      :{' '}
                      {nearbyUsers.map((user, index) => {
                        const displayName = user.displayName?.trim() || 'Explorer';
                        return (
                          <span key={user.sessionId}>
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

            <div className="flex flex-wrap items-center justify-center gap-2 text-xs lg:px-2">
              <label
                className="cursor-pointer rounded border border-gray-400 bg-gray-200 px-2 py-1 font-medium text-gray-900 shadow-sm hover:bg-gray-300"
                htmlFor="avatar-upload-input"
              >
                Upload avatar (.glb)
              </label>
              <input
                id="avatar-upload-input"
                type="file"
                accept=".glb,model/gltf-binary"
                className="hidden"
                disabled={isAvatarUploading}
                onChange={handleAvatarUpload}
              />
              <button
                type="button"
                onClick={handleClearAvatar}
                disabled={!multiplayer.currentUser.avatarUrl || isAvatarUploading}
                className="rounded border border-gray-400 bg-gray-200 px-2 py-1 text-xs font-medium text-gray-900 shadow-sm hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
              >
                Clear
              </button>
              <span className="inline-flex items-center justify-center gap-2 text-center text-gray-600">
                {multiplayer.currentPresence.avatarUrl && (
                  <MiniUserAvatar
                    user={multiplayer.currentPresence}
                    ariaLabel="Current custom avatar"
                    renderCustomOnConstrainedDevice
                  />
                )}
                {avatarUploadStatus || (multiplayer.currentPresence.avatarUrl ? null : 'Default avatar')}
              </span>
            </div>

            <div className="w-full lg:max-w-xl lg:justify-self-end">
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
                    {multiplayer.isConfigured ? 'No messages yet.' : 'Supabase env vars not configured.'}
                  </div>
                )}
              </div>
              <form onSubmit={handleSendChat} className="mt-2 flex gap-2">
                <input
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value.slice(0, 300))}
                  disabled={isMessageInputDisabled}
                  maxLength={300}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  placeholder={chatPlaceholder}
                />
                <button
                  type="submit"
                  disabled={!chatDraft.trim() || isChatDisabled}
                  className="rounded border border-gray-400 bg-gray-200 px-3 py-1 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Whisper
                </button>
                <button
                  type="button"
                  onClick={handleShoutChat}
                  disabled={!chatDraft.trim() || isShoutDisabled}
                  className="rounded border border-gray-400 bg-gray-200 px-3 py-1 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Shout
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
