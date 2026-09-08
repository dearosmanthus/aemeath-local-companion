// Real PMX, real Three scene/skeleton and local renderer source assertions.
// No browser, graphics context, microphone, speech service or network access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { MMDLoader } from 'three-stdlib';
import { createCharacterShadows } from '../wallpaper/character-shadows.mjs';

const bytes = await readFile(new URL('../wallpaper/assets/models/aemeath-pmx/aemeath.pmx', import.meta.url));
const loader = new MMDLoader();
const data = loader._getParser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
const active = new Set(['まばたき', 'にこり', '笑い目', '口角上げ', 'あ', 'い', 'う', 'え', 'お', 'びっくり', '上', '真面目', '平行', '垂れ目', '左口角上げ', '右口角上げ']);
data.morphs = data.morphs.filter(morph => morph.type === 1 && active.has(morph.name));
data.metadata.morphCount = data.morphs.length;
const geometry = loader.meshBuilder.geometryBuilder.build(data);
const materials = data.materials.map(source => new THREE.MeshToonMaterial({
  name: source.name, opacity: source.diffuse[3], transparent: source.diffuse[3] < 1,
  visible: source.diffuse[3] !== 0, map: new THREE.Texture(), alphaTest: .035, forceSinglePass: true,
}));
const mesh = new THREE.SkinnedMesh(geometry, materials);
const bones = geometry.bones.map(def => {
  const bone = new THREE.Bone(); bone.name = def.name;
  bone.position.fromArray(def.pos); bone.quaternion.fromArray(def.rotq); return bone;
});
geometry.bones.forEach((def, i) => (bones[def.parent] || mesh).add(bones[i]));
mesh.updateMatrixWorld(true);
mesh.bind(new THREE.Skeleton(bones));
geometry.computeBoundingBox();
mesh.scale.setScalar(1.72 / geometry.boundingBox.getSize(new THREE.Vector3()).y);
mesh.position.set(.3, .07, -.15);
mesh.rotation.y = -.055;
const scene = new THREE.Scene();
scene.add(mesh);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
keyLight.position.set(-3, 4.5, 4);
const fill = new THREE.DirectionalLight(0xffffff, .3);
fill.position.set(2, 3, 1);
scene.add(keyLight, fill);
scene.updateMatrixWorld(true);
const camera = new THREE.PerspectiveCamera(24, 16 / 9, .05, 50);
camera.layers.set(0);
const renderer = { shadowMap: { enabled: false, type: THREE.PCFShadowMap, autoUpdate: true, needsUpdate: false } };
const originalShadow = keyLight.shadow;
const originalTarget = keyLight.target;
const originalLightPosition = keyLight.position.clone();
const fillBefore = { position: fill.position.toArray(), target: fill.target, cast: fill.castShadow, intensity: fill.intensity };
const originalDrawRange = { ...geometry.drawRange };
const system = createCharacterShadows({ mesh, data, renderer, keyLight });
assert.equal(system.metrics.supported, true, system.metrics.reason);
assert.equal(system.metrics.casterGroups, 2);
assert.equal(system.metrics.casterTriangles, 20804);
const proxy = system.proxy;
assert.equal(proxy.parent, mesh);
assert.equal(proxy.skeleton, mesh.skeleton);
assert.equal(proxy.geometry.index, geometry.index);
for (const [name, attribute] of Object.entries(geometry.attributes)) assert.equal(proxy.geometry.getAttribute(name), attribute);
assert.equal(proxy.morphTargetInfluences, mesh.morphTargetInfluences);
assert.equal(Object.keys(proxy.geometry.morphAttributes).length, 0, 'do not allocate a second full geometry morph texture');
assert.equal(system.metrics.addedMorphTextures, 0);
assert.deepEqual(proxy.geometry.groups.map(group => data.materials[group.materialIndex].name), ['后发', '前发']);

system.update({ camera, now: 0 });
assert.equal(system.metrics.enabled, true);
assert.equal(keyLight.shadow.autoUpdate, false);
assert.deepEqual(keyLight.shadow.mapSize.toArray(), [512, 512]);
assert.equal(renderer.shadowMap.type, THREE.PCFSoftShadowMap);
assert.equal(renderer.shadowMap.autoUpdate, true, 'only this light is throttled, not other lights');
scene.updateMatrixWorld(true);
mesh.skeleton.update();
assert.ok(proxy.matrixWorld.equals(mesh.matrixWorld), 'identity child does not apply model scale/translation twice');
const vertex = geometry.index.getX(proxy.geometry.groups[0].start);
const actual = proxy.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(proxy.matrixWorld);
const expected = mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
assert.ok(actual.distanceTo(expected) < 1e-8, 'caster skinning matches the original vertex');
const shadow = keyLight.shadow;
const direction = keyLight.getWorldPosition(new THREE.Vector3()).sub(keyLight.target.getWorldPosition(new THREE.Vector3())).normalize();
// applyAppearance() repeats preset coordinates while the shadow target stays
// attached to the head. It must not tilt the light until the next 100 ms tick.
shadow.needsUpdate = false;
renderer.shadowMap.needsUpdate = false;
keyLight.position.copy(originalLightPosition);
system.update({ camera, now: 50 });
const repeatedDirection = keyLight.getWorldPosition(new THREE.Vector3()).sub(keyLight.target.getWorldPosition(new THREE.Vector3())).normalize();
assert.ok(direction.distanceTo(repeatedDirection) < 1e-10, 'repeated soft preset preserves key direction between shadow ticks');
assert.equal(system.metrics.shadowUpdates, 1);
assert.equal(shadow.needsUpdate, false, 'preset correction does not bypass the 10 Hz shadow limit');
assert.equal(renderer.shadowMap.needsUpdate, false);
const head = mesh.skeleton.getBoneByName('頭');
head.rotation.y += .15;
mesh.position.x += .1;
scene.updateMatrixWorld(true);
for (let now = 51; now < 100; now++) system.update({ camera, now });
assert.equal(system.metrics.shadowUpdates, 1);
system.update({ camera, now: 100 });
assert.equal(system.metrics.shadowUpdates, 2);
const movedDirection = keyLight.getWorldPosition(new THREE.Vector3()).sub(keyLight.target.getWorldPosition(new THREE.Vector3())).normalize();
assert.ok(direction.distanceTo(movedDirection) < 1e-10, 'light direction stays fixed while its target follows the head');
assert.ok(keyLight.target.getWorldPosition(new THREE.Vector3()).distanceTo(head.getWorldPosition(new THREE.Vector3())) < 1e-10);
const face = system.metrics.faceBounds;
for (const x of [face.min[0], face.max[0]]) for (const y of [face.min[1], face.max[1]]) for (const z of [face.min[2], face.max[2]]) {
  const ndc = new THREE.Vector3(x, y, z).project(shadow.camera);
  assert.ok(Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && Math.abs(ndc.z) < 1, 'face remains inside the head/neck shadow frustum');
}
assert.ok(shadow.camera.right - shadow.camera.left < .8, 'do not cover the entire body with the shadow map');
assert.equal(shadow.intensity, .48);
mesh.updateWorldMatrix(true, true);
mesh.skeleton.update();
const lowerPoint = new THREE.Vector3();
const shadowCoordinate = new THREE.Vector3();
let lowerVertices = 0;
for (let i = 0; i < geometry.attributes.position.count; i++) {
  mesh.getVertexPosition(i, lowerPoint).applyMatrix4(mesh.matrixWorld);
  if (lowerPoint.y >= face.min[1] - .30) continue;
  lowerVertices++;
  shadowCoordinate.copy(lowerPoint).applyMatrix4(shadow.matrix);
  const inReceiverFrustum = shadowCoordinate.x >= 0 && shadowCoordinate.x <= 1
    && shadowCoordinate.y >= 0 && shadowCoordinate.y <= 1 && shadowCoordinate.z <= 1;
  assert.equal(inReceiverFrustum, false, 'lower-body vertices are outside the head/neck receiver frustum');
}
assert.ok(lowerVertices > 50000, 'check the real torso/skirt/legs rather than isolated sample points');
const shadowChunk = THREE.ShaderChunk.shadowmap_pars_fragment;
assert.ok(shadowChunk.includes('float shadow = 1.0;') && shadowChunk.includes('if ( frustumTest )')
  && shadowChunk.includes('return mix( 1.0, shadow, shadowIntensity );'), 'outside-frustum visibility stays 1 regardless of shadow intensity');

// Verify the installed renderer executes object hooks before calculating the
// draw count, then execute its actual count arithmetic for the two real groups.
const rendererSource = await readFile(new URL('../node_modules/three/src/renderers/WebGLRenderer.js', import.meta.url), 'utf8');
const shadowSource = await readFile(new URL('../node_modules/three/src/renderers/webgl/WebGLShadowMap.js', import.meta.url), 'utf8');
const morphSource = await readFile(new URL('../node_modules/three/src/renderers/webgl/WebGLMorphtargets.js', import.meta.url), 'utf8');
const objectRender = rendererSource.slice(rendererSource.indexOf('function renderObject( object, scene, camera'));
assert.ok(objectRender.indexOf('object.onBeforeRender(') < objectRender.indexOf('_this.renderBufferDirect('));
const shadowObject = shadowSource.slice(shadowSource.indexOf('function renderObject( object, camera, shadowCamera'));
assert.ok(shadowObject.indexOf('object.onBeforeShadow(') < shadowObject.indexOf('renderer.renderBufferDirect('));
assert.ok(morphSource.includes('morphTextures.get( geometry )'), 'morph texture identity is geometry, not shared attributes');
const rangeStart = rendererSource.indexOf('const drawRange = geometry.drawRange;');
const rangeEnd = rendererSource.indexOf('if ( drawCount < 0 || drawCount === Infinity ) return;', rangeStart);
assert.ok(rangeStart > 0 && rangeEnd > rangeStart);
const rangeBody = rendererSource.slice(rangeStart, rangeEnd);
const drawCount = new Function('geometry', 'group', 'const index = geometry.index, rangeFactor = 1; ' + rangeBody + ' return drawCount;');
for (const group of proxy.geometry.groups) {
  proxy.onBeforeShadow(renderer, proxy, camera, shadow.camera);
  assert.equal(drawCount(proxy.geometry, group), group.count);
  proxy.onAfterShadow();
  proxy.onBeforeRender();
  assert.ok(drawCount(proxy.geometry, group) < 0, 'negative count exits before main GPU draw');
  proxy.onBeforeShadow(renderer, proxy, camera, fill.shadow.camera);
  assert.ok(drawCount(proxy.geometry, group) < 0, 'other lights do not render this caster');
}
assert.deepEqual(geometry.drawRange, originalDrawRange);
assert.equal(proxy.material, mesh.material);
for (const group of proxy.geometry.groups) assert.equal(proxy.material[group.materialIndex].alphaTest, .035);

mesh.morphTargetInfluences = [...mesh.morphTargetInfluences];
system.update({ camera, now: 110 });
assert.equal(proxy.morphTargetInfluences, mesh.morphTargetInfluences, 'follow replacement influence arrays');
let disposedMap = 0;
shadow.map = { dispose() { disposedMap++; } };
system.update({ camera, now: 120, pressure: 2 });
assert.equal(disposedMap, 1);
assert.equal(shadow.map, null);
assert.equal(system.metrics.enabled, false);
assert.equal(proxy.visible, false);
assert.equal(keyLight.shadow, originalShadow);
assert.equal(keyLight.target, originalTarget);
assert.ok(keyLight.position.equals(originalLightPosition));
assert.equal(keyLight.castShadow, false);
assert.equal(mesh.receiveShadow, false);
assert.equal(renderer.shadowMap.enabled, false);
assert.equal(renderer.shadowMap.type, THREE.PCFShadowMap);
assert.deepEqual({ position: fill.position.toArray(), target: fill.target, cast: fill.castShadow, intensity: fill.intensity }, fillBefore);
system.update({ camera, now: 200 });
// An externally applied original lighting preset must not be overwritten.
keyLight.position.set(-1.5, 3.2, 4);
system.update({ camera, now: 210, appearance: 'original' });
assert.deepEqual(keyLight.position.toArray(), [-1.5, 3.2, 4]);

let originalDisposed = false, wrapperDisposed = false;
geometry.addEventListener('dispose', () => { originalDisposed = true; });
proxy.geometry.addEventListener('dispose', () => {
  wrapperDisposed = true;
  assert.equal(proxy.geometry.index, null);
  assert.deepEqual(Object.keys(proxy.geometry.attributes), []);
});
system.dispose();
system.dispose();
assert.equal(wrapperDisposed, true);
assert.equal(originalDisposed, false);
assert.equal(proxy.parent, null);
assert.ok(geometry.index && geometry.attributes.position);

// A future facial/miscellaneous morph affecting one caster vertex fails open.
const altered = geometry.morphAttributes.position[0];
const old = altered.getX(vertex);
altered.setX(vertex, old + .1);
altered.needsUpdate = true;
const rejected = createCharacterShadows({ mesh, data, renderer, keyLight });
assert.equal(rejected.metrics.supported, false);
assert.equal(rejected.metrics.reason, 'hair-morphs-require-full-renderer');
altered.setX(vertex, old);
altered.needsUpdate = true;
const runtimeGuard = createCharacterShadows({ mesh, data, renderer, keyLight });
runtimeGuard.update({ camera, now: 0 });
altered.setX(vertex, old + .1);
altered.needsUpdate = true;
runtimeGuard.update({ camera, now: 100 });
assert.equal(runtimeGuard.metrics.enabled, false);
assert.equal(runtimeGuard.metrics.reason, 'hair-morphs-or-geometry-changed');
runtimeGuard.dispose();
altered.setX(vertex, old);
altered.needsUpdate = true;
console.log('Character shadows: real 2-group PMX proxy, shared skinning, zero extra morph atlas, r185 negative main draw count, alpha maps, face frustum, 10 Hz scheduling, pressure/original restore and disposal passed.');
