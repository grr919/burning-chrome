import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BUILDING_MODEL_MIX, type BuildingModelId } from './buildingModelMix';

export type BuildingAsset = {
  scene: THREE.Group;
  width: number;
  height: number;
  depth: number;
};

const cache = new Map<BuildingModelId, Promise<BuildingAsset>>();
const loader = new GLTFLoader();

function loadBuilding(id: BuildingModelId): Promise<BuildingAsset> {
  const existing = cache.get(id);
  if (existing) return existing;
  const promise = loader.loadAsync(`/models/buildings/${id}.glb`).then(({ scene }) => {
    // Bounds include all GLB node transforms, including mesh quantization.
    const bounds = new THREE.Box3().setFromObject(scene);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const footprint = BUILDING_MODEL_MIX.find((model) => model.id === id)!.footprint;
    const scale = footprint / Math.max(size.x, size.z);
    const centered = new THREE.Group();
    centered.position.set(-center.x, -bounds.min.y, -center.z);
    centered.add(scene);
    const normalized = new THREE.Group();
    normalized.scale.setScalar(scale);
    normalized.add(centered);
    normalized.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        // The existing cell hitbox remains the sole building interaction target.
        object.raycast = () => {};
      }
    });
    return { scene: normalized, width: size.x * scale, height: size.y * scale, depth: size.z * scale };
  }).catch((error: unknown) => {
    cache.delete(id);
    throw error;
  });
  cache.set(id, promise);
  return promise;
}

export function useBuildingAssets(enabled: boolean) {
  const [assets, setAssets] = useState<Partial<Record<BuildingModelId, BuildingAsset>>>({});
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    for (const model of BUILDING_MODEL_MIX) {
      void loadBuilding(model.id).then((asset) => {
        if (!cancelled) setAssets((previous) => ({ ...previous, [model.id]: asset }));
      }).catch((error: unknown) => {
        // Keep the existing service-based building if an asset cannot load.
        console.warn(`Building model ${model.id} unavailable; retaining original structure.`, error);
      });
    }
    return () => { cancelled = true; };
  }, [enabled]);
  return assets;
}

export function LibraryBuilding({ asset }: { asset: BuildingAsset }) {
  // Clone transforms only; repeated buildings share cached geometry/materials.
  const scene = useMemo(() => {
    const clone = asset.scene.clone(true);
    clone.traverse((object) => {
      if (object instanceof THREE.Mesh) object.raycast = () => {};
    });
    return clone;
  }, [asset]);
  return <primitive object={scene} position={[0, 0.09, 0]} dispose={null} />;
}
