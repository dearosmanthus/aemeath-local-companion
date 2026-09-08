import * as THREE from 'three';

// Exact names from the supplied 1.05 rig. Never match 首 against 足首.
const BONE_NAMES = {
  center: 'センター', waist: '腰', lower: '下半身', upper: '上半身', chest: '上半身2',
  neck: '首', head: '頭', leftArm: '左腕', rightArm: '右腕',
  leftShoulder: '左肩', rightShoulder: '右肩',
  leftElbow: '左ひじ', rightElbow: '右ひじ', leftWrist: '左手首', rightWrist: '右手首',
  rightWristTwist: '右手捩',
  leftEye: '左目', rightEye: '右目',
};
export const MORPH_NAMES = {
  blink: 'まばたき', brow: 'にこり', smileEye: '笑い目', smile: '口角上げ',
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', surprise: 'びっくり',
  browRaise: '上', browFocus: '真面目', browRelax: '平行', lidRelax: '垂れ目',
  smileLeft: '左口角上げ', smileRight: '右口角上げ',
};
const HAIR_ROOT_NAMES = [
  'Bone_Hair001_M', 'Bone_Hair001_L', 'Bone_Hair001_R',
  'Bone_Hair011_L', 'Bone_Hair011_R', 'Bone_Hair021_L', 'Bone_Hair021_R',
  'Bone_Hair031_L', 'Bone_Hair031_R', 'Bone_Hair041_L', 'Bone_Hair041_R',
  'Bone_Hair051_M', 'Bone_Hair061_L', 'Bone_Hair061_R', 'Bone_Hair171_L',
  '左侧发A1', '右侧发A1', '后辫子中A1',
];
const damp = THREE.MathUtils.damp;
const smoothStep = THREE.MathUtils.smoothstep;
// Measured from RH child-minus-parent positions, not the unconverted PMX axis.
const RIGHT_FOREARM_AXIS = new THREE.Vector3(-.7775, -.6058, .1689).normalize();

// Exact damped-oscillator transition for a held target. Coefficients are shared
// per group each frame; no fixed-step physics world or per-strand allocation.
function springCoefficients(out, frequency, damping, dt) {
  const damped = Math.sqrt(frequency * frequency - damping * damping);
  const decay = Math.exp(-damping * dt);
  const sine = Math.sin(damped * dt) / damped;
  const cosine = Math.cos(damped * dt);
  out[0] = decay * (cosine + damping * sine);
  out[1] = decay * sine;
  out[2] = -frequency * frequency * out[1];
  out[3] = decay * (cosine - damping * sine);
}

function advanceSpring(strand, yawTarget, pitchTarget, coefficients) {
  const yaw = strand.angle - yawTarget;
  const pitch = strand.pitch - pitchTarget;
  const nextYaw = yawTarget + coefficients[0] * yaw + coefficients[1] * strand.velocity;
  const nextPitch = pitchTarget + coefficients[0] * pitch + coefficients[1] * strand.pitchVelocity;
  strand.velocity = coefficients[2] * yaw + coefficients[3] * strand.velocity;
  strand.pitchVelocity = coefficients[2] * pitch + coefficients[3] * strand.pitchVelocity;
  strand.angle = THREE.MathUtils.clamp(nextYaw, -strand.limit, strand.limit);
  strand.pitch = THREE.MathUtils.clamp(nextPitch, -strand.pitchLimit, strand.pitchLimit);
  // A hard limit must not store outward momentum and kick back on the next tick.
  if (strand.angle !== nextYaw && strand.velocity * nextYaw > 0) strand.velocity = 0;
  if (strand.pitch !== nextPitch && strand.pitchVelocity * nextPitch > 0) strand.pitchVelocity = 0;
}

export class PmxPerformance {
  constructor(mesh) {
    this.mesh = mesh;
    this.bones = new Map();
    this.morphs = {};
    this.weights = { listening: 0, thinking: 0, speaking: 0 };
    this.time = 0;
    this.nextBlink = 2.6;
    this.blinkStart = -10;
    this.blinkDuration = .18;
    this.waveStart = -10;
    this.waveDuration = 3.3;
    this.waveCancelled = true;
    this.waveBlend = 0;
    this.speechGesture = 0;
    this.speechGestureStart = -10;
    this.nextSpeechGesture = 0;
    this.speechGestureCount = 0;
    this.speechGestureStrength = 0;
    this.speechSilence = 0;
    this.fingers = [];
    this.nodStart = -10;
    this.prevState = 'idle';
    this.stateStart = 0;
    this.mouth = 0;
    this.gaze = new THREE.Vector2();
    this.headGaze = new THREE.Vector2();
    this.gazeTarget = new THREE.Vector2();
    this.glanceStart = -10;
    this.nextGlance = Infinity;
    this.glanceDuration = 1.65;
    this.glanceWeight = 0;
    this.glanceDirection = 1;
    this.thoughtCount = 0;
    this.reducedMotion = false;
    this.hair = [];
    this.ribbons = [];
    this.lastHeadYaw = 0;
    this.lastHeadPitch = 0;
    this.lastTorsoYaw = 0;
    this.lastTorsoPitch = 0;
    this.rootSpringCoefficients = new Float64Array(4);
    this.tipSpringCoefficients = new Float64Array(4);
    this.ribbonSpringCoefficients = new Float64Array(4);
    for (const [key, name] of Object.entries(BONE_NAMES)) {
      const node = mesh.skeleton.getBoneByName(name);
      if (node) this.bones.set(key, { node, rest: node.quaternion.clone(), angles: new THREE.Vector3() });
    }
    // This PMX uses fullwidth joint digits and identity rest rotations. Curl
    // axes were measured from its RH joint positions, not assumed local X axes.
    for (const [side, label, sign] of [['left', '左', -1], ['right', '右', 1]]) {
      const fingerAxis = new THREE.Vector3(.06, sign * .18, sign * .982).normalize();
      const thumbAxis = new THREE.Vector3(.1947, sign * .2644, sign * .9446).normalize();
      const addFinger = (name, axis, relaxed, open, articulation) => {
        const node = mesh.skeleton.getBoneByName(name);
        if (node) this.fingers.push({ node, side, axis, rest: node.quaternion.clone(), relaxed, open, articulation, angle: 0 });
      };
      for (const [finger, amount, articulation] of [['人指', .9, .38], ['中指', 1, .30], ['薬指', 1.08, .22], ['小指', 1.16, .16]]) {
        ['１', '２', '３'].forEach((digit, index) => {
          addFinger(label + finger + digit, fingerAxis, [.12, .18, .10][index] * amount, [.025, .035, .02][index], articulation);
        });
      }
      ['０', '１', '２'].forEach((digit, index) => {
        addFinger(label + '親指' + digit, thumbAxis, [0, .04, .06][index], [0, .01, .01][index], .14);
      });
    }
    // Keep only the expressions this performer uses. Reduces the GPU morph texture
    // from 199 full meshes to the selected facial controls. This never rewrites PMX.
    const attrs = mesh.geometry.morphAttributes;
    const original = mesh.morphTargetDictionary;
    const chosen = Object.entries(MORPH_NAMES).filter(([, name]) => original[name] !== undefined);
    for (const kind of Object.keys(attrs)) attrs[kind] = chosen.map(([, name]) => attrs[kind][original[name]]);
    mesh.morphTargetDictionary = {};
    mesh.morphTargetInfluences = chosen.map(() => 0);
    chosen.forEach(([key, name], index) => {
      mesh.morphTargetDictionary[name] = index;
      this.morphs[key] = index;
    });
    this.euler = new THREE.Euler();
    this.quat = new THREE.Quaternion();
    this.grantQuat = new THREE.Quaternion();
    this.grantDelta = new THREE.Quaternion();
    const skeleton = mesh.skeleton.bones;
    this.grants = (mesh.geometry.userData.MMD?.grants || [])
      .filter(grant => !grant.isLocal && grant.affectRotation && skeleton[grant.index] && skeleton[grant.parentIndex])
      .map(grant => ({
        ...grant,
        node: skeleton[grant.index], source: skeleton[grant.parentIndex],
        rest: skeleton[grant.index].quaternion.clone(),
        inverseSourceRest: skeleton[grant.parentIndex].quaternion.clone().invert(),
      }))
      .sort((a, b) => (a.transformationClass || 0) - (b.transformationClass || 0) || a.index - b.index);
    const grantNodes = new Set(this.grants.map(grant => grant.node));
    const spring = (node, limit, pitchLimit, extra = {}) => ({ node, rest: node.quaternion.clone(),
      angle: 0, velocity: 0, pitch: 0, pitchVelocity: 0, limit, pitchLimit, ...extra });
    for (const [index, name] of HAIR_ROOT_NAMES.entries()) {
      const node = mesh.skeleton.getBoneByName(name);
      if (node && !grantNodes.has(node)) this.hair.push(spring(node, .012, .016, { phase: index * .71, root: null }));
    }
    // These three weighted mid-joints are below the roots, not unweighted tip
    // helpers. The back braid's A3 is its crown loop, so use the hanging A9.
    for (const [name, rootName, parentName] of [
      ['左侧发A7', '左侧发A1', '左侧发A6'], ['右侧发A7', '右侧发A1', '右侧发A6'],
      ['后辫子中A9', '后辫子中A1', '后辫子中A8'],
    ]) {
      const node = mesh.skeleton.getBoneByName(name);
      const root = this.hair.find(strand => strand.node.name === rootName);
      if (node?.parent?.name === parentName && root && !grantNodes.has(node)) {
        this.hair.push(spring(node, .009, .012, { root }));
      }
    }
    // Actual independent rear ribbon strips share weights only with adjacent
    // strip joints. Leave the five-column sleeve/skirt grids to authored rigging:
    // isolated procedural bends there would distort their connected surfaces.
    for (const side of ['左', '右']) {
      let previous = null;
      for (const segment of [4, 9]) {
        const node = mesh.skeleton.getBoneByName(`${side}缎带_${segment}_1`);
        if (node?.parent?.name !== `${side}缎带_${segment - 1}_1` || grantNodes.has(node)) continue;
        const strand = spring(node, .008, .010, { previous });
        this.ribbons.push(strand);
        previous = strand;
      }
    }
  }

  wave({ slow = false } = {}) {
    this.waveStart = this.time;
    this.waveDuration = slow ? 7.3 : 3.3;
    this.waveCancelled = false;
  }

  cancelGesture() { this.waveCancelled = true; }

  poseFingers(dt, openness, articulation = 0) {
    for (const finger of this.fingers) {
      const open = finger.side === 'right' ? Math.max(openness, articulation * finger.articulation) : 0;
      const target = THREE.MathUtils.lerp(finger.relaxed, finger.open, open);
      finger.angle = damp(finger.angle, target, 9, dt);
      this.quat.setFromAxisAngle(finger.axis, finger.angle);
      finger.node.quaternion.copy(finger.rest).multiply(this.quat);
    }
  }

  pose(key, x, y, z, dt, speed = 7) {
    const bone = this.bones.get(key);
    if (!bone) return;
    const a = bone.angles;
    a.set(damp(a.x, x, speed, dt), damp(a.y, y, speed, dt), damp(a.z, z, speed, dt));
    this.quat.setFromEuler(this.euler.set(a.x, a.y, a.z));
    bone.node.quaternion.copy(bone.rest).multiply(this.quat);
  }

  poseAxis(key, axis, angle, dt, speed = 7) {
    const bone = this.bones.get(key);
    if (!bone) return;
    bone.roll = damp(bone.roll || 0, angle, speed, dt);
    this.quat.setFromAxisAngle(axis, bone.roll);
    bone.node.quaternion.copy(bone.rest).multiply(this.quat);
    this.euler.setFromQuaternion(this.quat);
    bone.angles.set(this.euler.x, this.euler.y, this.euler.z);
  }

  morph(key, weight, dt, speed = 16) {
    const index = this.morphs[key];
    if (index === undefined) return;
    this.mesh.morphTargetInfluences[index] = damp(this.mesh.morphTargetInfluences[index], Math.max(0, Math.min(1, weight)), speed, dt);
  }

  applyGrants() {
    // PMX append transforms are additive to this frame's pose, including direct
    // eye gaze. Targets are reset BEFORE pose(), never here and never accumulated.
    for (const grant of this.grants) {
      this.grantDelta.copy(grant.inverseSourceRest).multiply(grant.source.quaternion);
      this.grantQuat.identity().slerp(this.grantDelta, grant.ratio);
      grant.node.quaternion.multiply(this.grantQuat);
    }
  }

  updateHair(dt) {
    if (dt <= 0) return;
    const head = this.bones.get('head')?.angles;
    const neck = this.bones.get('neck')?.angles;
    const torso = this.bones.get('upper')?.angles;
    const headYaw = (head?.y || 0) + (neck?.y || 0);
    const headPitch = (head?.x || 0) + (neck?.x || 0);
    const torsoYaw = torso?.y || 0;
    const torsoPitch = torso?.x || 0;
    const yawVelocity = THREE.MathUtils.clamp((headYaw - this.lastHeadYaw) / dt, -1.5, 1.5);
    const pitchVelocity = THREE.MathUtils.clamp((headPitch - this.lastHeadPitch) / dt, -1.5, 1.5);
    const torsoYawVelocity = THREE.MathUtils.clamp((torsoYaw - this.lastTorsoYaw) / dt, -.5, .5);
    const torsoPitchVelocity = THREE.MathUtils.clamp((torsoPitch - this.lastTorsoPitch) / dt, -.5, .5);
    this.lastHeadYaw = headYaw;
    this.lastHeadPitch = headPitch;
    this.lastTorsoYaw = torsoYaw;
    this.lastTorsoPitch = torsoPitch;
    springCoefficients(this.rootSpringCoefficients, 10, 7.5, dt);
    springCoefficients(this.tipSpringCoefficients, 8, 5.6, dt);
    springCoefficients(this.ribbonSpringCoefficients, 7, 5.25, dt);
    for (const strand of this.hair) {
      const root = strand.root;
      const breeze = root || this.reducedMotion ? 0 : Math.sin(this.time * 1.23 + strand.phase) * .0011;
      const yawTarget = this.reducedMotion ? 0 : THREE.MathUtils.clamp(
        root ? root.angle * .7 - yawVelocity * .012 : -yawVelocity * .030 + breeze, -strand.limit * .8, strand.limit * .8);
      const pitchTarget = this.reducedMotion ? 0 : THREE.MathUtils.clamp(
        root ? root.pitch * .65 - pitchVelocity * .015 : -pitchVelocity * .038, -strand.pitchLimit * .8, strand.pitchLimit * .8);
      advanceSpring(strand, yawTarget, pitchTarget, root ? this.tipSpringCoefficients : this.rootSpringCoefficients);
      this.quat.setFromEuler(this.euler.set(strand.pitch, strand.angle, strand.angle * .12));
      strand.node.quaternion.copy(strand.rest).multiply(this.quat);
    }
    for (const strand of this.ribbons) {
      const yawTarget = this.reducedMotion ? 0 : THREE.MathUtils.clamp(
        -torsoYawVelocity * .16 + (strand.previous?.angle || 0) * .65, -.006, .006);
      const pitchTarget = this.reducedMotion ? 0 : THREE.MathUtils.clamp(
        -torsoPitchVelocity * .14 + (strand.previous?.pitch || 0) * .6, -.008, .008);
      advanceSpring(strand, yawTarget, pitchTarget, this.ribbonSpringCoefficients);
      this.quat.setFromEuler(this.euler.set(strand.pitch, strand.angle, 0));
      strand.node.quaternion.copy(strand.rest).multiply(this.quat);
    }
  }

  update(dt, state, energy, pointer, features = {}) {
    dt = THREE.MathUtils.clamp(Number(dt) || 0, 0, .05);
    energy = THREE.MathUtils.clamp(Number(energy) || 0, 0, 1);
    for (const grant of this.grants) grant.node.quaternion.copy(grant.rest);
    this.time += dt;
    const t = this.time;
    const thinking = ['thinking', 'transcribing', 'replying'].includes(state);
    const wasThinking = ['thinking', 'transcribing', 'replying'].includes(this.prevState);
    if (state !== this.prevState) {
      if (state === 'listening') this.nodStart = t;
      if (state === 'speaking') this.nextSpeechGesture = t + .16;
      this.stateStart = t;
      this.prevState = state;
    }
    // The waiting animation belongs to the processing phase, not the words in a
    // conversation. Transcribing -> replying is one continuous thought gesture.
    if (thinking && !wasThinking) {
      this.thoughtCount += 1;
      this.glanceDirection = this.thoughtCount % 2 ? -1 : 1;
      this.nextGlance = t + .32;
    } else if (!thinking) {
      this.nextGlance = Infinity;
    }
    if (thinking && t >= this.nextGlance) {
      this.glanceStart = t;
      this.nextGlance = t + 5.4 + (this.thoughtCount % 3) * .45;
    }
    const w = this.weights;
    for (const key of Object.keys(w)) {
      const active = key === state || (key === 'thinking' && ['transcribing', 'replying'].includes(state));
      w[key] = damp(w[key], active ? 1 : 0, 4, dt);
    }
    const glanceAge = t - this.glanceStart;
    const glanceTarget = thinking && !this.reducedMotion
      ? smoothStep(glanceAge, 0, .32) * (1 - smoothStep(glanceAge, .88, this.glanceDuration)) : 0;
    this.glanceWeight = damp(this.glanceWeight, glanceTarget, 12, dt);
    const pointerX = THREE.MathUtils.clamp(Number(pointer?.x) || 0, -1, 1);
    const pointerY = THREE.MathUtils.clamp(Number(pointer?.y) || 0, -1, 1);
    this.gazeTarget.set(
      THREE.MathUtils.lerp(pointerX, this.glanceDirection * .55, this.glanceWeight),
      THREE.MathUtils.lerp(pointerY, .2, this.glanceWeight),
    );
    // Eyes acquire a target before the head follows. The small compensation below
    // relaxes eye rotation as the head catches up, without accumulating transforms.
    this.gaze.lerp(this.gazeTarget, 1 - Math.exp(-dt * 18));
    this.headGaze.lerp(this.gazeTarget, 1 - Math.exp(-dt * 3.4));
    const breath = Math.sin(t * 1.4) * .011;
    const sway = Math.sin(t * .62) * .02 + Math.sin(t * .27) * .012;
    const syllable = state === 'speaking' ? energy : 0;
    this.mouth = damp(this.mouth, syllable, syllable > this.mouth ? 24 : 32, dt);
    const nodPhase = (t - this.nodStart) / 1.1;
    const nod = !this.reducedMotion && nodPhase >= 0 && nodPhase < 1
      ? Math.sin(nodPhase * Math.PI * 2) * Math.sin(nodPhase * Math.PI) * .06 : 0;
    const headX = -this.headGaze.y * .095 + nod + w.thinking * .018 + this.mouth * .014;
    const headY = this.headGaze.x * .19 + Math.sin(t * .41) * .025;
    const headZ = sway * .45 + w.listening * .055 - w.thinking * .055;
    this.pose('center', 0, sway * .16, 0, dt, 3);
    this.pose('upper', breath - w.listening * .02, sway * .25, sway * .18, dt, 4);
    this.pose('chest', breath * .65, w.thinking * -.025, -sway * .3, dt);
    this.pose('neck', headX * .3, headY * .32, headZ * .3, dt);
    this.pose('head', headX, headY, headZ, dt);
    const eyeX = -this.gaze.y * .068 + this.headGaze.y * .018;
    const eyeY = this.gaze.x * .09 - this.headGaze.x * .025;
    this.pose('leftEye', eyeX, eyeY, 0, dt, 24);
    this.pose('rightEye', eyeX, eyeY, 0, dt, 24);

    const waveAge = Math.max(0, t - this.waveStart) * 3.3 / this.waveDuration;
    const targetWave = this.waveCancelled ? 0 : smoothStep(waveAge, 0, .7) * (1 - smoothStep(waveAge, 2.5, 3.3));
    this.waveBlend = damp(this.waveBlend, targetWave, this.waveCancelled ? 7 : 12, dt);
    const wave = this.waveBlend;
    // Wave only after the forearm is up, and stop oscillating before lowering.
    const swing = wave * smoothStep(waveAge, .65, 1.05) * (1 - smoothStep(waveAge, 2.1, 2.55));
    const wristSwing = Math.sin((waveAge - .75) * Math.PI * 2 * 1.4) * swing;
    // A bounded phrase gesture has preparation, a short hold, and a release.
    // Playback gates it, but every syllable no longer pumps the arm. A cooldown
    // leaves quiet space between gestures even during continuous loud speech.
    this.speechSilence = state === 'speaking' && energy > .06 ? 0 : this.speechSilence + dt;
    if (!this.reducedMotion && state === 'speaking' && energy > .08 && wave < .05 && t >= this.nextSpeechGesture) {
      this.speechGestureStart = t;
      this.speechGestureCount += 1;
      this.speechGestureStrength = Math.min(1, .65 + energy * .45);
      this.nextSpeechGesture = t + 3.8 + (this.speechGestureCount % 2) * .55;
    }
    const phraseAge = t - this.speechGestureStart;
    const phrase = smoothStep(phraseAge, 0, .42) * (1 - smoothStep(phraseAge, .95, 1.8));
    const gestureTarget = !this.reducedMotion && state === 'speaking' && this.speechSilence < .24
      ? phrase * this.speechGestureStrength : 0;
    this.speechGesture = damp(this.speechGesture, gestureTarget, gestureTarget > this.speechGesture ? 8 : 9, dt);
    const gesture = this.speechGesture * (1 - wave);
    const articulation = gesture * smoothStep(phraseAge, .22, .62);
    // Actual shoulder bones sit between shoulder P/C helpers in this rig. Drive
    // only the shoulder, preserving the authored P/C compensation grants.
    this.pose('leftShoulder', 0, -gesture * .007, -gesture * .006, dt, 5);
    this.pose('rightShoulder', -wave * .025 - gesture * .007, wave * .018 + gesture * .020, -wave * .045 - gesture * .018, dt, 6);
    this.pose('leftArm', .02, .02, -.60 - breath, dt, 5);
    this.pose('rightArm', -.04 - wave * .15 - gesture * .012, -.05, .58 - wave * .93 - gesture * .055, dt, 6);
    this.pose('leftElbow', -.06, -.02, -.14, dt);
    this.pose('rightElbow', -.08 - wave * .17, wave * .20 + articulation * .025, .14 - wave * 1.54 - gesture * .070, dt);
    this.pose('leftWrist', 0, 0, -.025, dt);
    this.pose('rightWrist', wave * .08 - articulation * .018, wave * .08 + wristSwing * .09 + articulation * .025, .025 + wristSwing * .14 - articulation * .018, dt, 10);
    this.poseAxis('rightWristTwist', RIGHT_FOREARM_AXIS, wave * .95, dt, 6);
    this.poseFingers(dt, wave, articulation);
    this.applyGrants();
    this.updateHair(dt);

    if (t >= this.nextBlink) {
      this.blinkStart = t;
      this.nextBlink = t + 2.8 + Math.random() * 3.4;
    }
    const phase = (t - this.blinkStart) / this.blinkDuration;
    const blink = phase >= 0 && phase < 1 ? Math.pow(Math.sin(Math.PI * phase), .7) : 0;
    // Exact single expressions avoid additive full/left/right eye variants.
    this.morph('blink', blink, dt, 65);
    const soft = this.appearance === 'soft';
    const engagementPhase = (t - this.stateStart) / 1.8;
    const engagement = !this.reducedMotion && engagementPhase < 1
      ? Math.sin(Math.PI * engagementPhase) ** 2 : 0;
    const closedLips = 1 - this.mouth;
    // Authored vertex morphs, kept weak and eased independently. There are no
    // unilateral blinks, blushes, or inferred emotional reactions in this layer.
    this.morph('brow', ((soft ? .13 : .09) + w.listening * .1 + wave * .12) * (1 - w.thinking * .55), dt, 5);
    this.morph('browRaise', w.listening * (.025 + engagement * .055), dt, 5);
    this.morph('browFocus', w.thinking * (.045 + this.glanceWeight * .025), dt, 4);
    this.morph('browRelax', w.thinking * .035, dt, 4);
    this.morph('lidRelax', (w.listening * .02 + w.thinking * .035) * (1 - blink), dt, 6);
    this.morph('smileEye', ((soft ? .055 : .03) + wave * .11 + w.speaking * .035) * (1 - blink), dt, 6);
    this.morph('smile', ((soft ? .17 : .09) + w.listening * .07 + wave * .16) * (1 - this.mouth), dt, 9);
    this.morph('smileLeft', w.listening * engagement * .022 * closedLips, dt, 6);
    this.morph('smileRight', w.listening * engagement * .016 * closedLips, dt, 6);
    this.morph('surprise', w.listening * engagement * .012 * (1 - blink), dt, 5);
    // Audio energy follows playback, not network arrivals. Spectral balance gives
    // small vowel variation; this is audio-reactive, not phoneme recognition.
    const round = Math.min(.7, (features.low || 0) * .7);
    const wide = Math.min(.45, (features.high || 0) * .55);
    const m = Math.min(.82, this.mouth * .82);
    this.morph('a', m * (1 - round) * (1 - wide), dt, 32);
    this.morph('o', m * round * .7, dt, 32);
    this.morph('u', m * round * .12, dt, 32);
    this.morph('i', m * wide * .58, dt, 32);
    this.morph('e', m * wide * .23, dt, 32);
  }

  inspect() {
    return {
      bones: Object.fromEntries([...this.bones].map(([key, b]) => [key, { name: b.node.name, rotation: b.angles.toArray() }])),
      morphs: Object.fromEntries(Object.entries(this.morphs).map(([key, i]) => [key, this.mesh.morphTargetInfluences[i]])),
      state: this.prevState,
      gaze: { eyes: this.gaze.toArray(), head: this.headGaze.toArray(), target: this.gazeTarget.toArray(),
        glance: this.glanceWeight, reducedMotion: this.reducedMotion },
      appendGrants: this.grants.length,
      hairSprings: this.hair.length,
      ribbonSprings: this.ribbons.length,
      hands: { wave: this.waveBlend, cancelled: this.waveCancelled, speechGesture: this.speechGesture,
        phraseCount: this.speechGestureCount,
        fingers: Object.fromEntries(this.fingers.map(finger => [finger.node.name, finger.angle])) },
    };
  }
}
