import * as THREE from 'three';

const CASTERS = new Set(['前发', '后发']);
const INTERVAL_MS = 100;

function boxCorners(box, out) {
  let index = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out[index++].set(x, y, z);
  return out;
}

/**
 * Hair-only directional shadows for the checked Three r185 draw callback order.
 * update() takes performance.now() milliseconds, after the performer and world
 * matrices have been updated. Set enabled=false for the original appearance.
 */
export function createCharacterShadows({ mesh, data, renderer, keyLight }) {
  const metrics = {
    supported: false, enabled: false, reason: 'initializing', casterGroups: 0,
    casterTriangles: 0, shadowMapSize: 512, maxShadowHz: 10, shadowUpdates: 0,
    mainDrawCalls: 0, sharedAttributes: true, sharedSkeleton: true,
    addedMorphTextures: 0, morphPolicy: 'verified-zero-hair-morphs',
  };
  const unavailable = reason => {
    metrics.reason = reason;
    return { metrics, proxy: null, update: () => metrics, dispose() {} };
  };
  if (THREE.REVISION !== '185') return unavailable('renderer-version');
  if (!mesh?.isSkinnedMesh || !mesh.skeleton || !mesh.geometry?.index || !keyLight?.isDirectionalLight || !renderer?.shadowMap) return unavailable('unsupported-interface');
  if (renderer.shadowMap.enabled && renderer.shadowMap.type !== THREE.PCFSoftShadowMap) return unavailable('existing-shadow-type-conflict');
  let sceneRoot = mesh;
  while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
  let otherShadows = false;
  sceneRoot.traverse(object => { if (object.isLight && object !== keyLight && object.castShadow) otherShadows = true; });
  if (otherShadows) return unavailable('other-shadow-lights-active');
  const source = mesh.geometry;
  const materials = [].concat(mesh.material || []);
  const head = mesh.skeleton.getBoneByName('頭');
  if (!head) return unavailable('head-bone-missing');
  const groups = source.groups.filter(group => CASTERS.has(data?.materials?.[group.materialIndex]?.name)
    && data.materials[group.materialIndex].diffuse?.[3] > 0 && materials[group.materialIndex]?.visible);
  if (groups.length !== 2 || new Set(groups.map(group => data.materials[group.materialIndex].name)).size !== 2) return unavailable('base-hair-groups-missing');
  // r185 returns before GPU draw for a NEGATIVE count, not a zero count. The
  // real PMX's two groups start after index 0, so (0,0) intersects negatively.
  if (groups.some(group => group.start <= 0 || group.count <= 0)) return unavailable('main-draw-range-unsafe');
  const casterVertices = new Set();
  for (const group of groups) for (let i = group.start; i < group.start + group.count; i++) casterVertices.add(source.index.getX(i));
  const read = new THREE.Vector3();
  let morphSignature = [];
  function inspectMorphs() {
    const signature = [];
    for (const [kind, attributes] of Object.entries(source.morphAttributes)) {
      const base = source.getAttribute(kind);
      if (!base) return false;
      for (const attribute of attributes) {
        signature.push(attribute, attribute.version);
        if (attribute.count !== base.count || attribute.itemSize !== base.itemSize) return false;
        for (const index of casterVertices) for (let c = 0; c < attribute.itemSize; c++) {
          const value = attribute.getComponent(index, c);
          const expected = source.morphTargetsRelative ? 0 : base.getComponent(index, c);
          if (!Number.isFinite(value) || Math.abs(value - expected) > 1e-7) return false;
        }
      }
    }
    morphSignature = signature;
    return true;
  }
  function morphsChanged() {
    let i = 0;
    for (const attributes of Object.values(source.morphAttributes)) for (const attribute of attributes) {
      if (morphSignature[i++] !== attribute || morphSignature[i++] !== attribute.version) return true;
    }
    return i !== morphSignature.length;
  }
  if (!inspectMorphs()) return unavailable('hair-morphs-require-full-renderer');

  mesh.updateWorldMatrix(true, true);
  const inverseHead = head.matrixWorld.clone().invert();
  const faceLocal = new THREE.Box3();
  const faceGroups = source.groups.filter(group => data?.materials?.[group.materialIndex]?.name === 'face');
  for (const group of faceGroups) for (let i = group.start; i < group.start + group.count; i++) {
    read.fromBufferAttribute(source.attributes.position, source.index.getX(i)).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseHead);
    faceLocal.expandByPoint(read);
  }
  if (faceLocal.isEmpty()) return unavailable('face-bounds-missing');
  const faceSize = faceLocal.getSize(new THREE.Vector3());
  const padding = Math.max(faceSize.y, faceSize.x) * .30;
  // Include the hairline and upper neck without encompassing the long braid.
  const headLocal = faceLocal.clone().expandByScalar(padding);
  headLocal.max.y += faceSize.y * .25;
  headLocal.min.y -= faceSize.y * .20;
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(0, 0);
  // WebGLMorphtargets caches textures by geometry identity. Even shared morph
  // attributes would allocate a second full atlas, so zero-effect hair morphs
  // are omitted after the guard above, while influence references stay live.
  const proxy = new THREE.SkinnedMesh(geometry, mesh.material);
  proxy.name = 'AemeathHairShadowProxy';
  proxy.bindMode = mesh.bindMode;
  proxy.bind(mesh.skeleton, mesh.bindMatrix);
  proxy.morphTargetInfluences = mesh.morphTargetInfluences;
  proxy.morphTargetDictionary = mesh.morphTargetDictionary;
  proxy.layers.set(0);
  proxy.frustumCulled = false;
  proxy.castShadow = false;
  proxy.visible = false;
  proxy.receiveShadow = false;
  mesh.add(proxy); // identity local transform => same matrixWorld as the mesh

  const originalShadow = keyLight.shadow;
  const shadow = new originalShadow.constructor();
  shadow.mapSize.set(512, 512);
  shadow.autoUpdate = false;
  shadow.intensity = .48;
  shadow.bias = -.00012;
  shadow.normalBias = .002;
  const target = new THREE.Object3D();
  const prior = {
    target: keyLight.target, cast: keyLight.castShadow, meshCast: mesh.castShadow,
    receive: mesh.receiveShadow, rendererEnabled: renderer.shadowMap.enabled,
    rendererType: renderer.shadowMap.type, rendererNeedsUpdate: renderer.shadowMap.needsUpdate,
  };
  let enabled = false, disposed = false, invalid = false, lastUpdate = -Infinity;
  let ownsLightPosition = false;
  const originalPosition = keyLight.position.clone();
  const lastPosition = new THREE.Vector3();
  const directionOffset = new THREE.Vector3();
  const lightWorld = new THREE.Vector3();
  const targetWorld = new THREE.Vector3();
  const headWorld = new THREE.Vector3();
  const localLight = new THREE.Vector3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  const projected = new THREE.Box3();
  const faceWorld = new THREE.Box3();
  const projectedPoint = new THREE.Vector3();
  function captureLightDirection() {
    originalPosition.copy(keyLight.position);
    keyLight.getWorldPosition(lightWorld);
    prior.target.getWorldPosition(targetWorld);
    directionOffset.subVectors(lightWorld, targetWorld);
    if (directionOffset.lengthSq() < .001) directionOffset.set(-3, 4.5, 4);
  }
  function placeLightAtTarget(worldTarget) {
    localLight.copy(worldTarget).add(directionOffset);
    if (keyLight.parent) keyLight.parent.worldToLocal(localLight);
    keyLight.position.copy(localLight);
    lastPosition.copy(localLight);
    ownsLightPosition = true;
    keyLight.updateWorldMatrix(true, false);
  }
  function clearOwnedMap() {
    shadow.dispose();
    shadow.map = null;
    shadow.mapPass = null;
    shadow.needsUpdate = false;
  }
  function disable(reason) {
    geometry.setDrawRange(0, 0);
    proxy.castShadow = false;
    proxy.visible = false;
    if (enabled) {
      keyLight.shadow = originalShadow;
      keyLight.target = prior.target;
      keyLight.castShadow = prior.cast;
      if (ownsLightPosition && keyLight.position.equals(lastPosition)) keyLight.position.copy(originalPosition);
      mesh.castShadow = prior.meshCast;
      mesh.receiveShadow = prior.receive;
      renderer.shadowMap.enabled = prior.rendererEnabled;
      renderer.shadowMap.type = prior.rendererType;
      renderer.shadowMap.needsUpdate = prior.rendererNeedsUpdate;
      clearOwnedMap();
    }
    enabled = false;
    ownsLightPosition = false;
    lastUpdate = -Infinity;
    metrics.enabled = false;
    metrics.reason = reason;
  }
  proxy.onBeforeRender = () => geometry.setDrawRange(0, 0);
  proxy.onBeforeShadow = (_renderer, _object, _camera, shadowCamera) => {
    geometry.setDrawRange(0, enabled && shadowCamera === shadow.camera ? Infinity : 0);
  };
  proxy.onAfterShadow = () => geometry.setDrawRange(0, 0);
  metrics.supported = true;
  metrics.reason = 'disabled';
  metrics.casterGroups = groups.length;
  metrics.casterTriangles = groups.reduce((count, group) => count + group.count / 3, 0);

  return {
    metrics, proxy,
    update({ camera, now = 0, enabled: requested = true, pressure = 0, appearance = 'soft' } = {}) {
      if (disposed) return metrics;
      if (invalid || mesh.geometry !== source || (morphsChanged() && !inspectMorphs())) {
        invalid = true;
        disable('hair-morphs-or-geometry-changed');
        return metrics;
      }
      proxy.morphTargetInfluences = mesh.morphTargetInfluences;
      proxy.morphTargetDictionary = mesh.morphTargetDictionary;
      proxy.material = mesh.material;
      if (!requested || appearance === 'original' || pressure >= 2 || !camera?.layers.isEnabled(0)) {
        disable(pressure >= 2 ? 'render-pressure' : 'disabled');
        return metrics;
      }
      if (!enabled) {
        captureLightDirection();
        keyLight.shadow = shadow;
        keyLight.target = target;
        keyLight.castShadow = true;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        proxy.castShadow = true;
        proxy.visible = true;
        enabled = true;
        metrics.enabled = true;
        metrics.reason = 'hair-only-shadow';
      } else if (ownsLightPosition && !keyLight.position.equals(lastPosition)) {
        // Respect a new lighting preset applied by the owner between frames.
        captureLightDirection();
        // Preset coordinates are relative to the original light target. Keep
        // the live target's offset immediately, even between shadow refreshes,
        // so clicking the same appearance does not briefly tilt the key light.
        target.getWorldPosition(targetWorld);
        placeLightAtTarget(targetWorld);
      }
      if (!Number.isFinite(now) || now - lastUpdate < INTERVAL_MS) return metrics;
      head.getWorldPosition(headWorld);
      target.position.copy(headWorld);
      target.updateMatrixWorld(true);
      placeLightAtTarget(headWorld);
      shadow.updateMatrices(keyLight);
      projected.makeEmpty();
      for (const corner of boxCorners(headLocal, corners)) {
        corner.applyMatrix4(head.matrixWorld);
        projected.expandByPoint(projectedPoint.copy(corner).applyMatrix4(shadow.camera.matrixWorldInverse));
      }
      const cam = shadow.camera;
      cam.left = projected.min.x;
      cam.right = projected.max.x;
      cam.bottom = projected.min.y;
      cam.top = projected.max.y;
      cam.near = Math.max(.01, -projected.max.z - .05);
      cam.far = Math.max(cam.near + .1, -projected.min.z + .05);
      cam.updateProjectionMatrix();
      shadow.updateMatrices(keyLight);
      shadow.needsUpdate = true;
      renderer.shadowMap.needsUpdate = true;
      lastUpdate = now;
      metrics.shadowUpdates++;
      faceWorld.copy(faceLocal).applyMatrix4(head.matrixWorld);
      metrics.faceBounds = { min: faceWorld.min.toArray(), max: faceWorld.max.toArray() };
      metrics.frustum = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far };
      return metrics;
    },
    dispose() {
      if (disposed) return;
      disable('disposed');
      disposed = true;
      proxy.removeFromParent();
      proxy.onBeforeRender = proxy.onBeforeShadow = proxy.onAfterShadow = () => {};
      // WebGLGeometries.dispose removes attribute GPU buffers. Detach shared
      // buffers before disposing this wrapper, leaving the original intact.
      geometry.setIndex(null);
      for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
      geometry.morphAttributes = {};
      geometry.dispose();
      clearOwnedMap();
    },
  };
}
