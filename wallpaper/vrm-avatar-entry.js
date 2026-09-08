import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MMDLoader } from 'three-stdlib';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { PmxPerformance, MORPH_NAMES } from './pmx-performance.js';
import { readView, saveView, framingTarget, settleView, renderBudget } from './avatar-view.mjs';
import { preparePmxMaterials, filterRequiredTextureErrors } from './character-materials.mjs';
import { createCharacterShadows } from './character-shadows.mjs';
import { RenderPerformance, FramePacer, conversationBusy } from './render-performance.mjs';

const canvas = document.getElementById('vrmCanvas');
const sceneElement = document.getElementById('scene');
const options = new URLSearchParams(location.search);
let preferenceStorage;
try { preferenceStorage = window.localStorage; } catch { /* Private/embedded mode. */ }
const savedView = readView(preferenceStorage);
const runtime = {
  ready: false, state: 'idle', audioLevel: 0, targetAudioLevel: 0, features: {},
  vrm: null, modelRoot: null, pmxModel: false, mixer: null, performer: null,
  ...savedView, previewState: null, previewUntil: 0,
  metrics: {},
  setState(value) {
    if (this.previewState && !['idle', 'connecting'].includes(value)) this.stopPreview('conversation');
    this.state = value || 'idle';
  },
  setAudioLevel(value) { this.targetAudioLevel = THREE.MathUtils.clamp(Number(value) || 0, 0, 1); },
  setSpeechFeatures(features) {
    if (features?.speaking && this.previewState) this.stopPreview('conversation');
    this.features = features || {};
  },
  preview(state) {
    if (!this.ready || ['speaking', 'listening', 'thinking', 'transcribing', 'replying'].includes(this.state)) return false;
    const wave = state === 'wave' || state === 'wave-slow';
    this.previewState = wave ? 'idle' : state;
    this.previewUntil = performance.now() + (state === 'wave-slow' ? 8000 : 4000);
    if (wave) this.performer?.wave({ slow: state === 'wave-slow' });
    else this.performer?.cancelGesture();
    return true;
  },
  stopPreview(reason = 'stop') {
    this.previewState = null;
    this.previewUntil = 0;
    this.performer?.cancelGesture();
    window.dispatchEvent(new CustomEvent('aemeath-preview-end', { detail: { reason } }));
  },
  setFraming(value) {
    this.framing = value === 'full' ? 'full' : 'portrait';
    saveView(preferenceStorage, this);
    resize();
    window.dispatchEvent(new Event('aemeath-controls-change'));
  },
  setQuality(value) {
    this.quality = value === 'high' ? 'high' : 'balanced';
    performanceMonitor.reset();
    pmxMaterials?.setQuality(this.quality);
    saveView(preferenceStorage, this);
    resize();
    window.dispatchEvent(new Event('aemeath-controls-change'));
  },
  setAppearance(value) {
    this.appearance = value === 'original' ? 'original' : 'soft';
    saveView(preferenceStorage, this);
    applyAppearance();
    window.dispatchEvent(new Event('aemeath-controls-change'));
  },
  inspect() {
    return { ready: this.ready, state: this.state, preview: this.previewState, framing: this.framing,
      quality: this.quality, appearance: this.appearance, metrics: this.metrics, pose: this.performer?.inspect(), audio: this.audioLevel };
  },
};
window.AemeathAvatar = runtime;
let renderer, camera, pmxMaterials, characterShadows;
let keyLight, fillLight, rimLight, ambientLight;
const modelHeight = 1.72;
let frame = 0;
let disposed = false;
const scene = new THREE.Scene();
const pointer = new THREE.Vector2();
const gaze = new THREE.Vector2();
let lastPointerAt = 0;
let elapsed = 0;
let lastFrame = 0;
let currentView, targetView;
let rasterBudget = renderBudget(1280, 720, 1, runtime.quality);
const performanceMonitor = new RenderPerformance();
const framePacer = new FramePacer();
let wasBusy = false;
let lastBusyAt = -Infinity;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function applyAppearance() {
  if (!renderer || !camera || !keyLight) return;
  const soft = runtime.appearance === 'soft';
  keyLight.color.set(soft ? 0xfff5f0 : 0xfff5ee);
  keyLight.intensity = soft ? 1.55 : 1.6;
  keyLight.position.set(soft ? -3 : -1.5, soft ? 4.5 : 3.2, soft ? 6 : 4);
  fillLight.intensity = soft ? .22 : .5;
  ambientLight.intensity = soft ? .30 : .8;
  ambientLight.groundColor.set(soft ? 0x655a77 : 0x9995b3);
  rimLight.intensity = soft ? .34 : 0;
  camera.fov = soft ? 24 : 28;
  if (runtime.modelRoot) {
    runtime.modelRoot.rotation.y = soft ? -.055 : 0;
    if (pmxMaterials) pmxMaterials.setAppearance(runtime.appearance);
    else runtime.modelRoot.traverse(object => {
      for (const material of object.material ? [].concat(object.material) : []) {
        if (material.emissive) material.emissive.setRGB(soft ? .075 : .18, soft ? .075 : .18, soft ? .075 : .18);
      }
    });
  }
  if (runtime.performer) runtime.performer.appearance = runtime.appearance;
  sceneElement.dataset.appearance = runtime.appearance;
  resize();
}

function updateFraming(dt, snap = false) {
  if (!targetView || !camera) return;
  if (!currentView) currentView = { ...targetView };
  settleView(currentView, targetView, dt, snap || reducedMotion.matches);
  const distance = currentView.viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.set(0, currentView.targetY, distance);
  camera.lookAt(0, currentView.targetY, 0);
  if (runtime.modelRoot) runtime.modelRoot.position.x = currentView.offsetX;
}

function resize() {
  if (!renderer || !camera) return;
  const bounds = canvas.getBoundingClientRect();
  rasterBudget = renderBudget(bounds.width, bounds.height, devicePixelRatio, runtime.quality,
    { busy: wasBusy, pressure: performanceMonitor.pressure });
  framePacer.reset();
  renderer.setPixelRatio(rasterBudget.pixelRatio);
  renderer.setSize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)), false);
  camera.aspect = bounds.width / Math.max(1, bounds.height);
  targetView = framingTarget(camera.aspect, runtime.framing, modelHeight);
  camera.updateProjectionMatrix();
  updateFraming(0, !runtime.ready);
  sceneElement.dataset.framing = runtime.framing;
  sceneElement.dataset.quality = runtime.quality;
  runtime.metrics.pixelRatio = Math.round(rasterBudget.pixelRatio * 100) / 100;
  sceneElement.dataset.renderScale = String(runtime.metrics.pixelRatio);
  sceneElement.dataset.performanceMode = wasBusy ? 'conversation' : performanceMonitor.pressure ? 'adaptive' : runtime.quality;
  sceneElement.dataset.targetFps = String(Math.round(1000 / rasterBudget.frameInterval));
}

async function loadPmx() {
  const missingTextures = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => url.replace(/\\/g, '/'));
  manager.onError = url => missingTextures.push(url);
  const loader = new MMDLoader(manager);
  const url = 'assets/models/aemeath-pmx/aemeath.pmx';
  const data = await new Promise((resolve, reject) => loader.loadPMX(url, resolve, undefined, reject));
  if (disposed) throw new Error('角色页面已关闭');
  const originalMorphCount = data.morphs.length;
  const keep = new Set(Object.values(MORPH_NAMES));
  data.morphs = data.morphs.filter(m => m.type === 1 && keep.has(m.name));
  data.metadata.morphCount = data.morphs.length;
  const texturesReady = new Promise(resolve => { manager.onLoad = resolve; });
  // MeshToonMaterial no longer consumes the old loader's envMap/combine.
  // Retain PMX metadata for our adapter without loading discarded textures.
  const meshData = { ...data, materials: data.materials.map(material => ({
    ...material, envTextureIndex: -1, envFlag: 0,
  })) };
  const mesh = loader.meshBuilder.build(meshData, 'assets/models/aemeath-pmx/');
  pmxMaterials = preparePmxMaterials({ mesh, data, manager,
    texturePath: 'assets/models/aemeath-pmx/', appearance: runtime.appearance,
    quality: runtime.quality, maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
  await Promise.all([texturesReady, pmxMaterials.ready]);
  const requiredTextureErrors = filterRequiredTextureErrors(data, 'assets/models/aemeath-pmx/', missingTextures);
  if (requiredTextureErrors.length) throw new Error('角色贴图加载失败（' + requiredTextureErrors.length + '张）');
  for (const m of mesh.material) {
    if (m.map?.transparent || m.opacity < 1) m.transparent = true;
    m.needsUpdate = true;
  }
  runtime.performer = new PmxPerformance(mesh);
  runtime.pmxModel = true;
  runtime.metrics = {
    ...runtime.metrics, ...pmxMaterials.metrics, visualVersion: 'game-toon-v4',
    sourceMorphs: originalMorphCount, activeMorphs: data.morphs.length,
    vertices: data.metadata.vertexCount, bones: data.metadata.boneCount,
    missingTextures: requiredTextureErrors.length,
  };
  return { root: mesh, url, kind: 'pmx', data };
}

async function loadFallback() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register(parser => new VRMLoaderPlugin(parser));
  let error;
  // Generic import tests may be a different character: never silently swap her.
  const urls = options.get('avatar') === 'glb'
    ? ['assets/models/aemeath.glb'] : ['assets/models/aemeath.vrm'];
  for (const url of urls) {
    try {
      const gltf = await loader.loadAsync(url);
      runtime.vrm = gltf.userData.vrm || null;
      if (runtime.vrm) VRMUtils.rotateVRM0(runtime.vrm);
      const root = runtime.vrm?.scene || gltf.scene;
      if (gltf.animations?.length) {
        runtime.mixer = new THREE.AnimationMixer(root);
        runtime.mixer.clipAction(gltf.animations[0]).play();
      }
      return { root, url, kind: runtime.vrm ? 'vrm' : 'generic' };
    } catch (caught) { error = caught; }
  }
  throw error;
}

async function loadModel() {
  if (options.get('avatar') === 'pet') return;
  try {
    let model;
    try { model = options.get('avatar') === 'glb' ? await loadFallback() : await loadPmx(); }
    catch (error) {
      pmxMaterials?.dispose();
      pmxMaterials = null;
      if (disposed) return;
      console.warn('[avatar]', error.message);
      model = await loadFallback();
    }
    if (disposed) {
      pmxMaterials?.dispose();
      pmxMaterials = null;
      return;
    }
    const root = model.root;
    const box = new THREE.Box3().setFromObject(root);
    root.scale.multiplyScalar(modelHeight / Math.max(.1, box.max.y - box.min.y));
    root.updateMatrixWorld(true);
    root.position.y = -new THREE.Box3().setFromObject(root).min.y;
    runtime.modelRoot = root;
    scene.add(root);
    applyAppearance();
    if (model.kind === 'pmx') {
      characterShadows = createCharacterShadows({ mesh: root, data: model.data, renderer, keyLight });
      runtime.metrics.shadows = characterShadows.metrics;
      characterShadows.update({ camera, now: performance.now(), appearance: runtime.appearance,
        pressure: performanceMonitor.pressure });
    }
    renderer.render(scene, camera);
    runtime.ready = true;
    sceneElement.classList.add('vrm-live');
    sceneElement.dataset.visualVersion = 'game-toon-v4';
    sceneElement.classList.remove('avatar-generic');
    window.dispatchEvent(new CustomEvent('aemeath-avatar-ready', { detail: { url: model.url, kind: model.kind } }));
  } catch (error) {
    characterShadows?.dispose();
    characterShadows = null;
    runtime.ready = false;
    sceneElement.classList.remove('vrm-live');
    sceneElement.classList.add('lightweight-mode');
    window.dispatchEvent(new CustomEvent('aemeath-avatar-error', { detail: { message: error.message } }));
    console.error('[avatar]', error);
  }
}

function render(timestamp) {
  if (disposed) return;
  frame = requestAnimationFrame(render);
  if (document.hidden || !runtime.ready) { lastFrame = 0; return; }
  if (conversationBusy(runtime.state) || runtime.features?.speaking) lastBusyAt = timestamp;
  const busy = timestamp - lastBusyAt < 2500;
  if (busy !== wasBusy) {
    wasBusy = busy;
    performanceMonitor.reset();
    resize();
  }
  if (!framePacer.due(timestamp, rasterBudget.frameInterval)) return;
  const frameStarted = performance.now();
  const frameMs = lastFrame ? timestamp - lastFrame : rasterBudget.frameInterval;
  const dt = Math.min(.05, Math.max(.001, frameMs / 1000));
  lastFrame = timestamp;
  elapsed += dt;
  updateFraming(dt);
  if (runtime.previewState && timestamp >= runtime.previewUntil) runtime.stopPreview('finished');
  const state = runtime.previewState || runtime.state;
  const pointerActive = timestamp - lastPointerAt < 7000;
  gaze.x = THREE.MathUtils.damp(gaze.x, pointerActive ? pointer.x : Math.sin(elapsed * .31) * .09, 4, dt);
  gaze.y = THREE.MathUtils.damp(gaze.y, pointerActive ? pointer.y : .01, 4, dt);
  const previewLevel = runtime.previewState === 'speaking' ? Math.max(0, Math.sin(elapsed * 6.5)) * .65 : 0;
  const level = runtime.previewState ? previewLevel : runtime.targetAudioLevel;
  runtime.audioLevel = state === 'speaking' ? level : 0;
  if (runtime.performer) {
    runtime.performer.reducedMotion = reducedMotion.matches;
    runtime.performer.update(dt, state, runtime.audioLevel, gaze, runtime.previewState ? { low: .25, high: .2 } : runtime.features);
  }
  if (runtime.vrm) {
    const head = runtime.vrm.humanoid.getNormalizedBoneNode('head');
    if (head) head.rotation.set(-gaze.y * .1, gaze.x * .16, Math.sin(elapsed) * .01);
    runtime.vrm.expressionManager?.setValue('aa', runtime.audioLevel * .7);
    runtime.vrm.expressionManager?.setValue('blink', Math.max(0, (Math.sin(elapsed * .9) - .992) * 125));
    runtime.vrm.update(dt);
  }
  runtime.mixer?.update(dt);
  pmxMaterials?.updateFrame(camera, runtime.performer?.bones.get('head')?.node);
  characterShadows?.update({ camera, now: timestamp, appearance: runtime.appearance,
    pressure: performanceMonitor.pressure });
  renderer.render(scene, camera);
  runtime.metrics.drawCalls = renderer.info.render.calls;
  runtime.metrics.triangles = renderer.info.render.triangles;
  runtime.metrics.textures = renderer.info.memory.textures;
  const measured = performanceMonitor.sample({ now: timestamp, frameMs,
    cpuMs: performance.now() - frameStarted, interval: rasterBudget.frameInterval });
  if (measured) {
    Object.assign(runtime.metrics, measured);
    sceneElement.dataset.drawCalls = String(runtime.metrics.drawCalls);
    sceneElement.dataset.triangles = String(runtime.metrics.triangles);
    sceneElement.dataset.shadowMode = characterShadows?.metrics.reason || 'unavailable';
    sceneElement.dataset.shadowUpdates = String(characterShadows?.metrics.shadowUpdates || 0);
    sceneElement.dataset.fps = String(measured.fps);
    sceneElement.dataset.frameMs = String(measured.frameMs);
    sceneElement.dataset.cpuFrameMs = String(measured.cpuFrameMs);
    if (measured.changed) resize();
    window.dispatchEvent(new CustomEvent('aemeath-performance', { detail: {
      ...measured, mode: sceneElement.dataset.performanceMode, pixelRatio: runtime.metrics.pixelRatio,
    } }));
  }
}

if (canvas && sceneElement) {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    camera = new THREE.PerspectiveCamera(28, 1, .05, 50);
    keyLight = new THREE.DirectionalLight(0xfff5ee, 1.6);
    fillLight = new THREE.DirectionalLight(0xe7f1ff, .5);
    fillLight.position.set(2.5, 2.2, 3);
    rimLight = new THREE.DirectionalLight(0xcdbaff, .6);
    rimLight.position.set(2.5, 2.5, -3);
    ambientLight = new THREE.HemisphereLight(0xffffff, 0x9995b3, .8);
    scene.add(keyLight, fillLight, rimLight, ambientLight);
    applyAppearance();
    window.addEventListener('pointermove', event => {
      pointer.set(THREE.MathUtils.clamp(event.clientX / innerWidth * 2 - 1, -1, 1), THREE.MathUtils.clamp(1 - event.clientY / innerHeight * 2, -1, 1));
      lastPointerAt = performance.now();
    }, { passive: true });
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      lastFrame = 0;
      framePacer.reset();
      performanceMonitor.reset();
    });
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      runtime.ready = false;
      sceneElement.classList.remove('vrm-live');
      window.dispatchEvent(new CustomEvent('aemeath-avatar-error', { detail: { message: '显示连接暂时中断，已切换轻量角色' } }));
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (!runtime.modelRoot) return;
      runtime.ready = true;
      sceneElement.classList.add('vrm-live');
      window.dispatchEvent(new CustomEvent('aemeath-avatar-ready', { detail: { kind: runtime.pmxModel ? 'pmx' : 'vrm' } }));
    });
    window.addEventListener('pagehide', () => {
      disposed = true;
      cancelAnimationFrame(frame);
      characterShadows?.dispose();
      pmxMaterials?.dispose();
      renderer.dispose();
    });
    resize();
    void loadModel();
    frame = requestAnimationFrame(render);
  } catch (error) {
    console.error('[avatar] WebGL unavailable', error);
    sceneElement.classList.add('lightweight-mode');
  }
}
