import { useEffect, useMemo, useRef, useState } from 'react';
import { Home, ArrowLeft, RotateCcw } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import IPGrid from './components/IPGrid';

type GridPosition = {
  firstOctet: number;
  secondOctet: number;
  thirdOctet: number;
  fourthOctet: number;
};

type LookupMode = 'rdap' | 'ptr';

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

function getRepresentativeTarget(zoomLevel: number, currentPosition: GridPosition): string {
  if (zoomLevel === 0) return '8.8.8.8';
  if (zoomLevel === 1) return `${currentPosition.firstOctet}.1.1.1`;
  if (zoomLevel === 2) return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.1.1`;
  return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.1`;
}


function BuildingDetailScene({
  building,
  onExit,
}: {
  building: BuildingViewState;
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

      {building.flagImageUrl ? (
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
      ) : (
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
              background: '#ffffff',
              cursor: 'pointer',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.65))',
            }}
            title="Return to grid view"
          />
        </Html>
      )}

      <Html position={[0, labelY, 0]} center>
        <div className="bg-white/90 text-black px-2 py-1 rounded text-sm shadow">
          {building.ipAddress}
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
  const layoutMode = 'grid';
  const [selectedTargetIp, setSelectedTargetIp] = useState<string>('8.8.8.8');
  const [viewResetKey, setViewResetKey] = useState(0);

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
    () => getRepresentativeTarget(zoomLevel, currentPosition),
    [zoomLevel, currentPosition.firstOctet, currentPosition.secondOctet, currentPosition.thirdOctet]
  );

  const activeTargetIp = selectedTargetIp || fallbackTargetIp;

  const handleGridClick = (x: number, y: number) => {
    const octetValue = y * 16 + x;
    const clickedIp = getIpFromCell(zoomLevel, currentPosition, x, y);
    setSelectedTargetIp(clickedIp);

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
    setZoomLevel(0);
    setCurrentPosition({ firstOctet: 0, secondOctet: 0, thirdOctet: 0, fourthOctet: 0 });
    setSelectedTargetIp('8.8.8.8');
  };

  const handleResetView = () => {
  const handleStopGridSpin = () => {
    if (!controlsRef.current || !cameraRef.current) {
      return;
    }

    const currentCameraPosition = cameraRef.current.position.clone();
    const currentTarget = controlsRef.current.target.clone();

    controlsRef.current.enabled = false;
    cameraRef.current.position.copy(currentCameraPosition);
    controlsRef.current.target.copy(currentTarget);
    controlsRef.current.update();

    requestAnimationFrame(() => {
      if (!controlsRef.current || !cameraRef.current) {
        return;
      }
      cameraRef.current.position.copy(currentCameraPosition);
      controlsRef.current.target.copy(currentTarget);
      controlsRef.current.enabled = true;
      controlsRef.current.update();
    });
  };

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

      setBottomInfoHtml(activeHtml);
    };

    syncInfoPanel();

    const observer = new MutationObserver(() => {
      syncInfoPanel();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [layoutMode, lookupMode, zoomLevel, currentPosition.firstOctet, currentPosition.secondOctet, currentPosition.thirdOctet]);


  const handleFlagClick = (building: BuildingViewState) => {
    setBuildingView(building);
    setSelectedTargetIp(building.ipAddress);
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
    if (zoomLevel === 0) return 'Top-level View:';
    if (zoomLevel === 1) return `${currentPosition.firstOctet}.x.x.x`;
    if (zoomLevel === 2) return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.x.x`;
    return `${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.x`;
  };

  const getInstructionText = (): string => {
    if (zoomLevel === 0) {
      return lookupMode === 'rdap'
        ? 'Click a building to zoom into a first-octet block. Heights use public service exposure data. Hover for live ownership and registration data. Click a building flag for close-up building view.'
        : 'Click a building to zoom into a first-octet block. Heights use public service exposure data. Hover for hostname data from reverse DNS, with scan-data fallback when PTR is absent. Click a building flag for close-up building view.';
    }

    if (zoomLevel === 1) {
      return `Viewing the 256 second-octet values under ${currentPosition.firstOctet}.0.0.0/8. Heights use public service exposure for each representative IP.`;
    }

    if (zoomLevel === 2) {
      return `Viewing the 256 third-octet values under ${currentPosition.firstOctet}.${currentPosition.secondOctet}.0.0/16. Heights use public service exposure for each representative IP.`;
    }

    return lookupMode === 'rdap'
      ? `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Hover a building to fetch live RDAP ownership and registration data. Click a building flag for close-up building view.`
      : `Viewing the 256 host addresses in ${currentPosition.firstOctet}.${currentPosition.secondOctet}.${currentPosition.thirdOctet}.0/24. Heights reflect public service exposure for each exact IP. Hover a building to fetch hostname data. Click a building flag for close-up building view.`;
  };

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      <div className="flex-1 p-4 flex flex-col gap-4">
        <header className="bg-white text-black p-4 rounded-lg">
          <div className="flex flex-col gap-4 lg:flex-row lg:justify-between lg:items-start">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Cyberspace Visualization</h1>
              <p className="text-gray-700">3D IPv4 city grid with public-exposure-based heights and live RDAP/hostname lookups</p>
              <p className="text-sm italic text-gray-700 mt-2">{getCurrentRangeLabel()}</p>
              <p className="text-sm italic text-gray-700">{getInstructionText()}</p>
            </div>

            <div className="flex flex-col items-start lg:items-end gap-3">
              <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
                <button
                  onClick={handleBack}
                  disabled={zoomLevel === 0}
                  className={`p-2 rounded ${zoomLevel === 0 ? 'bg-gray-300 text-gray-500 border border-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400'}`}
                  title="Go back one level"
                >
                  <ArrowLeft size={20} />
                </button>
                <button onClick={handleReset} className="px-3 py-2 rounded-md bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400" title="Reset to top view">
                  <Home size={20} />
                </button>
                <button onClick={handleResetView} className="px-3 py-2 rounded-md bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400" title="Reset camera view">
                  <RotateCcw size={20} />
                </button>
              </div>

              <div className="text-xs lg:text-right">
                <p className="text-gray-900 mt-1">Current height source: Shodan InternetDB</p>
                <p className="text-gray-900 mt-1">Selected routing target: {activeTargetIp}</p>
              </div>
            </div>
          </div>
        </header>

        {buildingView ? (
          <div className="flex-1 flex flex-col gap-4 lg:flex-row">
            <div className="relative h-[560px] lg:flex-[1.35] rounded-xl overflow-hidden border border-gray-700 bg-gray-950">
              <Canvas
                key={`building-${buildingView.ipAddress}`}
                camera={{ position: [0, 3.6, 8.5], fov: 42 }}
                shadows
              >
                <BuildingDetailScene building={buildingView} onExit={handleExitBuildingView} />
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

            <div className="lg:w-[380px] bg-white text-black border border-gray-300 rounded-xl shadow-lg p-4 overflow-auto">
              <div className="font-bold text-lg">Building view: {buildingView.ipAddress}</div>
              <div className="text-sm text-gray-600 mt-1">
                Click the building flag to return to grid view.
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <div>
                  <button
                    onClick={handleLaunchSsh}
                    disabled={sshLaunchLoadingIp === buildingView.ipAddress}
                    className={`px-3 py-2 rounded-md text-sm font-medium ${sshLaunchLoadingIp === buildingView.ipAddress ? 'bg-gray-300 text-gray-500 border border-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-900 border border-gray-400 shadow-sm hover:bg-gray-300 active:bg-gray-400'}`}
                    title="Open the local SSH client"
                  >
                    {sshLaunchLoadingIp === buildingView.ipAddress ? 'Opening SSH…' : 'Open SSH client'}
                  </button>
                </div>
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
        ) : (
          <div className="flex-1 flex justify-center">
            <div ref={gridContainerRef} className="relative w-full h-[560px] rounded-xl overflow-hidden border border-gray-700 bg-[#eaf6ff]">
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
            className="rounded-lg shadow-lg border border-gray-300 min-h-[220px] px-4 py-3"
            style={{ backgroundColor: '#ffffff', color: '#000000' }}
          >
            <div className="min-h-[188px]">
              {bottomInfoHtml ? (
                <div
                  className="grid gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-3 text-sm leading-snug [&_.font-bold]:md:col-span-2 [&_.font-bold]:xl:col-span-3 [&_.font-bold]:text-base [&_.font-bold]:mb-1 [&_.space-y-1]:contents [&_.pt-1]:contents [&_.mt-2]:contents [&_.text-gray-400]:text-gray-600 [&_.text-gray-300]:text-gray-700 [&_.text-blue-300]:text-blue-700 [&_.text-blue-700]:text-blue-700 [&_.text-red-300]:text-red-700 [&_.text-red-700]:text-red-700 [&_.bg-gray-800]:bg-gray-100 [&_.bg-gray-100]:bg-gray-100 [&_.bg-gray-800]:p-1.5 [&_.bg-gray-100]:p-1.5 [&_.bg-gray-800]:rounded [&_.bg-gray-100]:rounded"
                  dangerouslySetInnerHTML={{ __html: bottomInfoHtml }}
                />
              ) : (
                <div>&nbsp;</div>
              )}
            </div>
          </div>
        )}

        {showHeightLegend && (
          <div className="bg-white text-black border border-gray-300 p-3 rounded-lg">
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
