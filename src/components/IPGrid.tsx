import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Html, Text } from '@react-three/drei';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useIpMetadataCache, type CachedAsnMetadata, type CachedExposure, type CachedIpMetadata, type CachedReverseDns } from '../hooks/useIpMetadataCache';
import { getPlayerLocationDisplay, type MultiplayerPresence } from '../hooks/useMultiplayerPresence';

type GridPosition = {
  firstOctet: number;
  secondOctet: number;
  thirdOctet: number;
  fourthOctet: number;
};

type LookupMode = 'rdap' | 'ptr';
type GridSystemMode = 'grid1' | 'grid2';
type InfoDisplayMode = 'structured' | 'prose';

export type BgpVisualEvent = {
  id: string;
  type: 'announcement' | 'withdrawal' | 'path_change' | 'flap';
  prefix?: string;
  asn?: string;
  timestamp: string;
  intensity: number;
};

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

export type GridCellBuilding = {
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

type CellHoverPart = 'square' | 'sidewalk' | 'building';

type HoveredCellState = {
  cellKey: string;
  ipAddress: string;
  part: CellHoverPart;
};

type GridCellTarget = {
  cellKey: string;
  cubeId: string;
  cellBuilding: GridCellBuilding;
  hoverInfoHtml: string;
};

const avatarModelLoader = new GLTFLoader();
const avatarModelCache = new Map<string, Promise<THREE.Group>>();
const DEBUG_REMOTE_AVATARS = false;

function cloneAvatarScene(scene: THREE.Group): THREE.Group {
  const clone = scene.clone(true);
  clone.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    mesh.geometry = mesh.geometry.clone();
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => material.clone());
    } else {
      mesh.material = mesh.material.clone();
    }
  });
  return clone;
}

function disposeAvatarScene(scene: THREE.Object3D): void {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material.dispose());
  });
}

function normalizeAvatarScene(scene: THREE.Group): THREE.Group {
  const clone = cloneAvatarScene(scene);
  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const root = new THREE.Group();
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (Number.isFinite(maxDimension) && maxDimension > 0) {
    clone.position.sub(center);
    root.scale.setScalar(0.74 / maxDimension);
  } else {
    root.scale.setScalar(0.48);
  }
  root.add(clone);
  return root;
}

function loadAvatarScene(avatarUrl: string): Promise<THREE.Group> {
  const cached = avatarModelCache.get(avatarUrl);
  if (cached) {
    return cached;
  }

  const request = new Promise<THREE.Group>((resolve, reject) => {
    avatarModelLoader.load(
      avatarUrl,
      (gltf) => resolve(gltf.scene),
      undefined,
      reject
    );
  }).catch((error) => {
    avatarModelCache.delete(avatarUrl);
    throw error;
  });
  avatarModelCache.set(avatarUrl, request);
  return request;
}

function DefaultRemoteAvatar({ color }: { color: string }) {
  return (
    <mesh castShadow>
      <sphereGeometry args={[0.36, 24, 24]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.32} />
    </mesh>
  );
}

function UserAvatarModel({
  avatarUrl,
  fallback,
}: {
  avatarUrl?: string;
  fallback: ReactNode;
}) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const modelRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    let isActive = true;
    if (modelRef.current) {
      disposeAvatarScene(modelRef.current);
      modelRef.current = null;
    }
    setModel(null);
    setLoadFailed(false);

    if (!avatarUrl) {
      return () => {
        isActive = false;
      };
    }

    void loadAvatarScene(avatarUrl)
      .then((scene) => {
        if (!isActive) {
          return;
        }
        if (DEBUG_REMOTE_AVATARS) {
          console.info('DEBUG_REMOTE_AVATARS GLB load success', { avatarUrl });
        }
        const normalized = normalizeAvatarScene(scene);
        modelRef.current = normalized;
        setModel(normalized);
      })
      .catch((error) => {
        console.error('Avatar GLB failed to load', error);
        if (DEBUG_REMOTE_AVATARS) {
          console.info('DEBUG_REMOTE_AVATARS GLB load failure', { avatarUrl, error });
        }
        if (isActive) {
          setLoadFailed(true);
        }
      });

    return () => {
      isActive = false;
      if (modelRef.current) {
        disposeAvatarScene(modelRef.current);
        modelRef.current = null;
      }
    };
  }, [avatarUrl]);

  if (!avatarUrl || loadFailed || !model) {
    return <>{fallback}</>;
  }

  return <primitive object={model} />;
}

const DEFAULT_GRID2_POSITION: Grid2Position = {
  outerFirstOctet: 128,
  outerSecondOctet: 220,
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
  onCellClick: (cell: GridCellBuilding) => void;
  onCellDoubleClick: (cell: GridCellBuilding) => void;
  onBuildingClick?: (cell: GridCellBuilding) => void;
  onBuildingDoubleClick?: (cell: GridCellBuilding) => void;
  lookupMode: LookupMode;
  gridSystemMode?: GridSystemMode;
  grid2Position?: Grid2Position;
  onHoverInfoHtml?: (html: string) => void;
  onHoverCellChange?: (cell: GridCellBuilding) => void;
  infoDisplayMode?: InfoDisplayMode;
  remoteUsers?: MultiplayerPresence[];
  onRemoteUserClick?: (user: MultiplayerPresence) => void;
  bgpEvents?: BgpVisualEvent[];
  selectedBuildingIp?: string;
  selectedBuildingFlagImageUrl?: string | null;
  selectedBuildingCountryCodeLabel?: string;
};

type WallMountedFlagProps = {
  imageUrl: string;
  countryCodeLabel?: string;
  width: number;
  height: number;
  position: [number, number, number];
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
  onDoubleClick?: (event: ThreeEvent<MouseEvent>) => void;
  onPointerOver?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void;
};

function WallMountedFlag({
  imageUrl,
  countryCodeLabel,
  width,
  height,
  position,
  onClick,
  onDoubleClick,
  onPointerOver,
  onPointerOut,
}: WallMountedFlagProps) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loadedTexture: THREE.Texture | null = null;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    setTexture(null);
    loader.load(
      imageUrl,
      (nextTexture) => {
        if (disposed) {
          nextTexture.dispose();
          return;
        }
        nextTexture.colorSpace = THREE.SRGBColorSpace;
        nextTexture.needsUpdate = true;
        loadedTexture = nextTexture;
        setTexture(nextTexture);
      },
      undefined,
      () => {
        if (!disposed) {
          setTexture(null);
        }
      }
    );

    return () => {
      disposed = true;
      loadedTexture?.dispose();
    };
  }, [imageUrl]);

  if (!texture) {
    return null;
  }

  return (
    <mesh
      position={position}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      userData={{ label: countryCodeLabel ?? 'National flag' }}
    >
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} depthTest depthWrite side={THREE.FrontSide} toneMapped={false} />
    </mesh>
  );
}

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

function getAvatarLocationDisplay(user: MultiplayerPresence): string {
  if (user.playerLocation?.kind === 'ip') return user.playerLocation.ipAddress;
  if (user.playerLocation?.kind === 'building') return `Building ${user.playerLocation.ipAddress}`;
  return getPlayerLocationDisplay(user.playerLocation);
}

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

function cachedIpMetadataToRdapRecord(row: CachedIpMetadata): RdapRecord | null {
  if (!row.rdap_org && !row.rdap_network_name && !row.rdap_country) {
    return null;
  }

  return {
    ipAddress: row.ip_address,
    networkName: row.rdap_network_name ?? undefined,
    org: row.rdap_org ?? undefined,
    country: row.rdap_country ?? undefined,
    entities: [],
    source: row.source_status ?? 'supabase-cache',
  };
}

function cachedMetadataToAsnRecord(row: CachedIpMetadata, asnMetadata?: CachedAsnMetadata): AsnRecord | null {
  const asn = normalizeAsn(row.asn);
  if (!asn && !row.asn_name && !row.asn_country && !asnMetadata) {
    return null;
  }

  return {
    ipAddress: row.ip_address,
    asn: asn ?? undefined,
    asnName: asnMetadata?.asn_name ?? row.asn_name ?? undefined,
    country: asnMetadata?.country ?? row.asn_country ?? undefined,
    registry: asnMetadata?.registry ?? undefined,
    route: asnMetadata?.route ?? undefined,
    source: row.source_status ?? asnMetadata?.source_status ?? 'supabase-cache',
  };
}

function cachedIpMetadataToReverseDnsRecord(row: CachedIpMetadata): ReverseDnsRecord | null {
  if (!row.reverse_dns?.length) {
    return null;
  }

  return {
    ipAddress: row.ip_address,
    hostnames: row.reverse_dns,
    ptrHostnames: row.reverse_dns,
    fallbackHostnames: [],
  };
}

function cachedIpMetadataToExposureRecord(row: CachedIpMetadata): ExposureRecord | null {
  if (!row.open_ports?.length && !row.services?.length && !row.hostnames?.length) {
    return null;
  }

  return {
    ipAddress: row.ip_address,
    sourceProvider: 'internetdb',
    serviceCount: row.services?.length ?? 0,
    openPortCount: row.open_ports?.length ?? 0,
    topPorts: row.open_ports?.map((port) => String(port)) ?? [],
    serviceNames: row.services ?? [],
    labels: [],
    hostnames: row.hostnames ?? [],
  };
}

function cachedReverseDnsToReverseDnsRecord(row: CachedReverseDns): ReverseDnsRecord {
  const ptrHostnames = row.ptr_hostnames ?? [];
  const fallbackHostnames = row.fallback_hostnames ?? [];
  const hostnames = row.hostnames ?? [...new Set([...ptrHostnames, ...fallbackHostnames])];

  return {
    ipAddress: row.ip_address,
    hostnames,
    ptrHostnames,
    fallbackHostnames,
    error: row.error ?? undefined,
  };
}

function cachedExposureToExposureRecord(row: CachedExposure): ExposureRecord {
  return {
    ipAddress: row.ip_address,
    sourceProvider: 'internetdb',
    serviceCount: row.service_count ?? row.service_names?.length ?? 0,
    openPortCount: row.open_port_count ?? row.open_ports?.length ?? 0,
    topPorts: row.top_ports ?? row.open_ports?.map((port) => String(port)) ?? [],
    serviceNames: row.service_names ?? [],
    labels: row.labels ?? [],
    hostnames: row.hostnames ?? [],
    warning: row.warning ?? undefined,
    error: row.error ?? undefined,
  };
}

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

function mixHexColors(baseHex: string, tintHex: string, tintAmount: number): string {
  const base = baseHex.replace('#', '');
  const tint = tintHex.replace('#', '');
  const baseNumber = Number.parseInt(base, 16);
  const tintNumber = Number.parseInt(tint, 16);

  if (Number.isNaN(baseNumber) || Number.isNaN(tintNumber)) {
    return baseHex;
  }

  const amount = Math.max(0, Math.min(1, tintAmount));
  const baseRed = baseNumber >> 16;
  const baseGreen = (baseNumber >> 8) & 0xff;
  const baseBlue = baseNumber & 0xff;
  const tintRed = tintNumber >> 16;
  const tintGreen = (tintNumber >> 8) & 0xff;
  const tintBlue = tintNumber & 0xff;
  const red = Math.round(baseRed * (1 - amount) + tintRed * amount);
  const green = Math.round(baseGreen * (1 - amount) + tintGreen * amount);
  const blue = Math.round(baseBlue * (1 - amount) + tintBlue * amount);

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
  return `${normalizeAsn(record.asn)}${record.asnName ? ` - ${record.asnName}` : ''}${record.route ? ` (${record.route})` : ''}`;
}

function valueToDisplayText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (Array.isArray(value)) {
    return value.map((item) => valueToDisplayText(item)).filter(Boolean).join('; ');
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const preferred = objectValue.error ?? objectValue.details ?? objectValue.message ?? objectValue.reason ?? objectValue.statusText;
    if (preferred !== undefined && preferred !== value) {
      const preferredText = valueToDisplayText(preferred);
      if (preferredText) {
        return preferredText;
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      return 'Unserializable object error';
    }
  }

  return String(value);
}

function escapeHtml(value?: unknown): string {
  return valueToDisplayText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



function makeExternalLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline decoration-blue-400 underline-offset-2">${escapeHtml(label)}</a>`;
}

function linkifyText(value?: unknown): string {
  const text = valueToDisplayText(value);
  if (!text) {
    return '';
  }

  const pattern = /(https?:\/\/[^\s<>"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  let cursor = 0;
  let output = '';

  for (const match of text.matchAll(pattern)) {
    const rawMatch = match[0];
    const start = match.index ?? 0;
    output += escapeHtml(text.slice(cursor, start));

    const trailingMatch = rawMatch.match(/[),.;:!?]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const core = trailing ? rawMatch.slice(0, -trailing.length) : rawMatch;
    const href = core.toLowerCase().startsWith('http') ? core : `mailto:${core}`;

    output += makeExternalLink(href, core);
    output += escapeHtml(trailing);
    cursor = start + rawMatch.length;
  }

  output += escapeHtml(text.slice(cursor));
  return output;
}

function getAsnApiErrorMessage(...values: unknown[]): string {
  for (const value of values) {
    const text = valueToDisplayText(value).trim();
    if (text) {
      return text;
    }
  }
  return 'Unknown ASN lookup error';
}

function toTitleCaseStyleLabel(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAsnDiagnosticLabel(record: AsnRecord | undefined, loading: boolean): string {
  if (loading) return 'loading';
  if (record?.asn) return 'ok';
  if (record?.error) return `error: ${valueToDisplayText(record.error)}`;
  return 'not requested or no response yet';
}

function joinSentenceParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
}

function describeIpPurpose(ipTypeLabel: string): string {
  if (ipTypeLabel === 'Public') {
    return 'It is a public IPv4 address, so it can potentially correspond to an internet-facing machine or service.';
  }
  if (ipTypeLabel === 'Private') {
    return 'It is a private IPv4 address, so it is normally used inside a local network rather than routed directly on the public internet.';
  }
  if (ipTypeLabel === 'Loopback') {
    return 'It is a loopback address, normally used by a machine to refer to itself.';
  }
  if (ipTypeLabel === 'Multicast') {
    return 'It is in the multicast range, used for one-to-many network traffic rather than ordinary host addressing.';
  }
  return 'It is in a reserved or special-purpose IPv4 range, so public host information may be limited or absent.';
}

function getExposurePhrase(exposureRecord: ExposureRecord | undefined): string {
  if (!exposureRecord) {
    return 'Service exposure data has not loaded yet.';
  }
  if (exposureRecord.error) {
    return `Service exposure lookup is unavailable: ${valueToDisplayText(exposureRecord.error)}.`;
  }

  const visiblePorts = [...new Set((exposureRecord.topPorts ?? [])
    .map((portLabel) => parseTopPortNumber(portLabel))
    .filter((port): port is number => typeof port === 'number'))];

  if (visiblePorts.length === 0 && exposureRecord.openPortCount === 0 && exposureRecord.serviceCount === 0) {
    return 'No public-facing services were observed in the current exposure data.';
  }

  const serviceLabels: string[] = [];
  if (visiblePorts.includes(80) || visiblePorts.includes(443)) serviceLabels.push('web service');
  if (visiblePorts.includes(22)) serviceLabels.push('SSH');
  if (visiblePorts.includes(53)) serviceLabels.push('DNS');
  if (visiblePorts.some((port) => [25, 465, 587].includes(port))) serviceLabels.push('mail');
  if (visiblePorts.includes(3389)) serviceLabels.push('Remote Desktop');

  const countPhrase = exposureRecord.openPortCount === 1
    ? 'one open port'
    : `${exposureRecord.openPortCount} open ports`;

  if (serviceLabels.length > 0) {
    return `The exposure data reports ${countPhrase}, including ${serviceLabels.join(', ')}${visiblePorts.length > 0 ? ` on ports ${visiblePorts.slice(0, 6).join(', ')}` : ''}.`;
  }

  return `The exposure data reports ${countPhrase}${visiblePorts.length > 0 ? ` on ports ${visiblePorts.slice(0, 6).join(', ')}` : ''}, but these ports do not match the main service categories shown in the interface.`;
}

function getHostnamePhrase(dnsRecord: ReverseDnsRecord | undefined, topReverseDnsHostname: string | null, loading: boolean): string {
  if (loading) {
    return 'Hostname data is still loading.';
  }
  if (!dnsRecord) {
    return 'Hostname data has not loaded yet.';
  }
  if (dnsRecord.error) {
    return `Hostname lookup is unavailable: ${valueToDisplayText(dnsRecord.error)}.`;
  }
  if (topReverseDnsHostname) {
    return `The main hostname visible for this address is ${topReverseDnsHostname}.`;
  }
  return 'No hostname was found for this address.';
}

function getAsnPhrase(asnRecord: AsnRecord | undefined, loading: boolean): string {
  if (loading) {
    return 'ASN neighborhood data is still loading.';
  }
  if (!asnRecord) {
    return 'ASN neighborhood data has not loaded yet.';
  }
  if (asnRecord.error) {
    return `ASN lookup is unavailable: ${valueToDisplayText(asnRecord.error)}.`;
  }
  if (asnRecord.asn) {
    return joinSentenceParts([
      `Its ASN neighborhood is ${getAsnSummaryLabel(asnRecord)}.`,
      asnRecord.country ? `The ASN record lists ${asnRecord.country} as the country.` : null,
      asnRecord.registry ? `The registry source is ${asnRecord.registry}.` : null,
    ]);
  }
  return 'No ASN was returned for this address.';
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

function normalizeCountryText(value?: string | null): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'united states': 'us',
  'united states of america': 'us',
  usa: 'us',
  'u s a': 'us',
  us: 'us',
  'u s': 'us',
  'united kingdom': 'gb',
  'great britain': 'gb',
  uk: 'gb',
  'u k': 'gb',
  england: 'gb',
  scotland: 'gb',
  wales: 'gb',
  germany: 'de',
  deutschland: 'de',
  france: 'fr',
  netherlands: 'nl',
  'the netherlands': 'nl',
  canada: 'ca',
  japan: 'jp',
  china: 'cn',
  india: 'in',
  australia: 'au',
  brazil: 'br',
  mexico: 'mx',
  italy: 'it',
  spain: 'es',
  sweden: 'se',
  norway: 'no',
  finland: 'fi',
  denmark: 'dk',
  ireland: 'ie',
  switzerland: 'ch',
  austria: 'at',
  belgium: 'be',
  poland: 'pl',
  'czech republic': 'cz',
  czechia: 'cz',
  russia: 'ru',
  'south korea': 'kr',
  korea: 'kr',
  taiwan: 'tw',
  'hong kong': 'hk',
  singapore: 'sg',
  israel: 'il',
  'south africa': 'za',
  'new zealand': 'nz',
  argentina: 'ar',
  chile: 'cl',
  colombia: 'co',
  turkey: 'tr',
  turkiye: 'tr',
  ukraine: 'ua',
  romania: 'ro',
  portugal: 'pt',
  greece: 'gr',
  hungary: 'hu',
  bulgaria: 'bg',
  croatia: 'hr',
  slovakia: 'sk',
  slovenia: 'si',
  lithuania: 'lt',
  latvia: 'lv',
  estonia: 'ee',
};

function getFlagCountryCode(value?: string | null): string | null {
  const direct = getCountryCode(value ?? undefined);
  if (direct) {
    return direct;
  }

  const normalized = normalizeCountryText(value);
  if (!normalized) {
    return null;
  }

  return COUNTRY_NAME_TO_CODE[normalized] ?? null;
}

function getBestFlagCountryCode(rdapRecord?: RdapRecord, asnRecord?: AsnRecord): string | null {
  return getFlagCountryCode(rdapRecord?.country) ?? getFlagCountryCode(asnRecord?.country);
}

type OrganizationCategory = 'cloud' | 'telecom' | 'education' | 'government' | 'residential' | 'security' | 'commercial' | 'unknown';

type BuildingVisualStyle = {
  category: OrganizationCategory;
  bodyColor: string;
  trimColor: string;
  roofColor: string;
  windowColor: string;
  windowOpacity: number;
  windowEmissiveIntensity: number;
  accentColor: string;
  footprintScale: number;
  roofLift: number;
  metalness: number;
  roughness: number;
};

type BaseBuildingVisualStyle = Omit<BuildingVisualStyle, 'category' | 'bodyColor' | 'trimColor' | 'roofColor' | 'accentColor'> & {
  bodyBase: string;
  trimBase: string;
  roofBase: string;
  accentBase: string;
};

type BuildingPalette = {
  name: string;
  body: string;
  trim: string;
  roof: string;
  accent: string;
};

type BuildingFootprint = {
  widthScale: number;
  depthScale: number;
};

type RoofVariant = 'flat' | 'cap' | 'parapet' | 'penthouse' | 'antenna' | 'water-tower' | 'green' | 'solar';
type WindowPattern = 'bands' | 'grid' | 'vertical' | 'sparse' | 'lobby';

const UNKNOWN_BUILDING_PALETTE: BuildingPalette = {
  name: 'neutral gray',
  body: '#6b7280',
  trim: '#4b5563',
  roof: '#374151',
  accent: '#d1d5db',
};

const BUILDING_PALETTES: BuildingPalette[] = [
  { name: 'charcoal', body: '#111827', trim: '#374151', roof: '#030712', accent: '#9ca3af' },
  { name: 'light stone', body: '#f5f5f4', trim: '#d6d3d1', roof: '#78716c', accent: '#9ca3af' },
  { name: 'gray concrete', body: '#6b7280', trim: '#4b5563', roof: '#374151', accent: '#d1d5db' },
  { name: 'brown brick', body: '#7c2d12', trim: '#431407', roof: '#292524', accent: '#fed7aa' },
  { name: 'red brick', body: '#991b1b', trim: '#450a0a', roof: '#1c1917', accent: '#fecaca' },
  { name: 'tan sandstone', body: '#a16207', trim: '#713f12', roof: '#44403c', accent: '#fde68a' },
  { name: 'blue gray glass', body: '#334155', trim: '#1e293b', roof: '#0f172a', accent: '#bfdbfe' },
  { name: 'green gray', body: '#365314', trim: '#1a2e05', roof: '#111827', accent: '#d9f99d' },
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function getBuildingPaletteForAsn(asn?: string | null): BuildingPalette {
  const normalized = normalizeAsn(asn);
  if (!normalized) {
    return UNKNOWN_BUILDING_PALETTE;
  }

  return BUILDING_PALETTES[hashString(normalized) % BUILDING_PALETTES.length];
}

function getBuildingFootprint(seed: number, category: OrganizationCategory): BuildingFootprint {
  const categoryBias: Record<OrganizationCategory, BuildingFootprint> = {
    cloud: { widthScale: 0.98, depthScale: 0.94 },
    telecom: { widthScale: 0.86, depthScale: 0.88 },
    education: { widthScale: 1.06, depthScale: 1.02 },
    government: { widthScale: 1.04, depthScale: 1.04 },
    residential: { widthScale: 0.82, depthScale: 0.9 },
    security: { widthScale: 1, depthScale: 1 },
    commercial: { widthScale: 0.96, depthScale: 0.94 },
    unknown: { widthScale: 0.88, depthScale: 0.88 },
  };
  const bias = categoryBias[category];
  const widthScale = Math.min(1.1, Math.max(0.75, bias.widthScale * (0.88 + pseudoRandom(seed + 17) * 0.24)));
  const depthScale = Math.min(1.1, Math.max(0.75, bias.depthScale * (0.88 + pseudoRandom(seed + 23) * 0.24)));
  return { widthScale, depthScale };
}

function getHeightVariation(seed: number, serviceCount: number): number {
  const variation = 0.88 + pseudoRandom(seed + 31) * 0.28;
  return serviceCount === 0 ? Math.min(variation, 1.04) : variation;
}

function getRoofVariant(seed: number, category: OrganizationCategory, exposureRecord?: ExposureRecord): RoofVariant {
  const ports = new Set(
    (exposureRecord?.topPorts ?? [])
      .map((portLabel) => parseTopPortNumber(portLabel))
      .filter((port): port is number => typeof port === 'number')
  );
  const openPortCount = exposureRecord?.openPortCount ?? 0;
  const roll = pseudoRandom(seed + 43);

  if (category === 'telecom' || ports.has(53) || ports.has(22)) {
    return roll > 0.28 ? 'antenna' : 'penthouse';
  }
  if (category === 'education' || category === 'residential') {
    return roll > 0.52 ? 'green' : roll > 0.26 ? 'penthouse' : 'parapet';
  }
  if (ports.has(80) || ports.has(443) || category === 'cloud') {
    return roll > 0.58 ? 'solar' : roll > 0.24 ? 'penthouse' : 'cap';
  }
  if (openPortCount >= 5 || category === 'security') {
    return roll > 0.45 ? 'parapet' : 'antenna';
  }
  if (roll > 0.82) return 'water-tower';
  if (roll > 0.62) return 'solar';
  if (roll > 0.32) return 'parapet';
  return 'cap';
}

function getWindowPattern(seed: number, category: OrganizationCategory): WindowPattern {
  const categoryPatterns: Record<OrganizationCategory, WindowPattern[]> = {
    cloud: ['vertical', 'bands', 'lobby'],
    telecom: ['sparse', 'vertical', 'bands'],
    education: ['grid', 'bands', 'lobby'],
    government: ['grid', 'bands', 'sparse'],
    residential: ['grid', 'sparse', 'bands'],
    security: ['sparse', 'vertical', 'bands'],
    commercial: ['bands', 'vertical', 'lobby'],
    unknown: ['sparse', 'bands', 'grid'],
  };
  const patterns = categoryPatterns[category];
  return patterns[Math.floor(pseudoRandom(seed + 59) * patterns.length)];
}

function includesAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function getOrganizationCategory(
  rdapRecord: RdapRecord | undefined,
  asnRecord: AsnRecord | undefined,
  dnsRecord: ReverseDnsRecord | undefined,
  exposureRecord: ExposureRecord | undefined,
  ipTypeLabel: string
): OrganizationCategory {
  if (ipTypeLabel !== 'Public') {
    return 'unknown';
  }

  const corpus = [
    rdapRecord?.org,
    rdapRecord?.networkName,
    rdapRecord?.handle,
    asnRecord?.asnName,
    asnRecord?.route,
    ...(dnsRecord?.hostnames ?? []),
    ...(exposureRecord?.serviceNames ?? []),
    ...(exposureRecord?.labels ?? []),
  ].filter(Boolean).join(' ').toLowerCase();

  if (!corpus) {
    return 'unknown';
  }

  if (includesAny(corpus, ['security', 'firewall', 'vpn', 'proxy', 'waf', 'secure', 'scanner', 'threat'])) {
    return 'security';
  }

  if (includesAny(corpus, ['university', 'college', 'school', '.edu', 'research', 'academy', 'institute'])) {
    return 'education';
  }

  if (includesAny(corpus, ['government', 'gov', 'military', 'defense', 'department', 'army', 'navy', 'air force', 'state of'])) {
    return 'government';
  }

  if (includesAny(corpus, ['dynamic', 'dhcp', 'pool', 'pppoe', 'residential', 'broadband', 'dsl', 'cable modem', 'customer'])) {
    return 'residential';
  }

  if (includesAny(corpus, ['telecom', 'communications', 'wireless', 'cellular', 'broadband', 'cable', 'spectrum', 'comcast', 'verizon', 'at&t', 'charter', 'isp'])) {
    return 'telecom';
  }

  if (includesAny(corpus, ['cloud', 'hosting', 'hosted', 'cdn', 'edge', 'compute', 'amazon', 'aws', 'google', 'microsoft', 'azure', 'cloudflare', 'akamai', 'fastly', 'digitalocean', 'linode', 'vultr', 'ovh', 'hetzner'])) {
    return 'cloud';
  }

  return rdapRecord?.org || asnRecord?.asnName ? 'commercial' : 'unknown';
}

function getBuildingVisualStyle(category: OrganizationCategory, asnColor: string, seed: number, asn?: string | null): BuildingVisualStyle {
  const jitter = Math.round((pseudoRandom(seed + 811) - 0.5) * 14);
  const baseStyles: Record<OrganizationCategory, BaseBuildingVisualStyle> = {
    cloud: {
      bodyBase: '#1e3a8a',
      trimBase: '#0f172a',
      roofBase: '#082f49',
      accentBase: '#38bdf8',
      windowColor: '#dbeafe',
      windowOpacity: 0.52,
      windowEmissiveIntensity: 0.4,
      footprintScale: 0.94,
      roofLift: 0.06,
      metalness: 0.35,
      roughness: 0.32,
    },
    telecom: {
      bodyBase: '#0f766e',
      trimBase: '#134e4a',
      roofBase: '#042f2e',
      accentBase: '#facc15',
      windowColor: '#ccfbf1',
      windowOpacity: 0.42,
      windowEmissiveIntensity: 0.3,
      footprintScale: 0.88,
      roofLift: 0.12,
      metalness: 0.22,
      roughness: 0.5,
    },
    education: {
      bodyBase: '#475569',
      trimBase: '#334155',
      roofBase: '#14532d',
      accentBase: '#86efac',
      windowColor: '#fef9c3',
      windowOpacity: 0.38,
      windowEmissiveIntensity: 0.22,
      footprintScale: 1.06,
      roofLift: 0.02,
      metalness: 0.05,
      roughness: 0.78,
    },
    government: {
      bodyBase: '#6b7280',
      trimBase: '#374151',
      roofBase: '#1f2937',
      accentBase: '#e5e7eb',
      windowColor: '#e0f2fe',
      windowOpacity: 0.32,
      windowEmissiveIntensity: 0.18,
      footprintScale: 1.02,
      roofLift: 0.04,
      metalness: 0.08,
      roughness: 0.86,
    },
    residential: {
      bodyBase: '#52525b',
      trimBase: '#3f3f46',
      roofBase: '#713f12',
      accentBase: '#fb923c',
      windowColor: '#fde68a',
      windowOpacity: 0.36,
      windowEmissiveIntensity: 0.24,
      footprintScale: 0.78,
      roofLift: 0,
      metalness: 0.02,
      roughness: 0.9,
    },
    security: {
      bodyBase: '#7f1d1d',
      trimBase: '#450a0a',
      roofBase: '#111827',
      accentBase: '#f87171',
      windowColor: '#fee2e2',
      windowOpacity: 0.3,
      windowEmissiveIntensity: 0.2,
      footprintScale: 0.96,
      roofLift: 0.08,
      metalness: 0.18,
      roughness: 0.55,
    },
    commercial: {
      bodyBase: '#1f2937',
      trimBase: '#111827',
      roofBase: '#030712',
      accentBase: '#a78bfa',
      windowColor: '#dfe8ff',
      windowOpacity: 0.42,
      windowEmissiveIntensity: 0.28,
      footprintScale: 0.92,
      roofLift: 0.04,
      metalness: 0.2,
      roughness: 0.52,
    },
    unknown: {
      bodyBase: '#111827',
      trimBase: '#1f2937',
      roofBase: '#030712',
      accentBase: '#9ca3af',
      windowColor: '#dfe8ff',
      windowOpacity: 0.26,
      windowEmissiveIntensity: 0.12,
      footprintScale: 0.86,
      roofLift: 0,
      metalness: 0.06,
      roughness: 0.82,
    },
  };

  const base = baseStyles[category];
  const palette = getBuildingPaletteForAsn(asn);
  const bodyBase = mixHexColors(palette.body, base.bodyBase, 0.1);
  const trimBase = mixHexColors(palette.trim, base.trimBase, 0.08);
  const roofBase = mixHexColors(palette.roof, base.roofBase, 0.08);
  const accentColor = mixHexColors(palette.accent, base.accentBase, 0.22);

  return {
    category,
    bodyColor: shadeColor(mixHexColors(bodyBase, asnColor, category === 'unknown' ? 0.01 : 0.025), jitter),
    trimColor: shadeColor(mixHexColors(trimBase, asnColor, category === 'unknown' ? 0.01 : 0.018), Math.round(jitter * 0.5)),
    roofColor: shadeColor(mixHexColors(roofBase, asnColor, category === 'unknown' ? 0.005 : 0.014), Math.round(jitter * 0.35)),
    windowColor: base.windowColor,
    windowOpacity: base.windowOpacity,
    windowEmissiveIntensity: base.windowEmissiveIntensity,
    accentColor,
    footprintScale: base.footprintScale,
    roofLift: base.roofLift,
    metalness: base.metalness,
    roughness: base.roughness,
  };
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

type BgpRoutingCell = {
  x: number;
  y: number;
  ipAddress: string;
  asn?: string | null;
  asnColor?: string;
};

type BgpRoutingLayerProps = StreetTrafficLayerProps & {
  events: BgpVisualEvent[];
  visibleCells: BgpRoutingCell[];
};

function AmbientTrafficLayer({ gridSize, spacing, offset, groundY }: StreetTrafficLayerProps) {
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
          key={`ambient-flow-${index}`}
          ref={(node) => {
            refs.current[index] = node;
          }}
          rotation={[-Math.PI / 2, 0, flow.horizontal ? 0 : Math.PI / 2]}
        >
          <planeGeometry args={[flow.length, flow.width]} />
          <meshStandardMaterial
            color={flow.color}
            emissive={flow.color}
            emissiveIntensity={1.25}
            transparent
            opacity={0.62}
          />
        </mesh>
      ))}
    </>
  );
}

function getBgpEventColor(type: BgpVisualEvent['type'], fallbackColor?: string): string {
  if (type === 'withdrawal') return '#F87171';
  if (type === 'path_change') return '#A78BFA';
  if (type === 'flap') return '#F59E0B';
  return fallbackColor ?? '#34D399';
}

function BgpRoutingLayer({ gridSize, spacing, offset, groundY, events, visibleCells }: BgpRoutingLayerProps) {
  const maxVisibleStreaks = 40;
  const refs = useRef<Array<THREE.Mesh | null>>([]);

  const flows = useMemo(() => {
    const eventWindowMs = 5 * 60 * 1000;
    const now = Date.now();
    const normalizedCells = visibleCells
      .map((cell) => ({ ...cell, normalizedAsn: normalizeAsn(cell.asn) }))
      .filter((cell) => Boolean(cell.normalizedAsn));
    const nextFlows: Array<{
      key: string;
      horizontal: boolean;
      laneCenter: number;
      cellCenter: number;
      travelPositive: boolean;
      speed: number;
      phase: number;
      width: number;
      length: number;
      y: number;
      color: string;
      opacity: number;
      emissiveIntensity: number;
    }> = [];

    for (const event of events) {
      if (nextFlows.length >= maxVisibleStreaks) {
        break;
      }

      const eventAsn = normalizeAsn(event.asn);
      if (!eventAsn) {
        continue;
      }

      const eventTime = Date.parse(event.timestamp);
      if (!Number.isFinite(eventTime) || now - eventTime > eventWindowMs) {
        continue;
      }

      const matchingCells = normalizedCells.filter((cell) => cell.normalizedAsn === eventAsn);
      if (matchingCells.length === 0) {
        continue;
      }

      const intensity = Math.max(1, Math.min(10, event.intensity || 1));
      const streakCount = Math.min(4, Math.max(1, Math.ceil(intensity / 4)));
      for (let copyIndex = 0; copyIndex < streakCount && nextFlows.length < maxVisibleStreaks; copyIndex += 1) {
        const seed = hashString(`${event.id}:${event.asn ?? ''}:${event.prefix ?? ''}:${event.timestamp}:${copyIndex}`);
        const matchedCell = matchingCells[seed % matchingCells.length];
        const horizontal = seed % 2 === 0;
        const laneDirection = (seed >>> 2) % 2 === 0 ? -1 : 1;
        const laneIndex = horizontal
          ? Math.max(0, Math.min(gridSize, matchedCell.y + (laneDirection > 0 ? 1 : 0)))
          : Math.max(0, Math.min(gridSize, matchedCell.x + (laneDirection > 0 ? 1 : 0)));
        const laneCenter = laneIndex * spacing - offset - spacing / 2;
        const cellCenter = (horizontal ? matchedCell.x : matchedCell.y) * spacing - offset;
        const ageFactor = Math.max(0.2, 1 - (now - eventTime) / eventWindowMs);
        const baseOpacity = event.type === 'withdrawal' ? 0.5 : event.type === 'path_change' ? 0.72 : event.type === 'flap' ? 0.84 : 0.76;

        nextFlows.push({
          key: `${event.id}-${copyIndex}`,
          horizontal,
          laneCenter,
          cellCenter,
          travelPositive: (seed >>> 3) % 2 === 0,
          speed: 0.28 + ((seed >>> 5) % 7) * 0.04 + intensity * 0.012,
          phase: ((seed >>> 8) % 1000) / 1000,
          width: 0.14 + Math.min(0.16, intensity * 0.014),
          length: 0.42 + Math.min(0.5, intensity * 0.05),
          y: groundY + 0.048 + ((seed >>> 12) % 4) * 0.005,
          color: getBgpEventColor(event.type, matchedCell.asnColor),
          opacity: Math.min(0.95, baseOpacity * ageFactor + intensity * 0.015),
          emissiveIntensity: event.type === 'flap' ? 2.1 : event.type === 'path_change' ? 1.75 : 1.45,
        });
      }
    }

    return nextFlows;
  }, [events, visibleCells, gridSize, spacing, offset, groundY]);

  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    const localTravel = spacing * 1.7;

    flows.forEach((flow, index) => {
      const mesh = refs.current[index];
      if (!mesh) {
        return;
      }

      const progress = ((elapsed * flow.speed + flow.phase) % 1) - 0.5;
      const along = flow.cellCenter + progress * localTravel * (flow.travelPositive ? 1 : -1);

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
          key={`bgp-routing-flow-${flow.key}`}
          ref={(node) => {
            refs.current[index] = node;
          }}
          rotation={[-Math.PI / 2, 0, flow.horizontal ? 0 : Math.PI / 2]}
        >
          <planeGeometry args={[flow.length, flow.width]} />
          <meshStandardMaterial
            color={flow.color}
            emissive={flow.color}
            emissiveIntensity={flow.emissiveIntensity}
            transparent
            opacity={flow.opacity}
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
  onCellClick,
  onCellDoubleClick,
  onBuildingClick,
  onBuildingDoubleClick,
  lookupMode,
  gridSystemMode = 'grid1',
  grid2Position = DEFAULT_GRID2_POSITION,
  onHoverInfoHtml,
  onHoverCellChange,
  infoDisplayMode = 'structured',
  remoteUsers = [],
  onRemoteUserClick,
  bgpEvents = [],
  selectedBuildingIp,
  selectedBuildingFlagImageUrl,
  selectedBuildingCountryCodeLabel,
}: IPGridProps) {
  const gridSize = 16;
  const spacing = 1.9;
  const cubeSize = 0.92;
  const roadWidth = spacing - cubeSize;
  const sidewalkInset = 0.08;
  const groundY = -cubeSize / 2;
  const offset = (gridSize * spacing) / 2 - spacing / 2;
  const gridExtent = gridSize * spacing;

  const [hoveredCell, setHoveredCell] = useState<HoveredCellState | null>(null);
  const hoveredCellRef = useRef<HoveredCellState | null>(null);
  const lastInfoBoxCellRef = useRef<GridCellTarget | null>(null);
  const hoveredIpAddress = hoveredCell?.ipAddress ?? null;
  const hoveredCellKey = hoveredCell?.cellKey ?? null;
  const [rdapInfo, setRdapInfo] = useState<Record<string, RdapRecord>>({});
  const [reverseDnsInfo, setReverseDnsInfo] = useState<Record<string, ReverseDnsRecord>>({});
  const [exposureInfo, setExposureInfo] = useState<Record<string, ExposureRecord>>({});
  const [asnInfo, setAsnInfo] = useState<Record<string, AsnRecord>>({});
  const [isRdapLoading, setIsRdapLoading] = useState<Record<string, boolean>>({});
  const [isReverseLoading, setIsReverseLoading] = useState<Record<string, boolean>>({});
  const [isExposureLoading, setIsExposureLoading] = useState<Record<string, boolean>>({});
  const [isAsnLoading, setIsAsnLoading] = useState<Record<string, boolean>>({});
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
    }
    document.body.style.cursor = 'auto';
  }, []);

  const setActiveCellHover = (target: GridCellTarget, part: CellHoverPart) => {
    const nextHover = {
      cellKey: target.cellKey,
      ipAddress: target.cellBuilding.ipAddress,
      part,
    };
    hoveredCellRef.current = nextHover;
    document.body.style.cursor = 'pointer';
    setHoveredCell((current) => (
      current?.cellKey === nextHover.cellKey &&
      current.ipAddress === nextHover.ipAddress &&
      current.part === nextHover.part
        ? current
        : nextHover
    ));
    onHoverCellChange?.(target.cellBuilding);
    onHoverInfoHtml?.(target.hoverInfoHtml);
    lastInfoBoxCellRef.current = target;
  };

  const clearCellHover = (cellKey?: string) => {
    if (cellKey && hoveredCellRef.current?.cellKey !== cellKey) {
      return;
    }
    hoveredCellRef.current = null;
    document.body.style.cursor = 'auto';
    setHoveredCell(null);
  };

  // Click navigation intentionally uses the last cell displayed in the information box,
  // not the mesh that received the click.
  const getDisplayedClickCell = (fallback: GridCellBuilding): GridCellBuilding => (
    lastInfoBoxCellRef.current?.cellBuilding ?? fallback
  );

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

  const visibleIpAddresses = useMemo(
    () => visibleLookupAddresses.map((item) => item.ipAddress),
    [visibleLookupAddresses]
  );
  const metadataCache = useIpMetadataCache(visibleIpAddresses);

  useEffect(() => {
    const nextRdapInfo: Record<string, RdapRecord> = {};
    const nextAsnInfo: Record<string, AsnRecord> = {};
    const nextReverseDnsInfo: Record<string, ReverseDnsRecord> = {};
    const nextExposureInfo: Record<string, ExposureRecord> = {};

    for (const row of Object.values(metadataCache.ipMetadataByIp)) {
      const asn = normalizeAsn(row.asn);
      const rdapRecord = cachedIpMetadataToRdapRecord(row);
      const asnRecord = cachedMetadataToAsnRecord(row, asn ? metadataCache.asnMetadataByAsn[asn] : undefined);
      const reverseDnsRecord = cachedIpMetadataToReverseDnsRecord(row);
      const exposureRecord = cachedIpMetadataToExposureRecord(row);

      if (rdapRecord) {
        rdapCache[row.ip_address] = rdapRecord;
        nextRdapInfo[row.ip_address] = rdapRecord;
      }

      if (asnRecord) {
        asnCache[row.ip_address] = asnRecord;
        nextAsnInfo[row.ip_address] = asnRecord;
      }

      if (reverseDnsRecord) {
        reverseDnsCache[row.ip_address] = reverseDnsRecord;
        nextReverseDnsInfo[row.ip_address] = reverseDnsRecord;
      }

      if (exposureRecord) {
        exposureCache[row.ip_address] = exposureRecord;
        nextExposureInfo[row.ip_address] = exposureRecord;
      }
    }

    for (const row of Object.values(metadataCache.reverseDnsByIp)) {
      const record = cachedReverseDnsToReverseDnsRecord(row);
      reverseDnsCache[row.ip_address] = record;
      nextReverseDnsInfo[row.ip_address] = record;
    }

    for (const row of Object.values(metadataCache.exposureByIp)) {
      const record = cachedExposureToExposureRecord(row);
      exposureCache[row.ip_address] = record;
      nextExposureInfo[row.ip_address] = record;
    }

    if (Object.keys(nextRdapInfo).length > 0) {
      setRdapInfo((prev) => ({ ...prev, ...nextRdapInfo }));
    }
    if (Object.keys(nextAsnInfo).length > 0) {
      setAsnInfo((prev) => ({ ...prev, ...nextAsnInfo }));
    }
    if (Object.keys(nextReverseDnsInfo).length > 0) {
      setReverseDnsInfo((prev) => ({ ...prev, ...nextReverseDnsInfo }));
    }
    if (Object.keys(nextExposureInfo).length > 0) {
      setExposureInfo((prev) => ({ ...prev, ...nextExposureInfo }));
    }
  }, [metadataCache.ipMetadataByIp, metadataCache.asnMetadataByAsn, metadataCache.reverseDnsByIp, metadataCache.exposureByIp]);

  const visibleBgpCells = useMemo<BgpRoutingCell[]>(
    () =>
      visibleLookupAddresses.map((item, index) => {
        const asnRecord = asnInfo[item.ipAddress] ?? asnCache[item.ipAddress];
        return {
          x: index % gridSize,
          y: Math.floor(index / gridSize),
          ipAddress: item.ipAddress,
          asn: asnRecord?.asn,
          asnColor: getAsnColor(asnRecord?.asn),
        };
      }),
    [visibleLookupAddresses, asnInfo, gridSize]
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

      let json: { records?: AsnRecord[]; error?: unknown; details?: unknown; message?: unknown } = {};
      const responseText = await response.text();
      if (responseText.trim()) {
        try {
          json = JSON.parse(responseText) as { records?: AsnRecord[]; error?: unknown; details?: unknown; message?: unknown };
        } catch {
          const looksLikeHtml = responseText.trim().startsWith('<');
          json = {
            error: looksLikeHtml
              ? `The Vercel route /api/asn returned HTML instead of JSON. Put api/asn.ts at the repository root, commit it, and redeploy. Status ${response.status}.`
              : `ASN endpoint returned non-JSON text. Status ${response.status}. First characters: ${responseText.slice(0, 120)}`,
          };
        }
      }

      if (!response.ok) {
        const message = getAsnApiErrorMessage(json.error, json.details, json.message, `ASN lookup failed with status ${response.status}`);
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
          error: record.error ? getAsnApiErrorMessage(record.error) : undefined,
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
      const message = getAsnApiErrorMessage(error);
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
    if (metadataCache.loading) {
      return;
    }

    void performExposureLookup(visibleIpAddresses);
    void performAsnLookup(visibleIpAddresses);
  }, [visibleIpAddresses, metadataCache.loading]);

  useEffect(() => {
    if (metadataCache.loading) {
      return;
    }

    let cancelled = false;
    const uncached = visibleIpAddresses
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
  }, [visibleIpAddresses, metadataCache.loading]);

  useEffect(() => {
    if (!hoveredIpAddress) {
      return;
    }

    if (metadataCache.loading) {
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
  }, [hoveredIpAddress, lookupMode, metadataCache.loading]);


  useEffect(() => {
    if (!hoveredIpAddress || !onHoverInfoHtml) {
      return;
    }

    const activePanel = document.querySelector('div[data-info-panel="true"]') as HTMLDivElement | null;
    if (activePanel?.innerHTML) {
      onHoverInfoHtml(activePanel.innerHTML);
    }
  }, [hoveredIpAddress, rdapInfo, reverseDnsInfo, exposureInfo, asnInfo, isRdapLoading, isReverseLoading, isExposureLoading, isAsnLoading, lookupMode, infoDisplayMode, onHoverInfoHtml]);

  const getColumnPerimeterLabel = (column: number): string => {
    if (gridSystemMode === 'grid2') {
      return `${clampOctet(grid2Position.innerFourthStart + column)}`;
    }

    return `+${column}`;
  };

  const getRowPerimeterLabel = (row: number): string => {
    if (gridSystemMode === 'grid2') {
      return `${clampOctet(grid2Position.innerThirdStart + row)}`;
    }

    return `${row * gridSize}`;
  };

  const createStreetGrid = () => {
    const items = [];
    const laneMarkings = [];
    const perimeterLabels = [];

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

    const labelY = groundY + 0.024;
    const labelPlateY = groundY + 0.004;
    const labelColor = '#f9fafb';
    const labelOutlineColor = '#000000';
    const labelPlateColor = '#4b5563';
    const labelFontSize = gridSystemMode === 'grid2' ? 0.38 : 0.48;
    const outerMarginCenter = -offset - spacing * 1.35;
    const columnLabelZ = outerMarginCenter;
    const rowLabelX = outerMarginCenter;

    for (let column = 0; column < gridSize; column += 1) {
      perimeterLabels.push(
        <mesh
          key={`column-label-plate-${column}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[column * spacing - offset, labelPlateY, columnLabelZ]}
          receiveShadow
        >
          <planeGeometry args={[1.25, 0.76]} />
          <meshStandardMaterial color={labelPlateColor} />
        </mesh>
      );
      perimeterLabels.push(
        <Text
          key={`column-label-${column}`}
          position={[column * spacing - offset, labelY, columnLabelZ]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={labelFontSize}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.04}
          outlineColor={labelOutlineColor}
        >
          {getColumnPerimeterLabel(column)}
        </Text>
      );
    }

    for (let row = 0; row < gridSize; row += 1) {
      perimeterLabels.push(
        <mesh
          key={`row-label-plate-${row}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[rowLabelX, labelPlateY, row * spacing - offset]}
          receiveShadow
        >
          <planeGeometry args={[1.35, 0.76]} />
          <meshStandardMaterial color={labelPlateColor} />
        </mesh>
      );
      perimeterLabels.push(
        <Text
          key={`row-label-${row}`}
          position={[rowLabelX, labelY, row * spacing - offset]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={labelFontSize}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.04}
          outlineColor={labelOutlineColor}
        >
          {getRowPerimeterLabel(row)}
        </Text>
      );
    }

    // ASN ownership is now shown directly through each square's base color.
    // The previous raised outline layer is intentionally omitted so same-ASN
    // neighborhoods read as solid colored land parcels rather than bordered cells.

    return (
      <>
        {items}
        {laneMarkings}
        {perimeterLabels}
        <AmbientTrafficLayer gridSize={gridSize} spacing={spacing} offset={offset} groundY={groundY} />
        <BgpRoutingLayer
          gridSize={gridSize}
          spacing={spacing}
          offset={offset}
          groundY={groundY}
          events={bgpEvents}
          visibleCells={visibleBgpCells}
        />
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
      const serviceHeight = getHeightFromServiceCount(cubeSize, serviceCount);
      const ipTypeLabel = getIpTypeLabel(firstOctetValue, secondOctetValue);
      const color = getIPColor(firstOctetValue, secondOctetValue, thirdOctetValue, fourthOctetValue);
      const xPos = x * spacing - offset;
      const zPos = y * spacing - offset;
      const cubeId = `cube-${x}-${y}`;
      const seed =
        label +
        firstOctetValue * 1000000 +
        secondOctetValue * 10000 +
        thirdOctetValue * 100 +
        fourthOctetValue +
        (gridSystemMode === 'grid2' ? 2000000 : zoomLevel * 10000);
      const rdapRecord = rdapInfo[ipAddress] ?? rdapCache[ipAddress];
      const asnRecord = asnInfo[ipAddress] ?? asnCache[ipAddress];
      const cachedIpMetadata = metadataCache.ipMetadataByIp[ipAddress];
      const asnColor = getAsnColor(asnRecord?.asn);
      const dnsRecord = reverseDnsInfo[ipAddress] ?? reverseDnsCache[ipAddress];
      const organizationCategory = getOrganizationCategory(rdapRecord, asnRecord, dnsRecord, exposureRecord, ipTypeLabel);
      const visualStyle = getBuildingVisualStyle(organizationCategory, asnColor, seed, asnRecord?.asn);
      const heightVariation = getHeightVariation(seed, serviceCount);
      const buildingHeight = Math.min(cubeSize * 5.4, Math.max(cubeSize * 0.62, serviceHeight * heightVariation));
      const footprint = getBuildingFootprint(seed, organizationCategory);
      const roofVariant = getRoofVariant(seed, organizationCategory, exposureRecord);
      const windowPattern = getWindowPattern(seed, organizationCategory);
      const squareBaseColor = asnRecord?.asn
        ? mixHexColors(asnColor, visualStyle.bodyColor, 0.18)
        : mixHexColors('#9a9a9a', visualStyle.bodyColor, 0.12);
      const topReverseDnsHostname = dnsRecord?.ptrHostnames[0] ?? dnsRecord?.fallbackHostnames[0] ?? null;
      const visibleEntities = rdapRecord ? firstUsefulEntities(rdapRecord.entities) : [];
      const bestFlagCountryCode = getBestFlagCountryCode(rdapRecord, asnRecord);
      const cachedFlagCountryCode = getFlagCountryCode(cachedIpMetadata?.flag_country_code);
      const flagImageUrl =
        cachedIpMetadata?.flag_url ??
        (cachedFlagCountryCode ? getFlagImageUrl(cachedFlagCountryCode) : null) ??
        (bestFlagCountryCode ? getFlagImageUrl(bestFlagCountryCode) : null);
      const countryCodeLabel = (cachedFlagCountryCode ?? bestFlagCountryCode)?.toUpperCase() ?? '';
      const isSelectedBuilding = selectedBuildingIp === ipAddress;
      const visibleFlagImageUrl =
        isSelectedBuilding && selectedBuildingFlagImageUrl
          ? selectedBuildingFlagImageUrl
          : flagImageUrl;
      const visibleCountryCodeLabel =
        isSelectedBuilding && selectedBuildingCountryCodeLabel
          ? selectedBuildingCountryCodeLabel
          : countryCodeLabel;
      const countryName = cachedFlagCountryCode || bestFlagCountryCode
        ? getCountryName(cachedFlagCountryCode ?? bestFlagCountryCode ?? undefined)
        : null;
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
      const widthJitter = footprint.widthScale * visualStyle.footprintScale;
      const depthJitter = footprint.depthScale * visualStyle.footprintScale;
      const towerWidth = cubeSize * widthJitter;
      const towerDepth = cubeSize * depthJitter;
      const blockWidth = cubeSize * Math.min(1.08, Math.max(0.76, footprint.widthScale));
      const blockDepth = cubeSize * Math.min(1.08, Math.max(0.76, footprint.depthScale));
      const blockFaceWidth = blockWidth;
      const blockFaceDepth = blockDepth;
      const steppedWidth = cubeSize * Math.min(1.08, Math.max(0.82, footprint.widthScale * 1.02));
      const steppedDepth = cubeSize * Math.min(1.08, Math.max(0.82, footprint.depthScale * 1.02));
      const fortWidth = cubeSize * Math.min(1.12, Math.max(0.92, footprint.widthScale * 1.05));
      const fortDepth = cubeSize * Math.min(1.12, Math.max(0.92, footprint.depthScale * 1.05));
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
      const cellX = x;
      const cellY = y;
      const cellKey = `${cellX}-${cellY}`;
      const isHovered = hoveredCellKey === cellKey;
      const hoverLift = isHovered ? 0.035 : 0;
      const hoverScale = isHovered ? 1.018 : 1;
      const blockDoorWidth = 0.14 + pseudoRandom(seed + 201) * 0.08;
      const blockDoorHeight = 0.18 + pseudoRandom(seed + 202) * 0.08;
      const blockStairSteps = 2 + Math.floor(pseudoRandom(seed + 203) * 3);
      const blockWindowColumns = 2 + Math.floor(pseudoRandom(seed + 204) * 3);
      const blockWindowRows = 2 + Math.floor(pseudoRandom(seed + 205) * 3);
      const blockVariantIndex = Math.floor(pseudoRandom(seed + 206) * 4);
      const blockVariant = ['square', 'round', 'hex', 'courtyard'][blockVariantIndex] as 'square' | 'round' | 'hex' | 'courtyard';
      const tooltipX = x < gridSize / 2 ? towerWidth / 2 + 0.82 : -(towerWidth / 2 + 3.1);
      const tooltipY = roofTopY + 0.16;
      const facadeFlagY = Math.min(
        Math.max(0.85, roofTopY * 0.68),
        Math.max(0.85, roofTopY - 0.24)
      );
      const facadeFlagZ =
        buildingFamily === 'tower'
          ? towerDepth / 2 + 0.012
        : buildingFamily === 'block'
            ? blockDepth / 2 + 0.012
            : buildingFamily === 'stepped'
              ? steppedDepth / 2 + 0.012
              : fortDepth / 2 + 0.012;
      const facadeWidth = buildingFamily === 'tower' ? towerWidth : buildingFamily === 'block' ? blockWidth : buildingFamily === 'stepped' ? steppedWidth : fortWidth;
      const facadeDepth = buildingFamily === 'tower' ? towerDepth : buildingFamily === 'block' ? blockDepth : buildingFamily === 'stepped' ? steppedDepth : fortDepth;

      const buildingBodyColor = visualStyle.bodyColor;
      const trimColor = visualStyle.trimColor;
      const roofColor = visualStyle.roofColor;
      const hoveredSquareBaseColor = isHovered ? shadeColor(squareBaseColor, 18) : squareBaseColor;
      const sidewalkBaseColor = isHovered ? '#1f2937' : '#111827';
      const windowColor = visualStyle.windowColor;
      const architecturalStyleLabel = toTitleCaseStyleLabel(organizationCategory);

      const headerParts = [
        `Address ${ipAddress}`,
        ipTypeLabel,
        countryName ? countryName : '',
        asnRecord?.asn ? normalizeAsn(asnRecord.asn) ?? '' : '',
        organizationCategory !== 'unknown' ? architecturalStyleLabel : '',
        topReverseDnsHostname ? `reverse-dns: ${topReverseDnsHostname}` : '',
      ].filter(Boolean);

      const hoverInfoLines: string[] = [
        `<div class="font-bold">${escapeHtml(headerParts.join(' - '))}</div>`,
      ];

      if (isAsnLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching ASN neighborhood data...</div>');
      } else if (asnRecord?.asn) {
        hoverInfoLines.push(
          `<div class="mt-2 rounded p-1.5 text-xs" style="background:${escapeHtml(asnColor)};color:white">` +
          `<div><span class="font-semibold">ASN neighborhood:</span> ${linkifyText(getAsnSummaryLabel(asnRecord))}</div>` +
          `${asnRecord.country ? `<div>Country: ${linkifyText(asnRecord.country)}</div>` : ''}` +
          `${asnRecord.registry ? `<div>Registry: ${linkifyText(asnRecord.registry)}</div>` : ''}` +
          '</div>'
        );
      } else if (asnRecord?.error) {
        hoverInfoLines.push(`<div class="text-gray-600 mt-2 text-xs">ASN lookup unavailable: ${linkifyText(asnRecord.error)}</div>`);
      } else {
        hoverInfoLines.push(`<div class="text-gray-600 mt-2 text-xs">ASN status: ${linkifyText(getAsnDiagnosticLabel(asnRecord, Boolean(isAsnLoading[ipAddress])))}</div>`);
      }

      if (lookupMode === 'rdap' && isRdapLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching live RDAP record...</div>');
      }

      if (lookupMode === 'ptr' && isReverseLoading[ipAddress]) {
        hoverInfoLines.push('<div class="text-blue-700 mt-2">Fetching hostname data...</div>');
      }

      if (lookupMode === 'ptr' && !isReverseLoading[ipAddress] && dnsRecord?.error) {
        hoverInfoLines.push(`<div class="text-red-700 mt-2">${linkifyText(dnsRecord.error)}</div>`);
      }

      if (lookupMode === 'rdap' && !isRdapLoading[ipAddress] && rdapRecord && !rdapRecord.error) {
        const rdapLines: string[] = [];
        if (rdapRecord.org) {
          rdapLines.push(`<div><span class="text-gray-600">Organization:</span> ${linkifyText(rdapRecord.org)}</div>`);
        }
        if (rdapRecord.networkName) {
          rdapLines.push(`<div><span class="text-gray-600">Network:</span> ${linkifyText(rdapRecord.networkName)}</div>`);
        }
        if (visibleEntities.length > 0) {
          const entityHtml = visibleEntities.map((entity, index) =>
            `<div class="text-xs bg-gray-100 rounded p-1.5" data-entity-index="${index}">` +
            `${entity.name ? `<div>${linkifyText(entity.name)}</div>` : ''}` +
            `${entity.roles.length > 0 ? `<div class="text-gray-600">${linkifyText(entity.roles.join(', '))}</div>` : ''}` +
            `${entity.email ? `<div>${linkifyText(entity.email)}</div>` : ''}` +
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
          const ptrLines = dnsRecord.ptrHostnames.map((hostname) => `<div class="text-xs bg-gray-100 rounded p-1.5 break-all">${linkifyText(hostname)}</div>`).join('');
          const fallbackLines = dnsRecord.fallbackHostnames.map((hostname) => `<div class="text-xs bg-gray-100 rounded p-1.5 break-all">${linkifyText(hostname)}</div>`).join('');
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

      const structuredHoverInfoHtml = hoverInfoLines.join('');
      const proseSentences = [
        `This square represents Address ${ipAddress}.`,
        `The address is classified as ${ipTypeLabel.toLowerCase()}.`,
        countryName ? `The registration country currently shown is ${countryName}.` : null,
        describeIpPurpose(ipTypeLabel),
        getAsnPhrase(asnRecord, Boolean(isAsnLoading[ipAddress])),
        getExposurePhrase(exposureRecord),
        getHostnamePhrase(dnsRecord, topReverseDnsHostname, Boolean(isReverseLoading[ipAddress])),
      ];

      if (lookupMode === 'rdap') {
        if (isRdapLoading[ipAddress]) {
          proseSentences.push('RDAP registration data is still loading.');
        } else if (rdapRecord) {
          proseSentences.push(joinSentenceParts([
            rdapRecord.org ? `RDAP identifies the organization as ${rdapRecord.org}.` : null,
            rdapRecord.networkName ? `The network name is ${rdapRecord.networkName}.` : null,
            rdapRecord.cidr ? `The CIDR block is ${rdapRecord.cidr}.` : null,
            rdapRecord.startAddress && rdapRecord.endAddress ? `The registered range runs from ${rdapRecord.startAddress} to ${rdapRecord.endAddress}.` : null,
          ]) || 'No additional RDAP ownership details were returned for this address.');

          if (visibleEntities.length > 0) {
            const contactSentences = visibleEntities
              .map((entity) => joinSentenceParts([
                entity.name ? `Contact: ${entity.name}.` : null,
                entity.roles.length > 0 ? `Roles: ${entity.roles.join(', ')}.` : null,
                entity.email ? `Email: ${entity.email}.` : null,
              ]))
              .filter(Boolean);
            if (contactSentences.length > 0) {
              proseSentences.push(contactSentences.join(' '));
            }
          }
        }
      }

      const proseHoverHtml = `<p><span class="font-bold">Address ${escapeHtml(ipAddress)}</span>. ${linkifyText(joinSentenceParts(proseSentences))}</p>`;
      const hoverInfoHtml = infoDisplayMode === 'prose' ? proseHoverHtml : structuredHoverInfoHtml;

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
            ? blockFaceWidth * 0.88
            : buildingFamily === 'tower'
              ? towerWidth
              : buildingFamily === 'stepped'
                ? steppedWidth * 0.92
                : fortWidth * 0.94;

        const faceDepth =
          buildingFamily === 'block'
            ? blockFaceDepth * 0.88
            : buildingFamily === 'tower'
              ? towerDepth
              : buildingFamily === 'stepped'
                ? steppedDepth * 0.92
                : fortDepth * 0.94;

        const levels = Math.max(1, Math.floor(Math.max(0.22, effectiveHeight - 0.12) / 0.22));
        for (let level = 0; level < levels; level += 1) {
          const bandY = baseY + 0.12 + level * 0.22;
          if (bandY >= roofTopY - 0.08) {
            break;
          }
          if (windowPattern === 'sparse' && pseudoRandom(seed + level * 13) < 0.38) {
            continue;
          }
          const frontWindowWidth =
            windowPattern === 'vertical'
              ? faceWidth * 0.12
              : windowPattern === 'grid'
                ? faceWidth * 0.48
                : windowPattern === 'lobby' && level === 0
                  ? faceWidth * 0.74
                  : faceWidth * 0.68;
          const sideWindowWidth =
            windowPattern === 'vertical'
              ? faceDepth * 0.12
              : windowPattern === 'grid'
                ? faceDepth * 0.48
                : windowPattern === 'lobby' && level === 0
                  ? faceDepth * 0.74
                  : faceDepth * 0.68;
          const windowHeight = windowPattern === 'lobby' && level === 0 ? 0.13 : windowPattern === 'vertical' ? 0.16 : 0.075;
          const opacityBoost = windowPattern === 'lobby' && level === 0 ? 0.14 : 0;

          windowBands.push(
            <mesh key={`${cubeId}-win-front-${level}`} position={[0, bandY, faceDepth / 2 + 0.01]}>
              <planeGeometry args={[frontWindowWidth, windowHeight]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={visualStyle.windowEmissiveIntensity} transparent opacity={Math.min(0.72, visualStyle.windowOpacity + opacityBoost)} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-back-${level}`} position={[0, bandY, -faceDepth / 2 - 0.01]} rotation={[0, Math.PI, 0]}>
              <planeGeometry args={[frontWindowWidth, windowHeight]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={visualStyle.windowEmissiveIntensity * 0.75} transparent opacity={visualStyle.windowOpacity * 0.78} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-left-${level}`} position={[-faceWidth / 2 - 0.01, bandY, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <planeGeometry args={[sideWindowWidth, windowHeight]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={visualStyle.windowEmissiveIntensity * 0.75} transparent opacity={visualStyle.windowOpacity * 0.78} />
            </mesh>
          );
          windowBands.push(
            <mesh key={`${cubeId}-win-right-${level}`} position={[faceWidth / 2 + 0.01, bandY, 0]} rotation={[0, Math.PI / 2, 0]}>
              <planeGeometry args={[sideWindowWidth, windowHeight]} />
              <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={visualStyle.windowEmissiveIntensity * 0.75} transparent opacity={visualStyle.windowOpacity * 0.78} />
            </mesh>
          );
        }
      }

      const cellBuilding: GridCellBuilding = {
        x: cellX,
        y: cellY,
        ipAddress,
        label,
        color,
        buildingFamily,
        buildingHeight,
        flagImageUrl: visibleFlagImageUrl,
        countryCodeLabel: visibleCountryCodeLabel,
        asn: asnRecord?.asn,
        asnName: asnRecord?.asnName,
        route: asnRecord?.route,
        asnColor,
        organizationName: rdapRecord?.org ?? rdapRecord?.networkName,
      };
      const cellTarget: GridCellTarget = { cellKey, cubeId, cellBuilding, hoverInfoHtml };

      const handleBuildingSingleClick = (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const clickCell = getDisplayedClickCell(cellBuilding);
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
        }
        clickTimerRef.current = window.setTimeout(() => {
          (onBuildingClick ?? onCellClick)(clickCell);
          clickTimerRef.current = null;
        }, 180);
      };

      const handleBuildingDoubleClick = (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const clickCell = getDisplayedClickCell(cellBuilding);
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        (onBuildingDoubleClick ?? onBuildingClick ?? onCellDoubleClick)(clickCell);
      };

      const handleCellSingleClick = (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const clickCell = getDisplayedClickCell(cellBuilding);
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
        }
        clickTimerRef.current = window.setTimeout(() => {
          onCellClick(clickCell);
          clickTimerRef.current = null;
        }, 180);
      };

      const handleCellDoubleClick = (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const clickCell = getDisplayedClickCell(cellBuilding);
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        onCellDoubleClick(clickCell);
      };

      const handleCellPointer = (part: CellHoverPart) => (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setActiveCellHover(cellTarget, part);
      };

      const handleCellPointerOut = (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        clearCellHover(cellKey);
      };

      cubes.push(
        <group key={cubeId} position={[xPos, groundY, zPos]}>
          <mesh position={[0, 0.035 + hoverLift, 0]} receiveShadow>
            <boxGeometry args={[spacing - sidewalkInset, 0.07, spacing - sidewalkInset]} />
            <meshStandardMaterial color={hoveredSquareBaseColor} />
          </mesh>

          <mesh position={[0, 0.07 + hoverLift, 0]} receiveShadow>
            <boxGeometry args={[cubeSize + 0.1, 0.04, cubeSize + 0.1]} />
            <meshStandardMaterial color={sidewalkBaseColor} />
          </mesh>

          <mesh
            position={[0, 0.125, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={handleCellSingleClick}
            onDoubleClick={handleCellDoubleClick}
            onPointerOver={handleCellPointer('sidewalk')}
            onPointerMove={handleCellPointer('sidewalk')}
            onPointerOut={handleCellPointerOut}
          >
            <planeGeometry args={[spacing - 0.04, spacing - 0.04]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>

          <group position={[0, hoverLift, 0]} scale={[hoverScale, hoverScale, hoverScale]}>
            <mesh
              position={[0, hitboxHeight / 2, 0]}
              onClick={handleBuildingSingleClick}
              onDoubleClick={handleBuildingDoubleClick}
              onPointerOver={handleCellPointer('building')}
              onPointerMove={handleCellPointer('building')}
              onPointerOut={handleCellPointerOut}
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
                      <boxGeometry args={[blockWidth * 0.98, buildingHeight, blockDepth * 0.98]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[blockWidth * 0.9, 0.06, blockDepth * 0.9]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'round' && (
                  <>
                    <mesh position={[0, blockBaseHeight, 0]} castShadow receiveShadow>
                      <cylinderGeometry args={[Math.min(blockWidth, blockDepth) * 0.5, Math.min(blockWidth, blockDepth) * 0.5, buildingHeight, 28]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <cylinderGeometry args={[Math.min(blockWidth, blockDepth) * 0.46, Math.min(blockWidth, blockDepth) * 0.46, 0.06, 28]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'hex' && (
                  <>
                    <mesh position={[0, blockBaseHeight, 0]} castShadow receiveShadow>
                      <cylinderGeometry args={[Math.min(blockWidth, blockDepth) * 0.54, Math.min(blockWidth, blockDepth) * 0.54, buildingHeight, 6]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, 0]} castShadow>
                      <cylinderGeometry args={[Math.min(blockWidth, blockDepth) * 0.5, Math.min(blockWidth, blockDepth) * 0.5, 0.06, 6]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                  </>
                )}

                {blockVariant === 'courtyard' && (
                  <>
                    <mesh position={[0, blockBaseHeight, blockDepth * 0.34]} castShadow receiveShadow>
                      <boxGeometry args={[blockWidth * 0.98, buildingHeight, blockDepth * 0.3]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[0, blockBaseHeight, -blockDepth * 0.34]} castShadow receiveShadow>
                      <boxGeometry args={[blockWidth * 0.98, buildingHeight, blockDepth * 0.3]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[-blockWidth * 0.34, blockBaseHeight, 0]} castShadow receiveShadow>
                      <boxGeometry args={[blockWidth * 0.3, buildingHeight, blockDepth * 0.38]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[blockWidth * 0.34, blockBaseHeight, 0]} castShadow receiveShadow>
                      <boxGeometry args={[blockWidth * 0.3, buildingHeight, blockDepth * 0.38]} />
                      <meshStandardMaterial color={buildingBodyColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, blockDepth * 0.34]} castShadow>
                      <boxGeometry args={[blockWidth * 0.9, 0.06, blockDepth * 0.22]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[0, blockRoofTopY - 0.03, -blockDepth * 0.34]} castShadow>
                      <boxGeometry args={[blockWidth * 0.9, 0.06, blockDepth * 0.22]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[-blockWidth * 0.34, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[blockWidth * 0.22, 0.06, blockDepth * 0.3]} />
                      <meshStandardMaterial color={roofColor} />
                    </mesh>
                    <mesh position={[blockWidth * 0.34, blockRoofTopY - 0.03, 0]} castShadow>
                      <boxGeometry args={[blockWidth * 0.22, 0.06, blockDepth * 0.3]} />
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
                    position={[0, 0.075 + stepIndex * 0.025, blockDepth / 2 + 0.06 + stepIndex * 0.035]}
                    castShadow
                    receiveShadow
                  >
                    <boxGeometry args={[blockDoorWidth * 1.7 + stepIndex * 0.04, 0.025, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 12)} />
                  </mesh>
                ))}

                <mesh position={[0, 0.11 + blockDoorHeight / 2, blockDepth / 2 + 0.02]} castShadow>
                  <boxGeometry args={[blockDoorWidth, blockDoorHeight, 0.05]} />
                  <meshStandardMaterial color={shadeColor(trimColor, -16)} />
                </mesh>

                {blockVariant === 'square' &&
                  Array.from({ length: blockWindowRows }).map((_, rowIndex) =>
                    Array.from({ length: blockWindowColumns }).flatMap((__, colIndex) => {
                      const xOffset =
                        (colIndex - (blockWindowColumns - 1) / 2) * (blockWidth * 0.22);
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return [
                        <mesh
                          key={`${cubeId}-block-window-front-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, blockDepth / 2 + 0.021]}
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
                          position={[xOffset, yOffset, -blockDepth / 2 - 0.021]}
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
                          position={[-blockWidth / 2 - 0.021, yOffset, xOffset]}
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
                          position={[blockWidth / 2 + 0.021, yOffset, xOffset]}
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
                      const radius = Math.min(blockWidth, blockDepth) * 0.52;
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
                      const radius = Math.min(blockWidth, blockDepth) * 0.54;
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
                        (colIndex - (blockWindowColumns - 1) / 2) * (blockWidth * 0.22);
                      const yOffset = 0.22 + rowIndex * 0.18;
                      return [
                        <mesh
                          key={`${cubeId}-court-window-front-${rowIndex}-${colIndex}`}
                          position={[xOffset, yOffset, blockDepth * 0.49]}
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
                          position={[xOffset, yOffset, -blockDepth * 0.49]}
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
                          position={[-blockWidth * 0.49, yOffset, xOffset]}
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
                          position={[blockWidth * 0.49, yOffset, xOffset]}
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
                    <boxGeometry args={[blockWidth * 0.18, 0.07, blockDepth * 0.18]} />
                    <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                  </mesh>
                )}
              </>
            )}

            {buildingFamily === 'tower' && (
              <>
                <mesh position={[0, towerBaseHeight, 0]} castShadow receiveShadow>
                  <boxGeometry args={[Math.min(cubeSize * 1.02, towerWidth * 1.12), podiumHeight * 0.9, Math.min(cubeSize * 1.02, towerDepth * 1.12)]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, towerUpperHeight + 0.06, 0]} castShadow receiveShadow>
                  <boxGeometry args={[towerWidth * 0.74, towerOnlyHeight * 1.1, towerDepth * 0.74]} />
                  <meshStandardMaterial color={buildingBodyColor} />
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
                  <boxGeometry args={[steppedWidth, steppedLowerHeight * 0.95, steppedDepth]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, 0.07 + steppedLowerHeight + steppedMidHeight / 2 + 0.03, 0]} castShadow receiveShadow>
                  <boxGeometry args={[steppedWidth * 0.62, steppedMidHeight * 1.08, steppedDepth * 0.62]} />
                  <meshStandardMaterial color={buildingBodyColor} />
                </mesh>
                <mesh position={[0, 0.07 + steppedLowerHeight + steppedMidHeight + steppedTopHeight / 2 + 0.06, 0]} castShadow receiveShadow>
                  <boxGeometry args={[steppedWidth * 0.34, steppedTopHeight * 1.15, steppedDepth * 0.34]} />
                  <meshStandardMaterial color={shadeColor(buildingBodyColor, 20)} />
                </mesh>
                <mesh position={[0, steppedRoofTopY - 0.03, 0]} castShadow>
                  <boxGeometry args={[steppedWidth * 0.44, 0.06, steppedDepth * 0.44]} />
                  <meshStandardMaterial color={roofColor} />
                </mesh>
              </>
            )}

            {buildingFamily === 'fort' && (
              <>
                <mesh position={[0, 0.07 + fortWallHeight / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[fortWidth, fortWallHeight * 0.92, fortDepth]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
                <mesh position={[0, 0.07 + fortWallHeight + keepHeight / 2 + 0.08, 0]} castShadow receiveShadow>
                  <boxGeometry args={[fortWidth * 0.42, keepHeight * 1.12, fortDepth * 0.42]} />
                  <meshStandardMaterial color={buildingBodyColor} />
                </mesh>
                {[
                  [-fortWidth * 0.36, -fortDepth * 0.36],
                  [fortWidth * 0.36, -fortDepth * 0.36],
                  [-fortWidth * 0.36, fortDepth * 0.36],
                  [fortWidth * 0.36, fortDepth * 0.36],
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
                  <boxGeometry args={[fortWidth * 0.5, 0.06, fortDepth * 0.5]} />
                  <meshStandardMaterial color={roofColor} />
                </mesh>
                {[-0.28, -0.09, 0.09, 0.28].map((xOffset, crenelIndex) => (
                  <mesh
                    key={`${cubeId}-crenel-front-${crenelIndex}`}
                    position={[xOffset * fortWidth, 0.07 + fortWallHeight + 0.05, fortDepth * 0.5]}
                    castShadow
                  >
                    <boxGeometry args={[0.08, 0.1, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 10)} />
                  </mesh>
                ))}
                {[-0.28, -0.09, 0.09, 0.28].map((xOffset, crenelIndex) => (
                  <mesh
                    key={`${cubeId}-crenel-back-${crenelIndex}`}
                    position={[xOffset * fortWidth, 0.07 + fortWallHeight + 0.05, -fortDepth * 0.5]}
                    castShadow
                  >
                    <boxGeometry args={[0.08, 0.1, 0.08]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 10)} />
                  </mesh>
                ))}
              </>
            )}

            {roofVariant === 'parapet' && (
              <>
                <mesh position={[0, roofTopY + 0.035, facadeDepth * 0.42]} castShadow>
                  <boxGeometry args={[facadeWidth * 0.9, 0.07, 0.055]} />
                  <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                </mesh>
                <mesh position={[0, roofTopY + 0.035, -facadeDepth * 0.42]} castShadow>
                  <boxGeometry args={[facadeWidth * 0.9, 0.07, 0.055]} />
                  <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                </mesh>
                <mesh position={[facadeWidth * 0.42, roofTopY + 0.035, 0]} castShadow>
                  <boxGeometry args={[0.055, 0.07, facadeDepth * 0.9]} />
                  <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                </mesh>
                <mesh position={[-facadeWidth * 0.42, roofTopY + 0.035, 0]} castShadow>
                  <boxGeometry args={[0.055, 0.07, facadeDepth * 0.9]} />
                  <meshStandardMaterial color={shadeColor(roofColor, 8)} />
                </mesh>
              </>
            )}

            {roofVariant === 'penthouse' && (
              <mesh position={[facadeWidth * 0.12, roofTopY + 0.09, -facadeDepth * 0.12]} castShadow receiveShadow>
                <boxGeometry args={[facadeWidth * 0.28, 0.18, facadeDepth * 0.24]} />
                <meshStandardMaterial color={shadeColor(trimColor, 12)} metalness={visualStyle.metalness} roughness={visualStyle.roughness} />
              </mesh>
            )}

            {roofVariant === 'antenna' && (
              <>
                <mesh position={[0, roofTopY + 0.27, 0]} castShadow>
                  <cylinderGeometry args={[0.014, 0.02, 0.54 + visualStyle.roofLift, 10]} />
                  <meshStandardMaterial color="#d1d5db" metalness={0.64} roughness={0.3} />
                </mesh>
                <mesh position={[0.1, roofTopY + 0.48, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
                  <cylinderGeometry args={[0.01, 0.01, 0.32, 8]} />
                  <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.22} />
                </mesh>
              </>
            )}

            {roofVariant === 'water-tower' && (
              <>
                <mesh position={[facadeWidth * 0.18, roofTopY + 0.14, -facadeDepth * 0.12]} castShadow>
                  <cylinderGeometry args={[0.075, 0.075, 0.18, 14]} />
                  <meshStandardMaterial color={shadeColor(visualStyle.accentColor, -8)} metalness={0.18} roughness={0.54} />
                </mesh>
                <mesh position={[facadeWidth * 0.18, roofTopY + 0.025, -facadeDepth * 0.12]} castShadow>
                  <cylinderGeometry args={[0.02, 0.02, 0.14, 8]} />
                  <meshStandardMaterial color={trimColor} />
                </mesh>
              </>
            )}

            {roofVariant === 'green' && (
              <mesh position={[0, roofTopY + 0.012, 0]} receiveShadow>
                <boxGeometry args={[facadeWidth * 0.58, 0.024, facadeDepth * 0.48]} />
                <meshStandardMaterial color="#166534" roughness={0.96} />
              </mesh>
            )}

            {roofVariant === 'solar' && (
              <>
                {[-0.18, 0.18].map((xOffset, panelIndex) => (
                  <mesh key={`${cubeId}-solar-${panelIndex}`} position={[xOffset * facadeWidth, roofTopY + 0.018, -facadeDepth * 0.08]} rotation={[-0.1, 0, 0]} receiveShadow>
                    <boxGeometry args={[facadeWidth * 0.24, 0.018, facadeDepth * 0.32]} />
                    <meshStandardMaterial color="#0f172a" emissive="#1e40af" emissiveIntensity={0.12} metalness={0.3} roughness={0.36} />
                  </mesh>
                ))}
              </>
            )}

            {organizationCategory === 'cloud' && (
              <>
                {[-0.28, 0, 0.28].map((xOffset, podIndex) => (
                  <mesh key={`${cubeId}-cloud-roof-pod-${podIndex}`} position={[xOffset * facadeWidth, roofTopY + 0.08 + podIndex * 0.015, -facadeDepth * 0.12]} castShadow>
                    <boxGeometry args={[facadeWidth * 0.16, 0.12, facadeDepth * 0.16]} />
                    <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.24} metalness={0.35} roughness={0.28} />
                  </mesh>
                ))}
                {[-0.34, 0.34].map((xOffset, stripIndex) => (
                  <mesh key={`${cubeId}-cloud-light-strip-${stripIndex}`} position={[xOffset * facadeWidth, Math.max(0.28, roofTopY * 0.48), facadeDepth / 2 + 0.055]}>
                    <planeGeometry args={[0.045, Math.max(0.28, roofTopY * 0.62)]} />
                    <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.5} transparent opacity={0.72} />
                  </mesh>
                ))}
              </>
            )}

            {organizationCategory === 'telecom' && (
              <>
                <mesh position={[0, roofTopY + 0.32, 0]} castShadow>
                  <cylinderGeometry args={[0.018, 0.026, 0.64 + visualStyle.roofLift, 10]} />
                  <meshStandardMaterial color="#d1d5db" metalness={0.65} roughness={0.28} />
                </mesh>
                {[0, 1, 2].map((dishIndex) => {
                  const angle = -0.75 + dishIndex * 0.75;
                  return (
                    <mesh key={`${cubeId}-telecom-dish-${dishIndex}`} position={[Math.sin(angle) * 0.16, roofTopY + 0.38 + dishIndex * 0.08, Math.cos(angle) * 0.16]} rotation={[0, angle, 0]} castShadow>
                      <cylinderGeometry args={[0.075, 0.04, 0.035, 16]} />
                      <meshStandardMaterial color={visualStyle.accentColor} metalness={0.5} roughness={0.34} />
                    </mesh>
                  );
                })}
              </>
            )}

            {organizationCategory === 'education' && (
              <>
                <mesh position={[0, 0.092, facadeDepth / 2 + 0.12]} receiveShadow>
                  <boxGeometry args={[facadeWidth * 0.68, 0.025, 0.16]} />
                  <meshStandardMaterial color="#166534" roughness={0.95} />
                </mesh>
                {[-0.36, -0.12, 0.12, 0.36].map((xOffset, columnIndex) => (
                  <mesh key={`${cubeId}-campus-column-${columnIndex}`} position={[xOffset * facadeWidth, 0.25, facadeDepth / 2 + 0.055]} castShadow>
                    <cylinderGeometry args={[0.025, 0.025, 0.34, 10]} />
                    <meshStandardMaterial color={shadeColor(trimColor, 24)} roughness={0.8} />
                  </mesh>
                ))}
              </>
            )}

            {organizationCategory === 'government' && (
              <>
                <mesh position={[0, 0.42, facadeDepth / 2 + 0.06]} castShadow>
                  <boxGeometry args={[facadeWidth * 0.72, 0.08, 0.08]} />
                  <meshStandardMaterial color={shadeColor(trimColor, 18)} roughness={0.86} />
                </mesh>
                {[-0.32, -0.1, 0.1, 0.32].map((xOffset, columnIndex) => (
                  <mesh key={`${cubeId}-civic-column-${columnIndex}`} position={[xOffset * facadeWidth, 0.26, facadeDepth / 2 + 0.06]} castShadow>
                    <cylinderGeometry args={[0.028, 0.032, 0.36, 12]} />
                    <meshStandardMaterial color={visualStyle.accentColor} roughness={0.84} />
                  </mesh>
                ))}
              </>
            )}

            {organizationCategory === 'residential' && (
              <>
                {Array.from({ length: Math.min(4, Math.max(2, Math.floor(roofTopY / 0.24))) }).map((_, balconyIndex) => (
                  <mesh key={`${cubeId}-balcony-${balconyIndex}`} position={[0, 0.28 + balconyIndex * 0.22, facadeDepth / 2 + 0.07]} castShadow>
                    <boxGeometry args={[facadeWidth * 0.62, 0.035, 0.1]} />
                    <meshStandardMaterial color={visualStyle.accentColor} metalness={0.08} roughness={0.66} />
                  </mesh>
                ))}
              </>
            )}

            {organizationCategory === 'security' && (
              <>
                {[
                  [-0.52, -0.52],
                  [0.52, -0.52],
                  [-0.52, 0.52],
                  [0.52, 0.52],
                ].map((offsets, postIndex) => (
                  <mesh key={`${cubeId}-security-post-${postIndex}`} position={[offsets[0] * cubeSize, 0.24, offsets[1] * cubeSize]} castShadow>
                    <boxGeometry args={[0.045, 0.34, 0.045]} />
                    <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.18} />
                  </mesh>
                ))}
                <mesh position={[0, roofTopY + 0.1, 0]} castShadow>
                  <sphereGeometry args={[0.08, 12, 12]} />
                  <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.55} />
                </mesh>
              </>
            )}

            {organizationCategory === 'commercial' && (
              <mesh position={[0, Math.min(roofTopY - 0.08, 0.36), facadeDepth / 2 + 0.055]} castShadow>
                <boxGeometry args={[facadeWidth * 0.58, 0.09, 0.06]} />
                <meshStandardMaterial color={visualStyle.accentColor} emissive={visualStyle.accentColor} emissiveIntensity={0.2} />
              </mesh>
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

            {visibleFlagImageUrl && (
              <WallMountedFlag
                imageUrl={visibleFlagImageUrl}
                countryCodeLabel={visibleCountryCodeLabel}
                width={Math.min(0.34, facadeWidth * 0.34)}
                height={Math.min(0.24, facadeWidth * 0.24)}
                position={[0, facadeFlagY, facadeFlagZ]}
                onClick={handleBuildingSingleClick}
                onDoubleClick={handleBuildingDoubleClick}
                onPointerOver={handleCellPointer('building')}
                onPointerOut={handleCellPointerOut}
              />
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

          {isHovered && (
            <Html fullscreen>
              <div
                data-info-panel="true"
                style={{ display: 'none' }}
                dangerouslySetInnerHTML={{ __html: hoverInfoHtml }}
              />
            </Html>
          )}
        </group>
      );
    }
  }

  const avatarCellCounts = new Map<string, number>();
  const remoteAvatarMarkers = remoteUsers.flatMap((user) => {
    const playerLocation = user.playerLocation;
    const playerIp =
      playerLocation?.kind === 'ip' || playerLocation?.kind === 'building'
        ? playerLocation.ipAddress
        : user.selectedIp;
    const selectedCellIndex = playerIp
      ? visibleLookupAddresses.findIndex((address) => address.ipAddress === playerIp)
      : -1;
    let cell: { x: number; y: number; ipAddress: string } | undefined;
    if (
      playerLocation?.kind === 'ip' &&
      typeof playerLocation.x === 'number' &&
      typeof playerLocation.y === 'number' &&
      playerLocation.x >= 0 &&
      playerLocation.x < gridSize &&
      playerLocation.y >= 0 &&
      playerLocation.y < gridSize &&
      visibleLookupAddresses[playerLocation.y * gridSize + playerLocation.x]?.ipAddress === playerLocation.ipAddress
    ) {
      cell = {
        x: playerLocation.x,
        y: playerLocation.y,
        ipAddress: playerLocation.ipAddress,
      };
    } else if (selectedCellIndex >= 0) {
      cell = {
        x: selectedCellIndex % gridSize,
        y: Math.floor(selectedCellIndex / gridSize),
        ipAddress: visibleLookupAddresses[selectedCellIndex].ipAddress,
      };
    }

    if (!cell) {
      return [];
    }

    const cellKey = `${cell.x}-${cell.y}`;
    const stackIndex = avatarCellCounts.get(cellKey) ?? 0;
    avatarCellCounts.set(cellKey, stackIndex + 1);
    const angle = stackIndex * 1.9;
    const spread = Math.min(0.42, stackIndex * 0.12);
    const xOffset = Math.cos(angle) * spread;
    const zOffset = Math.sin(angle) * spread;
    const locationLabel = getAvatarLocationDisplay(user);
    if (DEBUG_REMOTE_AVATARS) {
      console.info('DEBUG_REMOTE_AVATARS avatar render attempt', {
        sessionId: user.sessionId,
        userId: user.userId,
        name: user.displayName,
        avatarUrl: Boolean(user.avatarUrl),
        avatarType: user.avatarType,
      });
    }
    const handleRemoteAvatarClick = (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onRemoteUserClick?.(user);
    };

    return [
      <group
        key={`remote-user-${user.sessionId}`}
        position={[
          cell.x * spacing - offset + xOffset,
          groundY + 3.22 + stackIndex * 0.22,
          cell.y * spacing - offset + zOffset,
        ]}
        onClick={handleRemoteAvatarClick}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
        }}
      >
        <group onClick={handleRemoteAvatarClick}>
          <UserAvatarModel
            avatarUrl={user.avatarUrl}
            fallback={<DefaultRemoteAvatar color={user.color} />}
          />
        </group>
        <mesh position={[0, -0.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.44, 0.64, 32]} />
          <meshBasicMaterial color={user.color} transparent opacity={0.42} />
        </mesh>
        <Html position={[0, -0.9, 0]} center distanceFactor={8} style={{ pointerEvents: 'none' }}>
          <div
            style={{
              background: 'rgba(255,255,255,0.92)',
              border: `2px solid ${user.color}`,
              borderRadius: '4px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
              color: '#111827',
              display: 'flex',
              fontSize: '13px',
              gap: '6px',
              lineHeight: 1.1,
              maxWidth: '360px',
              overflow: 'hidden',
              padding: '2px 8px',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={`${user.displayName} at ${locationLabel}`}
          >
            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user.displayName}
            </span>
            <span style={{ color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {locationLabel}
            </span>
          </div>
        </Html>
      </group>,
    ];
  });

  return (
    <>
      {createStreetGrid()}
      {cubes}
      {remoteAvatarMarkers}
    </>
  );
}

export default IPGrid;
