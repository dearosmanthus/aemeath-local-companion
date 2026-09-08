// Real PMX metadata + real r185 shader chunks, with an in-memory texture loader.
// No DOM, browser, service, voice engine or network request is used.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MMDLoader } from 'three-stdlib';
import { assembleCharacterFragment, configureTextureRole, describePmxMaterials, filterRequiredTextureErrors, preparePmxMaterials } from '../wallpaper/character-materials.mjs';

const modelRoot = new URL('../wallpaper/assets/models/aemeath-pmx/', import.meta.url);
const bytes = await readFile(new URL('aemeath.pmx', modelRoot));
const data = new MMDLoader()._getParser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
const beforeData = JSON.stringify(data.materials);
const descriptors = describePmxMaterials(data);
assert.equal(descriptors.length, 44);
assert.equal(descriptors.filter(item => item.sphereMode === 2).length, 30);
assert.ok(descriptors.every(item => item.issue === null));
const descriptor = name => descriptors.find(item => item.name === name);
assert.equal(descriptor('face').spherePath, 'tex/sink22.png');
assert.equal(descriptor('后发').spherePath, 'tex/hair spa.png');
assert.equal(descriptor('后发+2').role, 'hairOverlay');
assert.equal(descriptor('后发+2').spherePath, 'tex/hair hi light.png');
assert.equal(descriptor('上半身肌肤').role, 'skin');
assert.equal(descriptor('上半身').role, 'cloth', 'shared Up01 atlas must not classify clothes as skin');
assert.equal(descriptor('颈饰品').role, 'metal', 'shared Down01 atlas contains metal too');
assert.equal(descriptor('MI_Eye').role, 'eye');
assert.equal(descriptor('MI_Eye hi+').role, 'eyeOverlay');
assert.equal(descriptor('声痕').role, 'energy');
assert.equal(descriptor('蓝al').role, 'energy');
await Promise.all(descriptors.filter(item => item.spherePath).map(item => access(fileURLToPath(new URL(item.spherePath, modelRoot)))));

const localRoot = 'assets/models/aemeath-pmx/';
const optionalErrors = descriptors.filter(item => item.spherePath).map(item => localRoot + item.spherePath);
const diffuseError = localRoot + data.textures[data.materials[0].textureIndex];
const toonError = localRoot + data.textures[data.materials.find(item => item.toonFlag === 0 && item.toonIndex >= 0).toonIndex];
const unknownError = localRoot + 'tex/unknown.png';
const realErrors = [...optionalErrors, diffuseError, toonError, unknownError];
assert.deepEqual(filterRequiredTextureErrors(data, localRoot, realErrors), [diffuseError, toonError, unknownError]);
assert.equal(realErrors.length, optionalErrors.length + 3, 'error filtering does not mutate manager diagnostics');

const sharedData = {
  textures: ['tex/sphere only.png', 'tex/共享.png', 'tex/toon.bmp', 'tex/disabled.png'],
  materials: [
    { envFlag: 2, envTextureIndex: 0, textureIndex: -1, toonFlag: 1, toonIndex: 0 },
    { envFlag: 2, envTextureIndex: 1, textureIndex: 1, toonFlag: 1, toonIndex: 0 },
    { envFlag: 1, envTextureIndex: 2, textureIndex: -1, toonFlag: 0, toonIndex: 2 },
    { envFlag: 3, envTextureIndex: 3, textureIndex: -1, toonFlag: 1, toonIndex: 0 },
  ],
};
const sphereError = 'local/tex/sphere%20only.png';
const sharedError = 'local\\tex\\%E5%85%B1%E4%BA%AB.png';
const sharedToonError = 'local/tex/toon.bmp';
const disabledSphereError = 'local/tex/disabled.png';
const malformedError = 'local/tex/sphere%ZZonly.png';
const doubleEncodedError = 'local/tex/sphere%2520only.png';
const syntheticErrors = [sphereError, sharedError, sharedToonError, disabledSphereError, malformedError, doubleEncodedError, 'unknown.png'];
assert.deepEqual(filterRequiredTextureErrors(sharedData, 'local/', syntheticErrors), syntheticErrors.slice(1),
  'only supported sphere-only failures may degrade; shared diffuse/toon, unsupported and unknown failures stay required');
const previousLocation = globalThis.location;
try {
  globalThis.location = { href: 'http://127.0.0.1:8765/wallpaper/' };
  const foreignError = 'http://other.invalid/wallpaper/local/tex/sphere%20only.png';
  const absoluteSharedError = 'http://127.0.0.1:8765/wallpaper/local/tex/%E5%85%B1%E4%BA%AB.png';
  assert.deepEqual(filterRequiredTextureErrors(sharedData, 'local/', [
    'local\\tex\\sphere only.png', '/wallpaper/local/tex/sphere%20only.png',
    'http://127.0.0.1:8765/wallpaper/local/tex/sphere%20only.png', foreignError, absoluteSharedError,
  ]), [foreignError, absoluteSharedError], 'known relative/root/absolute URLs match; other origins and shared maps stay required');
} finally {
  if (previousLocation === undefined) delete globalThis.location;
  else globalThis.location = previousLocation;
}

function fakeLoader(fail = () => false) {
  const loads = [];
  return {
    loads,
    load(url, onLoad, unused, onError) {
      const texture = new THREE.DataTexture(new Uint8Array([128, 96, 64, 255]), 1, 1);
      loads.push({ url, texture });
      queueMicrotask(() => fail(url) ? onError(new Error('fixture missing')) : onLoad(texture));
      return texture;
    },
  };
}
function makeMesh(metadata) {
  return { material: metadata.materials.map(source => new THREE.MeshToonMaterial({
    name: source.name, color: new THREE.Color().fromArray(source.diffuse), opacity: source.diffuse[3],
    transparent: source.diffuse[3] !== 1, emissive: new THREE.Color().fromArray(source.ambient || [0, 0, 0]),
    map: new THREE.Texture(), gradientMap: new THREE.Texture(),
  })) };
}
function shaderFor(material) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.toon.vertexShader, fragmentShader: THREE.ShaderLib.toon.fragmentShader };
  material.onBeforeCompile(shader, null);
  assert.equal(shader.vertexShader, THREE.ShaderLib.toon.vertexShader, 'stock skin/morph/shadow vertex path stays intact');
  assert.ok(shader.fragmentShader.indexOf('#include <normal_fragment_maps>') < shader.fragmentShader.indexOf('vec2 aemeathSphereUv'));
  assert.ok(shader.fragmentShader.indexOf('outgoingLight += reflectedLight.directSpecular;') < shader.fragmentShader.indexOf('#include <tonemapping_fragment>'));
  assert.ok(shader.fragmentShader.includes('directLight.color * aemeathHighlight * aemeathLit'));
  return shader;
}
const manager = new THREE.LoadingManager();
const textureLoader = fakeLoader();
const mesh = makeMesh(data);
const beforeValues = mesh.material.map(material => ({ color: material.color.toArray(), opacity: material.opacity, transparent: material.transparent, visible: material.visible, depthWrite: material.depthWrite }));
const controller = preparePmxMaterials({ mesh, data, manager, texturePath: 'assets/models/aemeath-pmx/', textureLoader, maxAnisotropy: 16 });
const metrics = await controller.ready;
assert.equal(metrics.sphereMappedMaterials, 30);
assert.equal(metrics.sphereTextures, 7);
assert.equal(textureLoader.loads.length, 7, 'shared sphere resources are loaded once per path and role');
assert.equal(metrics.sphereTextureFailures, 0);
assert.equal(metrics.skippedHiddenMaterials, 10);
assert.equal(metrics.skippedHiddenTriangles, 48277, 'skip hidden alternate faces/clothes before GPU vertex and morph work');
assert.equal(JSON.stringify(data.materials), beforeData, 'source PMX metadata must remain untouched');
const shaders = mesh.material.map(shaderFor);
mesh.material.forEach((material, index) => {
  assert.deepEqual(material.color.toArray(), beforeValues[index].color);
  assert.equal(material.opacity, beforeValues[index].opacity, 'hidden alternate parts must remain hidden');
  const overlay = descriptors[index].role === 'hairOverlay';
  assert.equal(material.transparent, overlay ? true : beforeValues[index].transparent);
  assert.equal(material.depthWrite, overlay ? false : beforeValues[index].depthWrite, 'only coincident hair highlights stop writing depth');
  assert.equal(material.visible, beforeValues[index].visible && beforeValues[index].opacity !== 0);
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(material.gradientMap.colorSpace, THREE.NoColorSpace);
  assert.equal(material.emissiveMap, material.map, 'ambient light is tinted by the original diffuse map');
  assert.equal(material.map.anisotropy, 4);
});
for (const { texture } of textureLoader.loads) {
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace, 'ADD spheres are color imagery');
  assert.equal(texture.flipY, false);
  assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
}
const clothShader = shaders[descriptor('上半身').index];
assert.equal(clothShader.uniforms.aemeathSphereTint.value, 1, 'cloth sphere additions are masked by diffuse color');
assert.ok(clothShader.uniforms.aemeathSphereStrength.value <= .08);
assert.ok(clothShader.uniforms.aemeathSpecular.value < .01);
const metalShader = shaders[descriptor('颈饰品').index];
assert.ok(metalShader.uniforms.aemeathSpecular.value > clothShader.uniforms.aemeathSpecular.value);
assert.ok(metalShader.uniforms.aemeathSphereStrength.value <= .3);
const skinShader = shaders[descriptor('face').index];
assert.ok(skinShader.uniforms.aemeathSpecular.value < .03);
assert.ok(skinShader.uniforms.aemeathSphereStrength.value < .025, 'face paint is not washed out by additive spheres');
assert.ok(skinShader.uniforms.aemeathFaceNormal.value > 0 && skinShader.uniforms.aemeathFaceNormal.value < .5);
assert.ok(shaders[descriptor('MI_Eye').index].uniforms.aemeathSpecular.value < .1, 'authored stars in the iris retain contrast');
assert.ok(shaders[descriptor('后发').index].uniforms.aemeathHairSheen.value > 0);
assert.ok(shaders[descriptor('后发').index].uniforms.aemeathSphereStrength.value < .2);
assert.ok(mesh.material[descriptor('声痕').index].emissive.r > mesh.material[descriptor('face').index].emissive.r * 3, 'only luminous pieces receive the stronger authored-color emission');
for (const shader of shaders) {
  assert.equal(shader.uniforms.aemeathToon.value, 1);
  assert.ok(shader.fragmentShader.includes('max( aemeathRamp.y, fwidth( aemeathNL ) )'));
}
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 0, 4);
camera.lookAt(0, 0, 0);
const head = new THREE.Bone();
head.rotation.y = .4;
controller.updateFrame(camera, head);
const faceForward = skinShader.uniforms.aemeathHeadForward.value;
assert.ok(Math.abs(faceForward.x - Math.sin(.4)) < 1e-7 && Math.abs(faceForward.z - Math.cos(.4)) < 1e-7, 'face lighting basis follows the current head pose in view space');
controller.setAppearance('original');
for (const shader of shaders) {
  assert.equal(shader.uniforms.aemeathSphereMode.value, 0);
  assert.equal(shader.uniforms.aemeathSpecular.value, 0);
  assert.equal(shader.uniforms.aemeathRim.value, 0);
  assert.equal(shader.uniforms.aemeathToon.value, 0);
  assert.equal(shader.uniforms.aemeathHairSheen.value, 0);
  assert.equal(shader.uniforms.aemeathContour.value, 0);
}
assert.ok(mesh.material.every(material => Math.abs(material.emissive.r - .18) < 1e-9));
controller.setAppearance('soft');
assert.equal(skinShader.uniforms.aemeathSphereMode.value, 2, 'switch back without reload or shader compilation');
controller.setQuality('high');
assert.ok(mesh.material.every(material => material.map.anisotropy === 8));
assert.ok(textureLoader.loads.every(({ texture }) => texture.anisotropy === 8));
controller.setQuality('balanced');
assert.ok(mesh.material.every(material => material.map.anisotropy === 4));

// Invalid, subtexture-UV and external resources degrade to diffuse-only.
const fixtureSource = (name, envTextureIndex, envFlag) => ({ name, textureIndex: -1, envTextureIndex, envFlag, diffuse: [1, 1, 1, 1] });
const edgeData = {
  textures: ['tex/shared.png', 'https://example.invalid/no.png', '../outside.png', 'tex/image.tga'],
  materials: [
    fixtureSource('mul', 0, 1), fixtureSource('add', 0, 2), fixtureSource('none', -1, 0),
    fixtureSource('missing', 50, 2), fixtureSource('subtexture', 0, 3),
    fixtureSource('unsupported', 0, 4), fixtureSource('remote', 1, 2),
    fixtureSource('outside', 2, 2), fixtureSource('wrong-format', 3, 2),
  ],
};
const edgeDescriptors = describePmxMaterials(edgeData);
assert.equal(edgeDescriptors[3].issue, 'sphere-texture-missing');
assert.equal(edgeDescriptors[4].issue, 'subtexture-uv-unsupported');
assert.equal(edgeDescriptors[5].issue, 'sphere-mode-unsupported');
assert.equal(edgeDescriptors[6].issue, 'sphere-path-unsupported');
assert.equal(edgeDescriptors[7].issue, 'sphere-path-unsupported');
assert.equal(edgeDescriptors[8].issue, 'sphere-format-unsupported');
const edgeLoader = fakeLoader();
const edgeMesh = makeMesh(edgeData);
const edge = preparePmxMaterials({ mesh: edgeMesh, data: edgeData, manager, texturePath: 'local/', textureLoader: edgeLoader, maxAnisotropy: 2 });
await edge.ready;
assert.equal(edgeLoader.loads.length, 2);
assert.equal(edgeLoader.loads[0].texture.colorSpace, THREE.NoColorSpace, 'MUL is a lighting multiplier');
assert.equal(edgeLoader.loads[1].texture.colorSpace, THREE.SRGBColorSpace, 'same image ADD is separately uploaded as color');
assert.notEqual(edgeLoader.loads[0].texture, edgeLoader.loads[1].texture);
assert.equal(shaderFor(edgeMesh.material[0]).uniforms.aemeathSphereMode.value, 1);
assert.equal(shaderFor(edgeMesh.material[1]).uniforms.aemeathSphereMode.value, 2);
edge.setQuality('high');
assert.ok(edgeMesh.material.every(material => material.map.anisotropy === 2), 'respect GPU anisotropy limit');
const failedMesh = makeMesh(edgeData);
const failed = preparePmxMaterials({ mesh: failedMesh, data: edgeData, manager, texturePath: 'local/', textureLoader: fakeLoader(() => true) });
await failed.ready;
assert.equal(failed.metrics.sphereTextureFailures, 2);
assert.equal(failed.metrics.sphereMappedMaterials, 0);
assert.ok(failedMesh.material.map(shaderFor).every(shader => shader.uniforms.aemeathSphereMode.value === 0), 'failed MUL never blackens the material');
assert.throws(() => preparePmxMaterials({ mesh, data, manager, texturePath: 'https://example.invalid/' }), /local relative/);
assert.throws(() => assembleCharacterFragment('void main() {}'), /incompatible/);
assert.throws(() => assembleCharacterFragment(THREE.ShaderLib.toon.fragmentShader, 'changed future shader'), /incompatible/);
const alpha = new THREE.Texture();
configureTextureRole(alpha, 'alpha');
assert.equal(alpha.colorSpace, THREE.NoColorSpace);

let disposeCount = 0;
for (const { texture } of textureLoader.loads) texture.addEventListener('dispose', () => disposeCount++);
controller.dispose();
controller.dispose();
assert.equal(disposeCount, 7, 'owned textures are disposed once; diffuse/gradient assets are not disposed here');
assert.ok(mesh.material.every(material => material.userData.characterMaterial === undefined));
mesh.material.forEach((material, index) => {
  assert.equal(material.visible, beforeValues[index].visible);
  assert.equal(material.transparent, beforeValues[index].transparent);
  assert.equal(material.depthWrite, beforeValues[index].depthWrite);
});
assert.equal(mesh.material[0].customProgramCacheKey(), mesh.material[0].onBeforeCompile.toString());

// A pending network failure can arrive after a scene/controller is released.
// Its callback must settle ready without undoing the restored caller state.
const lateData = { textures: ['tex/late.png'], materials: [fixtureSource('face', 0, 2)] };
const lateMesh = makeMesh(lateData);
const lateMaterial = lateMesh.material[0];
const priorLateMap = new THREE.Texture();
lateMaterial.emissive.setRGB(.2, .3, .4);
lateMaterial.emissiveMap = priorLateMap;
const priorLateHook = lateMaterial.onBeforeCompile;
let reportLateFailure;
let lateTextureDisposals = 0;
const late = preparePmxMaterials({ mesh: lateMesh, data: lateData, manager, texturePath: 'local/',
  textureLoader: { load(url, onLoad, unused, onError) {
    reportLateFailure = onError;
    const texture = new THREE.Texture();
    texture.addEventListener('dispose', () => lateTextureDisposals++);
    return texture;
  } },
});
late.dispose();
reportLateFailure(new Error('fixture delayed failure'));
await late.ready;
assert.deepEqual(lateMaterial.emissive.toArray(), [.2, .3, .4], 'late failure must not overwrite restored emission');
assert.equal(lateMaterial.emissiveMap, priorLateMap, 'late failure must not reattach the adapter diffuse map');
assert.equal(lateMaterial.onBeforeCompile, priorLateHook);
assert.equal(late.metrics.sphereTextureFailures, 0, 'disposed controllers ignore late diagnostics');
assert.equal(lateTextureDisposals, 1);

edge.dispose();
failed.dispose();
console.log('PMX materials: 44 real groups, 30 restored sphere bindings / 7 textures, r185 shader assembly, original/soft, color spaces, failure fallback and cleanup including late failures passed.');
