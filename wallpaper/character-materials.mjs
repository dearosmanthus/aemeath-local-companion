import * as THREE from 'three';

// These are appearance controls, not replacements for the PMX diffuse textures.
// Names were checked against the supplied 爱弥斯 1.05 PMX, whose atlas is shared
// by skin, cloth and metal. Texture-name-only classification is insufficient.
const PROFILES = Object.freeze({
  eye: { sphere: .065, specular: .06, shininess: 144, rim: .012, ambient: .12, floor: .74, tint: [.80, .85, 1], edge: .08, width: .13 },
  eyeOverlay: { sphere: 0, specular: 0, shininess: 64, rim: 0, ambient: .08, floor: .82, tint: [1, 1, 1], edge: .06, width: .18 },
  face: { sphere: .018, specular: .01, shininess: 36, rim: .006, ambient: .055, floor: .64, tint: [1, .82, .85], edge: .10, width: .16, faceNormal: .35 },
  skin: { sphere: .025, specular: .018, shininess: 48, rim: .014, ambient: .045, floor: .50, tint: [1, .79, .82], edge: .08, width: .11 },
  hair: { sphere: .13, specular: .045, shininess: 80, rim: .035, ambient: .025, floor: .38, tint: [.82, .72, .90], edge: .14, width: .095, hairSheen: .65, contour: .11 },
  hairOverlay: { sphere: .065, specular: .015, shininess: 96, rim: .018, ambient: .02, floor: .50, tint: [.87, .78, .94], edge: .12, width: .11, hairSheen: .4 },
  metal: { sphere: .24, specular: .14, shininess: 104, rim: .03, ambient: .03, floor: .32, tint: [.72, .80, .95], edge: .17, width: .07, contour: .07 },
  cloth: { sphere: .04, specular: .005, shininess: 40, rim: .016, ambient: .035, floor: .44, tint: [.79, .82, .96], edge: .10, width: .12, contour: .045 },
  energy: { sphere: 0, specular: 0, shininess: 48, rim: 0, ambient: .32, floor: .85, tint: [.9, 1, 1], edge: .05, width: .2 },
  detail: { sphere: .025, specular: 0, shininess: 48, rim: 0, ambient: .065, floor: .72, tint: [.94, .92, 1], edge: .06, width: .16 },
});

export function classifyPmxMaterial(source = {}, textures = []) {
  const name = source.name || '';
  const texture = (textures[source.textureIndex] || '').toLowerCase();
  if (/^MI_Eye$/i.test(name)) return 'eye';
  if (/^MI_Eye/i.test(name) || name === 'bai') return 'eyeOverlay';
  if (/^face\+?$/i.test(name)) return 'face';
  if (/肌肤/.test(name)) return 'skin';
  if (/^(前发|后发)/.test(name)) return name.includes('+') ? 'hairOverlay' : 'hair';
  if (/^(颈饰品|后装甲|环饰)/.test(name)) return 'metal';
  if (/^(上半身|qun|腿前挡|靴子|后缎带|小飘带|新規)/.test(name)) return 'cloth';
  if (/^(蓝al|声痕)$/.test(name)) return 'energy';
  if (/^(kou|she|mei|jie|bai2|emo\d+|Cheek)$/i.test(name)) return 'detail';
  if (/hair|bangs/.test(texture)) return 'hair';
  // Unknown atlas regions get the quietest response; never infer skin or metal.
  return 'detail';
}

function localTexturePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.replace(/\\/g, '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) || path.split('/').includes('..')) return null;
  return path;
}

/** Inspect PMX sphere metadata without changing data, vertices or materials. */
export function describePmxMaterials(data) {
  const textures = data.textures || [];
  return (data.materials || []).map((source, index) => {
    const role = classifyPmxMaterial(source, textures);
    const flag = Number(source.envFlag) || 0;
    const textureIndex = source.envTextureIndex;
    let spherePath = null;
    let issue = null;
    if (flag === 3) issue = 'subtexture-uv-unsupported';
    else if (flag !== 0 && flag !== 1 && flag !== 2) issue = 'sphere-mode-unsupported';
    else if (flag !== 0) {
      if (!Number.isInteger(textureIndex) || textureIndex < 0 || textureIndex >= textures.length) issue = 'sphere-texture-missing';
      else {
        spherePath = localTexturePath(textures[textureIndex]);
        if (!spherePath) issue = 'sphere-path-unsupported';
        else if (!/\.(png|jpe?g|bmp|gif|webp|sph|spa)$/i.test(spherePath)) {
          issue = 'sphere-format-unsupported';
          spherePath = null;
        }
      }
    }
    return { index, name: source.name || '', role, sphereMode: spherePath ? flag : 0, spherePath, issue };
  });
}

/**
 * LoadingManager reports both essential maps and optional sphere failures.
 * Match only known sphere-only URLs; shared diffuse/custom-toon maps stay fatal.
 */
export function filterRequiredTextureErrors(data, texturePath, errors) {
  const basePath = localTexturePath(texturePath);
  if (!basePath) return [...errors];
  const path = basePath.replace(/\/?$/, '/');
  const pageUrl = globalThis.location?.href || 'https://pmx-textures.invalid/';
  const key = value => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value.replace(/\\/g, '/'), pageUrl);
      // Decode once after URL parsing. Reserved separators remain encoded;
      // malformed escapes are unknown failures, never silently ignored.
      return url.origin + decodeURI(url.pathname).replace(/\\/g, '/') + url.search;
    } catch { return null; }
  };
  const textureKey = value => {
    const local = localTexturePath(value);
    return local ? key(path + local) : null;
  };
  const optional = new Set(describePmxMaterials(data).filter(item => item.spherePath).map(item => textureKey(item.spherePath)).filter(Boolean));
  const required = new Set();
  for (const material of data.materials || []) {
    const diffuse = textureKey(data.textures?.[material.textureIndex]);
    if (diffuse) required.add(diffuse);
    if (material.toonFlag === 0 && Number.isInteger(material.toonIndex) && material.toonIndex >= 0) {
      const toon = textureKey(data.textures?.[material.toonIndex]);
      if (toon) required.add(toon);
    }
  }
  return errors.filter(error => {
    const normalized = key(error);
    return !normalized || !optional.has(normalized) || required.has(normalized);
  });
}

/** Color textures use sRGB; toon/multiply/alpha values are linear factors. */
export function configureTextureRole(texture, role, anisotropy = 1) {
  if (!texture) return;
  texture.colorSpace = ['diffuse', 'emissive', 'sphere-add'].includes(role) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = Math.max(1, Number(anisotropy) || 1);
  texture.needsUpdate = true;
}

const UNIFORMS = /* glsl */`
uniform sampler2D aemeathSphereMap;
uniform float aemeathSphereMode;
uniform float aemeathSphereStrength;
uniform float aemeathSphereTint;
uniform float aemeathSpecular;
uniform float aemeathShininess;
uniform float aemeathRim;
uniform float aemeathToon;
uniform float aemeathShadowFloor;
uniform vec3 aemeathShadowTint;
uniform vec2 aemeathRamp;
uniform float aemeathFaceNormal;
uniform vec3 aemeathHeadForward;
uniform vec3 aemeathHeadUp;
uniform float aemeathHairSheen;
uniform float aemeathContour;
`;
const IRRADIANCE = 'vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;';
const CHARACTER_IRRADIANCE = /* glsl */`
  if ( aemeathToon > 0.5 ) {
  vec3 aemeathShadeNormal = normalize( mix( geometryNormal, aemeathHeadForward, aemeathFaceNormal ) );
  float aemeathNL = dot( aemeathShadeNormal, directLight.direction );
  float aemeathWidth = max( aemeathRamp.y, fwidth( aemeathNL ) );
  float aemeathBand = smoothstep( aemeathRamp.x - aemeathWidth, aemeathRamp.x + aemeathWidth, aemeathNL );
  vec3 aemeathIrradiance = mix( aemeathShadowTint * aemeathShadowFloor, vec3( 1.0 ), aemeathBand ) * directLight.color;
  irradiance = mix( irradiance, aemeathIrradiance, aemeathToon );
  }
`;
const DIRECT_DIFFUSE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
const DIRECT_SPECULAR = /* glsl */`
  if ( aemeathSpecular > 0.0001 ) {
  // Use actual direct lights and their shadowed intensity, never emissive gloss.
  vec3 aemeathHalf = normalize( directLight.direction + geometryViewDir );
  float aemeathHighlight = pow( max( dot( geometryNormal, aemeathHalf ), 0.0 ), aemeathShininess );
  // A broad highlight across predominantly vertical strands; retain the
  // authored overlay textures for strand-specific detail and the gold tips.
  if ( aemeathHairSheen > 0.001 ) {
  vec3 aemeathFlow = aemeathHeadUp - geometryNormal * dot( aemeathHeadUp, geometryNormal );
  float aemeathFlowLength = length( aemeathFlow );
  vec3 aemeathTangent = aemeathFlow / max( aemeathFlowLength, 0.0001 );
  float aemeathTH = dot( aemeathTangent, aemeathHalf );
  float aemeathStrand = pow( sqrt( max( 0.0, 1.0 - aemeathTH * aemeathTH ) ), aemeathShininess );
  aemeathHighlight = mix( aemeathHighlight, aemeathStrand, aemeathHairSheen * step( 0.001, aemeathFlowLength ) );
  }
  float aemeathLit = max( dot( geometryNormal, directLight.direction ), 0.0 );
  reflectedLight.directSpecular += directLight.color * aemeathHighlight * aemeathLit * aemeathSpecular;
  }
`;
const SURFACE_FINISH = /* glsl */`
  // PMX sphere maps use view-space normals, not equirectangular/cube UVs.
  // Their top row is +Y. Upload with flipY=false, matching MMDLoader's textures.
  if ( aemeathSphereMode > 0.5 ) {
    vec2 aemeathSphereUv = clamp( normal.xy * vec2( 0.5, -0.5 ) + 0.5, 0.001, 0.999 );
    vec3 aemeathSphere = texture2D( aemeathSphereMap, aemeathSphereUv ).rgb;
    if ( aemeathSphereMode < 1.5 ) {
      outgoingLight *= mix( vec3( 1.0 ), aemeathSphere, aemeathSphereStrength );
    } else {
      // Shared clothing atlases must keep their dark regions dark.
      vec3 aemeathTint = mix( vec3( 1.0 ), diffuseColor.rgb, aemeathSphereTint );
      outgoingLight += aemeathSphere * aemeathSphereStrength * aemeathTint;
    }
  }
  outgoingLight += reflectedLight.directSpecular;
  float aemeathFacing = max( dot( normal, normalize( vViewPosition ) ), 0.0 );
  float aemeathEdge = pow( 1.0 - aemeathFacing, 4.0 );
  // Subtle material edge separation without a duplicate outline mesh/pass.
  outgoingLight *= 1.0 - aemeathContour * pow( 1.0 - aemeathFacing, 8.0 );
  float aemeathLightGate = clamp( dot( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse,
    vec3( 0.2126, 0.7152, 0.0722 ) ) * 3.0, 0.0, 1.0 );
  outgoingLight += diffuseColor.rgb * aemeathRim * aemeathEdge * aemeathLightGate;
`;

function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw new Error('PMX material shader is incompatible with this Three.js version: ' + marker);
  return source.replace(marker, replacement);
}

/** Only three stable r185 fragment hooks; keep stock skin/morph/shadow shaders. */
export function assembleCharacterFragment(fragmentShader, toonChunk = THREE.ShaderChunk.lights_toon_pars_fragment) {
  let lighting = replaceOnce(toonChunk, IRRADIANCE, IRRADIANCE + CHARACTER_IRRADIANCE);
  lighting = replaceOnce(lighting, DIRECT_DIFFUSE, DIRECT_DIFFUSE + DIRECT_SPECULAR);
  let fragment = replaceOnce(fragmentShader, '#include <common>', '#include <common>\n' + UNIFORMS);
  fragment = replaceOnce(fragment, '#include <lights_toon_pars_fragment>', lighting);
  return replaceOnce(fragment, '#include <opaque_fragment>', SURFACE_FINISH + '\n#include <opaque_fragment>');
}

/**
 * Call immediately after meshBuilder.build(), before awaiting manager.onLoad.
 * Pass ORIGINAL parsed PMX data even if env flags were stripped for MMDLoader.
 * Optional textureLoader is an offline-test seam and must implement .load().
 */
export function preparePmxMaterials({ mesh, data, manager, texturePath, appearance = 'soft', quality = 'balanced', maxAnisotropy = 4, textureLoader }) {
  if (!mesh || !data || !manager) throw new TypeError('PMX materials require mesh, data and the shared LoadingManager');
  const basePath = localTexturePath(texturePath);
  if (!basePath) throw new TypeError('PMX texturePath must be a local relative directory');
  const path = basePath.replace(/\/?$/, '/');
  const materials = [].concat(mesh.material || []);
  const descriptors = describePmxMaterials(data);
  if (materials.length !== descriptors.length) throw new Error('PMX material metadata does not match mesh material order');
  const loader = textureLoader || new THREE.TextureLoader(manager);
  const textures = new Map();
  const pending = [];
  const records = [];
  const headForward = new THREE.Vector3(0, 0, 1);
  const headUp = new THREE.Vector3(0, 1, 0);
  let disposed = false;
  let activeAppearance = appearance === 'original' ? 'original' : 'soft';
  let activeQuality = quality === 'high' ? 'high' : 'balanced';
  const neutral = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  neutral.needsUpdate = true;
  const metrics = {
    materialGroups: descriptors.length,
    materialRoles: {},
    sphereMappedMaterials: 0,
    sphereTextures: 0,
    sphereTextureFailures: 0,
    unsupportedSphereMaterials: descriptors.filter(item => item.issue).length,
    skippedHiddenMaterials: 0, skippedHiddenTriangles: 0,
    materialDiagnostics: descriptors.filter(item => item.issue).map(item => ({ name: item.name, issue: item.issue })),
  };
  const anisotropy = () => Math.max(1, Math.min(Number(maxAnisotropy) || 1, activeQuality === 'high' ? 8 : 4));

  function loadSphere(descriptor) {
    // Same image in MUL and ADD needs separate texture color-space metadata.
    const key = descriptor.sphereMode + ':' + descriptor.spherePath;
    if (textures.has(key)) return textures.get(key);
    const entry = { texture: null, loaded: false, failed: false, mode: descriptor.sphereMode };
    textures.set(key, entry);
    const ready = new Promise(resolve => {
      const onLoad = texture => {
        if (disposed) { texture.dispose(); resolve(); return; }
        entry.texture = texture;
        entry.loaded = true;
        configureSphere(entry);
        for (const record of records) if (record.sphere === entry) updateRecord(record);
        resolve();
      };
      const onError = () => {
        // A late failed request must not reapply our appearance after dispose
        // has restored the caller's materials. Still settle controller.ready.
        if (disposed) { resolve(); return; }
        entry.failed = true;
        metrics.sphereTextureFailures++;
        metrics.materialDiagnostics.push({ path: descriptor.spherePath, issue: 'sphere-texture-load-failed' });
        for (const record of records) if (record.sphere === entry) updateRecord(record);
        resolve();
      };
      try { entry.texture = loader.load(path + descriptor.spherePath, onLoad, undefined, onError); }
      catch { onError(); }
    });
    pending.push(ready);
    return entry;
  }

  function configureSphere(entry) {
    if (!entry.texture) return;
    configureTextureRole(entry.texture, entry.mode === 2 ? 'sphere-add' : 'sphere-multiply', anisotropy());
    entry.texture.flipY = false;
    entry.texture.wrapS = THREE.ClampToEdgeWrapping;
    entry.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  function updateRecord(record) {
    const { material, descriptor, uniforms, sphere } = record;
    const soft = activeAppearance === 'soft';
    const profile = PROFILES[descriptor.role];
    uniforms.aemeathSphereMap.value = sphere?.loaded && !sphere.failed ? sphere.texture : neutral;
    uniforms.aemeathSphereMode.value = soft && sphere?.loaded && !sphere.failed ? descriptor.sphereMode : 0;
    uniforms.aemeathSphereStrength.value = soft ? profile.sphere : 0;
    uniforms.aemeathSphereTint.value = descriptor.role === 'cloth' || descriptor.role === 'detail' ? 1 : 0;
    uniforms.aemeathSpecular.value = soft ? profile.specular : 0;
    uniforms.aemeathShininess.value = profile.shininess;
    uniforms.aemeathRim.value = soft ? profile.rim : 0;
    uniforms.aemeathToon.value = soft ? 1 : 0;
    uniforms.aemeathShadowFloor.value = profile.floor;
    uniforms.aemeathShadowTint.value.set(...profile.tint);
    uniforms.aemeathRamp.value.set(profile.edge, profile.width);
    uniforms.aemeathFaceNormal.value = soft ? profile.faceNormal || 0 : 0;
    uniforms.aemeathHairSheen.value = soft ? profile.hairSheen || 0 : 0;
    uniforms.aemeathContour.value = soft ? profile.contour || 0 : 0;
    if (material.emissive) material.emissive.setScalar(soft ? profile.ambient : .18);
    material.emissiveMap = material.map || null;
  }

  for (const descriptor of descriptors) {
    const material = materials[descriptor.index];
    if (!material.isMeshToonMaterial) throw new TypeError('PMX character shader expects MeshToonMaterial');
    metrics.materialRoles[descriptor.role] = (metrics.materialRoles[descriptor.role] || 0) + 1;
    const priorHook = material.onBeforeCompile;
    const priorCache = material.customProgramCacheKey;
    const priorCacheValue = priorCache.call(material);
    const uniforms = {
      aemeathSphereMap: { value: neutral }, aemeathSphereMode: { value: 0 },
      aemeathSphereStrength: { value: 0 }, aemeathSphereTint: { value: 0 },
      aemeathSpecular: { value: 0 }, aemeathShininess: { value: 48 }, aemeathRim: { value: 0 },
      aemeathToon: { value: 0 }, aemeathShadowFloor: { value: .5 },
      aemeathShadowTint: { value: new THREE.Vector3(1, 1, 1) }, aemeathRamp: { value: new THREE.Vector2(.1, .1) },
      aemeathFaceNormal: { value: 0 }, aemeathHeadForward: { value: headForward }, aemeathHeadUp: { value: headUp },
      aemeathHairSheen: { value: 0 }, aemeathContour: { value: 0 },
    };
    const record = {
      material, descriptor, uniforms, priorHook, priorCache,
      priorEmissive: material.emissive?.clone(), priorEmissiveMap: material.emissiveMap,
      priorAlphaTest: material.alphaTest, priorSinglePass: material.forceSinglePass,
      priorVisible: material.visible, priorTransparent: material.transparent, priorDepthWrite: material.depthWrite,
      priorMetadata: material.userData.characterMaterial,
      sphere: descriptor.spherePath ? loadSphere(descriptor) : null,
    };
    records.push(record);
    material.onBeforeCompile = function(shader, renderer) {
      priorHook.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = assembleCharacterFragment(shader.fragmentShader);
    };
    material.customProgramCacheKey = () => priorCacheValue + '|aemeath-pmx-material-v2';
    material.userData.characterMaterial = { role: descriptor.role, spherePath: descriptor.spherePath, sphereMode: descriptor.sphereMode };
    configureTextureRole(material.map, 'diffuse', anisotropy());
    configureTextureRole(material.gradientMap, 'toon');
    configureTextureRole(material.alphaMap, 'alpha');
    material.alphaTest = .035;
    material.forceSinglePass = true;
    // These alternate parts have no active material morph in this runtime.
    // Alpha test alone still spends vertex/morph work on their hidden geometry.
    if (data.materials[descriptor.index].diffuse?.[3] === 0) {
      material.visible = false;
      metrics.skippedHiddenMaterials++;
      metrics.skippedHiddenTriangles += data.materials[descriptor.index].faceCount || 0;
    }
    // Coincident highlight surfaces must not occlude the next translucent
    // strand. Base hair retains depth writing and all authored alpha values.
    if (descriptor.role === 'hairOverlay') {
      material.transparent = true;
      material.depthWrite = false;
    }
    updateRecord(record);
    material.needsUpdate = true;
  }

  return {
    metrics,
    ready: Promise.all(pending).then(() => {
      metrics.sphereMappedMaterials = records.filter(record => record.sphere?.loaded && !record.sphere.failed).length;
      metrics.sphereTextures = [...textures.values()].filter(entry => entry.loaded && !entry.failed).length;
      return metrics;
    }),
    setAppearance(value) {
      if (disposed) return;
      activeAppearance = value === 'original' ? 'original' : 'soft';
      records.forEach(updateRecord);
    },
    setQuality(value) {
      if (disposed) return;
      activeQuality = value === 'high' ? 'high' : 'balanced';
      for (const { material } of records) configureTextureRole(material.map, 'diffuse', anisotropy());
      textures.forEach(configureSphere);
    },
    updateFrame(camera, headBone) {
      if (disposed || !camera || !headBone) return;
      headBone.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      headForward.set(0, 0, 1).transformDirection(headBone.matrixWorld).transformDirection(camera.matrixWorldInverse);
      headUp.set(0, 1, 0).transformDirection(headBone.matrixWorld).transformDirection(camera.matrixWorldInverse);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      textures.forEach(entry => entry.texture?.dispose());
      neutral.dispose();
      for (const record of records) {
        const { material } = record;
        material.onBeforeCompile = record.priorHook;
        material.customProgramCacheKey = record.priorCache;
        if (material.emissive && record.priorEmissive) material.emissive.copy(record.priorEmissive);
        material.emissiveMap = record.priorEmissiveMap;
        material.alphaTest = record.priorAlphaTest;
        material.forceSinglePass = record.priorSinglePass;
        material.visible = record.priorVisible;
        material.transparent = record.priorTransparent;
        material.depthWrite = record.priorDepthWrite;
        if (record.priorMetadata === undefined) delete material.userData.characterMaterial;
        else material.userData.characterMaterial = record.priorMetadata;
        material.needsUpdate = true;
      }
    },
  };
}
