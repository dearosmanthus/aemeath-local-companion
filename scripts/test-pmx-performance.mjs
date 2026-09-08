// Exercise the actual provided skeleton/vertex morphs without a browser or textures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { MMDLoader } from 'three-stdlib';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The app's package is CommonJS while its browser sources are bundled ES modules.
// Import the unchanged source as ESM, resolving its single package import locally.
const threeUrl = pathToFileURL(resolve(dirname(require.resolve('three')), 'three.module.js')).href;
const source = (await readFile(resolve(root, 'wallpaper/pmx-performance.js'), 'utf8')).replace("from 'three'", `from ${JSON.stringify(threeUrl)}`);
const { PmxPerformance, MORPH_NAMES } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const bytes = await readFile(resolve(root, 'wallpaper/assets/models/aemeath-pmx/aemeath.pmx'));
const loader = new MMDLoader();
const data = loader._getParser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
const selected = new Set(Object.values(MORPH_NAMES));
assert.equal(selected.size, 16, 'retain only the selected facial controls, not the full 199-morph mesh');
for (const name of selected) {
  const authored = data.morphs.find(morph => morph.name === name);
  assert.ok(authored && authored.type === 1 && authored.elementCount > 0, `${name} must be a real authored vertex morph`);
}
assert.ok([...selected].every(name => !/ウィンク|ｳｨﾝｸ|照れ|赤面/.test(name)), 'default face controls exclude winks and blush');
data.morphs = data.morphs.filter(morph => morph.type === 1 && selected.has(morph.name));
data.metadata.morphCount = data.morphs.length;
const geometry = loader.meshBuilder.geometryBuilder.build(data);
const createRig = () => {
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bones = geometry.bones.map(def => {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.fromArray(def.pos);
    bone.quaternion.fromArray(def.rotq);
    return bone;
  });
  geometry.bones.forEach((def, index) => (bones[def.parent] || mesh).add(bones[index]));
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return { mesh, bones };
};
const { mesh, bones } = createRig();
const performer = new PmxPerformance(mesh);
const pointer = new THREE.Vector2(.7, -.25);
const tick = (seconds, state, energy, gaze = pointer) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) performer.update(1 / 60, state, energy, gaze, { low: .3, high: .4 });
};
const mouthSum = () => ['a','i','u','e','o'].reduce((sum,key) => sum + mesh.morphTargetInfluences[performer.morphs[key]], 0);
assert.equal(performer.bones.get('neck').node.name, '首');
assert.equal(performer.bones.get('center').node.name, 'センター');
assert.equal(performer.bones.get('rightShoulder').node.name, '右肩');
assert.equal(performer.bones.get('rightShoulder').node.parent.name, '右肩P');
assert.equal(performer.bones.get('rightArm').node.parent.name, '右肩C');
assert.equal(performer.grants.length, 36);
assert.ok(performer.hair.length >= 16);
const ankle = bones.find(bone => bone.name === '左足首');
const ankleRest = ankle.quaternion.clone();
tick(1, 'listening', 1);
assert.ok(ankle.quaternion.angleTo(ankleRest) < 1e-8, 'head tracking must not animate 足首');
assert.ok(mouthSum() < 1e-8, 'microphone energy must not move the character mouth while listening');
assert.ok(Math.abs(performer.bones.get('head').angles.y) > .02, 'actual head follows pointer');
tick(.6, 'speaking', .8);
assert.ok(mouthSum() > .15, 'playback energy opens actual vowel morphs');
tick(.7, 'speaking', 0);
assert.ok(mouthSum() < .001, 'silence inside speech closes all vowel morphs');
tick(.3, 'speaking', .8);
tick(.7, 'idle', 1);
assert.ok(mouthSum() < .001, 'ending speech closes mouth even if an old energy value remains');

// The twist is a source bone not directly driven by the performer. A constant
// source pose must produce a constant quarter-angle grant after thousands of ticks.
const twist = bones.find(bone => bone.name === '左腕捩');
const follower = bones.find(bone => bone.name === '左腕捩1');
twist.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), .4);
const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .1);
tick(35, 'idle', 0);
assert.ok(follower.quaternion.angleTo(expected) < 1e-6, 'append grant may not accumulate over frames');
const eye = bones.find(bone => bone.name === '左目');
assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(eye.quaternion).y) > .02, 'grant update must retain direct eye gaze');
assert.ok(performer.hair.some(strand => Math.abs(strand.angle) > .0001), 'hair springs move');
assert.ok(performer.hair.every(strand => Math.abs(strand.angle) <= .012), 'hair motion remains subtle and bounded');
assert.ok(bones.every(bone => bone.quaternion.toArray().every(Number.isFinite)), 'no invalid joint rotations');
const originalSmile = mesh.morphTargetInfluences[performer.morphs.smile];
performer.appearance = 'soft';
tick(1.5, 'idle', 0);
assert.ok(mesh.morphTargetInfluences[performer.morphs.smile] > originalSmile + .04, 'soft look has a restrained additional smile');
assert.ok(mouthSum() < .001, 'soft expression must not open the speech mouth');
performer.appearance = 'original';
tick(1.5, 'idle', 0);
assert.ok(Math.abs(mesh.morphTargetInfluences[performer.morphs.smile] - originalSmile) < .001, 'original expression is reversible');
// Real hand joints, including fullwidth names. Do not animate terminal helpers.
assert.equal(performer.fingers.length, 30);
assert.equal(performer.fingers.some(finger => finger.node.name.endsWith('先')), false);
const indexFinger = side => performer.fingers.find(finger => finger.node.name === side + '人指２');
const leftRelaxed = indexFinger('左').angle;
const rightRelaxed = indexFinger('右').angle;
assert.ok(rightRelaxed > .14 && rightRelaxed < .20, 'idle fingers have a small relaxed curl');
assert.ok(performer.fingers.every(finger => finger.angle >= 0 && finger.angle < .25));
performer.wave();
tick(.3, 'idle', 0);
assert.ok(Math.abs(performer.bones.get('rightWrist').angles.z - .025) < .01, 'no wrist oscillation before raising the arm');
tick(1, 'idle', 0);
assert.ok(performer.waveBlend > .9);
assert.ok(indexFinger('右').angle < rightRelaxed * .4, 'wave opens the right fingers');
assert.ok(Math.abs(indexFinger('左').angle - leftRelaxed) < .002, 'other hand remains relaxed');
const raisedElbow = performer.bones.get('rightElbow').angles.z;
assert.ok(raisedElbow < -1 && raisedElbow > -1.6, 'forearm bends in the expected direction within a modest range');
const wristTwist = performer.bones.get('rightWristTwist');
assert.equal(wristTwist.node.name, '右手捩');
assert.ok(wristTwist.roll > .85 && wristTwist.roll <= .95, 'forearm rotates the palm toward the viewer without overtwisting');
const checkWristGrants = () => {
  const followers = performer.grants.filter(grant => grant.source === wristTwist.node);
  assert.equal(followers.length, 3, 'sleeve twist is distributed across the three authored followers');
  for (const grant of followers) {
    const delta = grant.inverseSourceRest.clone().multiply(wristTwist.node.quaternion);
    const expectedPose = grant.rest.clone().multiply(new THREE.Quaternion().slerp(delta, grant.ratio));
    assert.ok(grant.node.quaternion.angleTo(expectedPose) < 1e-6, 'wrist followers use only this frame\'s source rotation');
  }
};
checkWristGrants();
const raisedTwist = wristTwist.roll;
performer.cancelGesture();
tick(1 / 60, 'idle', 0);
assert.ok(Math.abs(performer.bones.get('rightElbow').angles.z - raisedElbow) < .08, 'cancel must not teleport the elbow');
assert.ok(Math.abs(wristTwist.roll - raisedTwist) < .04, 'cancel must not snap the wrist twist');
tick(1.5, 'idle', 0);
assert.ok(performer.waveBlend < .001, 'cancel releases the underlying gesture');
assert.ok(Math.abs(performer.bones.get('rightElbow').angles.z - .14) < .002, 'cancel returns the arm to rest');
assert.ok(Math.abs(indexFinger('右').angle - rightRelaxed) < .002, 'cancel restores relaxed fingers');
assert.ok(wristTwist.roll < .003, 'cancel releases the forearm twist');
checkWristGrants();
performer.wave({ slow: true });
tick(3, 'idle', 0);
assert.ok(performer.waveBlend > .9, 'slow preview stays raised long enough to inspect');
tick(5, 'idle', 0);
assert.ok(performer.waveBlend < .001, 'slow preview finishes by eight seconds');
tick(1, 'idle', 0);
assert.ok(wristTwist.roll < .001, 'normal completion also releases the forearm twist');
checkWristGrants();
tick(1, 'speaking', .8);
assert.ok(performer.speechGesture > .7, 'hand emphasis responds to actual voice energy');
tick(1.5, 'speaking', 0);
assert.ok(performer.speechGesture < .001, 'speech pauses release the hand emphasis');
assert.ok(bones.every(bone => bone.quaternion.toArray().every(Number.isFinite)), 'hands and grant followers remain finite');

// Independent rest rigs make gaze timing, cancellation, and frame-rate checks
// reproducible. Blinks are disabled only here to isolate the state transitions.
const makeFaceRig = (reducedMotion = false) => {
  const rig = createRig();
  const actor = new PmxPerformance(rig.mesh);
  actor.nextBlink = Infinity;
  actor.reducedMotion = reducedMotion;
  const advance = (seconds, state = 'idle', gaze = new THREE.Vector2(), fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) actor.update(1 / fps, state, 0, gaze);
  };
  return { ...rig, actor, advance };
};
const gazeRig = makeFaceRig();
gazeRig.advance(5 / 60, 'idle', new THREE.Vector2(1, 0));
assert.ok(gazeRig.actor.gaze.x > gazeRig.actor.headGaze.x * 2, 'eyes acquire a new target before the head follows');
assert.ok(gazeRig.actor.bones.get('leftEye').angles.y / .065 > gazeRig.actor.bones.get('head').angles.y / .19,
  'the actual eye bones lead the actual head bone, not only their input vectors');
gazeRig.advance(2, 'idle', new THREE.Vector2(1, 0));
assert.ok(gazeRig.actor.headGaze.x > .998, 'head catches up to a sustained target');
assert.ok(Math.abs(gazeRig.actor.bones.get('leftEye').angles.y - .065) < .001,
  'eyes relax to the authored small gaze range as the head catches up');
gazeRig.advance(1, 'transcribing');
const activeGlance = gazeRig.actor.glanceWeight;
assert.ok(activeGlance > .7 && activeGlance <= 1, 'thinking briefly glances away');
assert.ok(gazeRig.actor.gaze.x < -.2, 'thinking glance changes actual eye direction');
gazeRig.advance(1 / 60, 'replying');
assert.ok(Math.abs(gazeRig.actor.glanceWeight - activeGlance) < .04, 'transcribing to replying preserves a continuous thought gesture');
gazeRig.advance(2.1, 'replying');
assert.ok(gazeRig.actor.glanceWeight < .001 && Math.abs(gazeRig.actor.gaze.x) < .001,
  'a long wait returns to the viewer instead of staring away indefinitely');
const focusedBrow = gazeRig.actor.inspect().morphs.browFocus;
gazeRig.advance(1, 'listening');
const face = gazeRig.actor.inspect().morphs;
assert.ok(face.browRaise > .03 && face.smileLeft > 0, 'listening uses the real additional brow and lip-corner controls');
assert.ok(face.browFocus < focusedBrow * .15, 'leaving thinking releases the focused brow');
assert.ok(['a', 'i', 'u', 'e', 'o'].every(key => face[key] === 0), 'microexpressions never drive vowel opening');
gazeRig.advance(1, 'thinking');
const beforeCancel = gazeRig.actor.bones.get('head').angles.y;
gazeRig.advance(1 / 60, 'idle');
assert.ok(Math.abs(gazeRig.actor.bones.get('head').angles.y - beforeCancel) < .015, 'cancelled thought gaze does not snap the head');
gazeRig.advance(2, 'idle');
const idleFace = gazeRig.actor.inspect().morphs;
assert.ok(gazeRig.actor.glanceWeight < .0001, 'cancelled thought releases its glance');
assert.ok(['browRaise', 'browFocus', 'browRelax', 'lidRelax', 'smileLeft', 'smileRight'].every(key => idleFace[key] < .001),
  'idle releases added state microexpressions');
assert.ok(gazeRig.mesh.morphTargetInfluences.every(value => Number.isFinite(value) && value >= 0 && value <= 1),
  'every retained face influence stays finite and bounded');

const reducedRig = makeFaceRig(true);
reducedRig.advance(1, 'thinking');
assert.equal(reducedRig.actor.glanceWeight, 0, 'reduced motion disables autonomous thought glances');
assert.equal(reducedRig.actor.gaze.length(), 0, 'reduced motion adds no autonomous eye target');
reducedRig.advance(.6, 'listening');
assert.equal(reducedRig.actor.inspect().morphs.smileLeft, 0, 'reduced motion skips the transient lip-corner pulse');

const slowRig = makeFaceRig();
const fastRig = makeFaceRig();
for (const [rig, fps] of [[slowRig, 30], [fastRig, 120]]) {
  rig.advance(.5, 'idle', pointer, fps);
  rig.advance(1, 'listening', pointer, fps);
}
for (const key of ['browRaise', 'browFocus', 'lidRelax', 'smileLeft', 'smileRight']) {
  assert.ok(Math.abs(slowRig.actor.inspect().morphs[key] - fastRig.actor.inspect().morphs[key]) < .005,
    `${key} transition is consistent at 30 and 120 fps`);
}
for (const key of ['head', 'leftEye', 'rightEye']) {
  assert.ok(slowRig.actor.bones.get(key).node.quaternion.angleTo(fastRig.actor.bones.get(key).node.quaternion) < .006,
    `${key} gaze and listening motion stay consistent at 30 and 120 fps`);
}

const phraseRigs = [makeFaceRig(), makeFaceRig()];
for (const [index, rig] of phraseRigs.entries()) {
  const fps = index ? 120 : 30;
  rig.advance(2, 'idle', new THREE.Vector2(), fps);
  for (let frame = 0; frame < fps; frame++) rig.actor.update(1 / fps, 'speaking', .8, new THREE.Vector2());
  assert.ok(rig.actor.speechGesture > .8, 'the first audible phrase has a gentle held emphasis');
  assert.ok(rig.actor.bones.get('rightShoulder').angles.z < -.01, 'shoulder participates in phrase emphasis');
  const indexJoint = rig.actor.fingers.find(finger => finger.node.name === '右人指２');
  const ringJoint = rig.actor.fingers.find(finger => finger.node.name === '右薬指２');
  assert.ok(indexJoint.angle / indexJoint.relaxed < ringJoint.angle / ringJoint.relaxed - .04,
    'the index relaxes slightly farther than the ring finger instead of moving as one rigid hand');
}
for (const key of ['leftShoulder', 'rightShoulder', 'rightArm', 'rightElbow', 'rightWrist', 'rightWristTwist']) {
  assert.ok(phraseRigs[0].actor.bones.get(key).node.quaternion.angleTo(phraseRigs[1].actor.bones.get(key).node.quaternion) < .008,
    `${key} phrase articulation is consistent at 30 and 120 fps`);
}
const phraseRig = phraseRigs[0];
for (let frame = 0; frame < 150; frame++) phraseRig.actor.update(1 / 60, 'speaking', .8, new THREE.Vector2());
assert.equal(phraseRig.actor.speechGestureCount, 1, 'continuous speech does not retrigger on every loud syllable');
assert.ok(phraseRig.actor.speechGesture < .001, 'the hand returns to rest even while the phrase remains loud');
for (let frame = 0; frame < 150; frame++) phraseRig.actor.update(1 / 60, 'speaking', frame % 6 < 3 ? .2 : 1, new THREE.Vector2());
assert.equal(phraseRig.actor.speechGestureCount, 2, 'a later phrase can make another bounded gesture after its cooldown');
phraseRig.advance(2, 'idle');
for (const key of ['leftShoulder', 'rightShoulder']) {
  assert.ok(phraseRig.actor.bones.get(key).angles.length() < .0001, 'shoulders return to rest after speech');
}
for (let frame = 0; frame < 120; frame++) reducedRig.actor.update(1 / 60, 'speaking', .8, new THREE.Vector2());
assert.equal(reducedRig.actor.speechGestureCount, 0, 'reduced motion disables autonomous speech gestures');
assert.equal(reducedRig.actor.bones.get('rightShoulder').angles.length(), 0, 'reduced motion keeps the extra shoulder motion at rest');
assert.ok(reducedRig.actor.mouth > .7, 'reduced motion preserves audio-driven mouth animation');

// Actual authored handtip positions verify the whole shoulder/arm/grant chain,
// not only the local Euler controls. Sample both the raising and lowering arc.
const waveRig = makeFaceRig();
waveRig.advance(2);
waveRig.mesh.updateMatrixWorld(true);
const tip = waveRig.bones.find(bone => bone.name === '右人指３先');
const head = waveRig.bones.find(bone => bone.name === '頭');
const shoulder = waveRig.actor.bones.get('rightShoulder').node;
const bodyHeight = head.getWorldPosition(new THREE.Vector3()).y;
const shoulderHeight = shoulder.getWorldPosition(new THREE.Vector3()).y;
const previousTip = tip.getWorldPosition(new THREE.Vector3());
const tipPosition = new THREE.Vector3();
const tipBounds = new THREE.Box3();
let maxTipStep = 0;
waveRig.actor.wave();
for (let frame = 0; frame < 300; frame++) {
  waveRig.actor.update(1 / 60, 'idle', 0, new THREE.Vector2());
  waveRig.mesh.updateMatrixWorld(true);
  tip.getWorldPosition(tipPosition);
  tipBounds.expandByPoint(tipPosition);
  maxTipStep = Math.max(maxTipStep, tipPosition.distanceTo(previousTip));
  previousTip.copy(tipPosition);
  assert.ok(tipPosition.toArray().every(Number.isFinite), 'wave handtip remains finite');
  assert.ok(tipPosition.x < -.03 * bodyHeight, 'wave hand stays on its own side of the torso');
  assert.ok(Math.abs(tipPosition.x) < .5 * bodyHeight && Math.abs(tipPosition.z) < .3 * bodyHeight,
    'wave hand remains within a reachable envelope around the body');
  assert.ok(tipPosition.y > .4 * bodyHeight && tipPosition.y < 1.25 * bodyHeight,
    'wave hand remains between waist level and a bounded height above the head');
}
assert.ok(tipBounds.max.y > shoulderHeight, 'the wave actually raises the fingertips above the shoulder');
assert.ok(maxTipStep < bodyHeight * .025, `the complete wave chain has no sudden jumps: ${maxTipStep}, body ${bodyHeight}`);
assert.ok(waveRig.actor.bones.get('rightShoulder').angles.length() < .0001, 'completed wave releases the shoulder');
assert.ok(waveRig.bones.find(bone => bone.name === '右肩P').quaternion.angleTo(new THREE.Quaternion()) < 1e-8,
  'shoulder participation preserves the authored P helper');

const waveRateRigs = [makeFaceRig(), makeFaceRig()];
for (const [index, rig] of waveRateRigs.entries()) {
  const fps = index ? 120 : 30;
  rig.advance(2, 'idle', new THREE.Vector2(), fps);
  rig.actor.wave();
  rig.advance(1.5, 'idle', new THREE.Vector2(), fps);
  rig.mesh.updateMatrixWorld(true);
}
for (const key of ['rightShoulder', 'rightArm', 'rightElbow', 'rightWristTwist']) {
  assert.ok(waveRateRigs[0].actor.bones.get(key).node.quaternion.angleTo(waveRateRigs[1].actor.bones.get(key).node.quaternion) < .008,
    `${key} raised wave remains consistent at 30 and 120 fps`);
}
const waveTips = waveRateRigs.map(rig => rig.bones.find(bone => bone.name === '右人指３先').getWorldPosition(new THREE.Vector3()));
assert.ok(waveTips[0].distanceTo(waveTips[1]) < bodyHeight * .005,
  'raised wave handtip stays within half a percent of body height across frame rates');

assert.equal(performer.hair.length, 21, 'retain 18 hair roots and three verified hanging mid-joints');
assert.equal(performer.ribbons.length, 4, 'only four independent rear ribbon joints receive secondary motion');
const secondaryNames = new Set([...performer.hair, ...performer.ribbons].map(strand => strand.node.name));
for (const name of secondaryNames) {
  const index = data.bones.findIndex(bone => bone.name === name);
  assert.ok(data.vertices.some(vertex => vertex.skinIndices.some((bone, slot) => bone === index && vertex.skinWeights[slot] > .02)),
    `${name} is a weighted joint, not a terminal/helper marker`);
  assert.equal(Boolean(data.bones[index].grant), false, `${name} has no append transform to overwrite`);
}
assert.ok([...secondaryNames].every(name => !/袖|裙|スカート/.test(name)), 'connected sleeve/skirt grids keep their authored rigging');

// Give identical head/torso turns at different frame rates. The mid-joint must
// trail its root, then settle; elapsed hidden-tab gaps may not inject momentum.
const springRateRigs = [makeFaceRig(), makeFaceRig()];
const springPeaks = [];
for (const [index, rig] of springRateRigs.entries()) {
  const fps = index ? 120 : 30;
  const root = rig.actor.hair.find(strand => strand.node.name === '后辫子中A1');
  const mid = rig.actor.hair.find(strand => strand.node.name === '后辫子中A9');
  const peaks = { root: 0, mid: 0, rootAt: 0, midAt: 0 };
  for (let frame = 1; frame <= fps; frame++) {
    const time = frame / fps;
    rig.actor.time = time;
    rig.actor.bones.get('head').angles.set(-Math.min(time, .4) * .25, Math.min(time, .4) * .6, 0);
    rig.actor.bones.get('upper').angles.set(Math.min(time, .4) * .06, Math.min(time, .4) * .05, 0);
    rig.actor.updateHair(1 / fps);
    if (Math.abs(root.pitch) > peaks.root) { peaks.root = Math.abs(root.pitch); peaks.rootAt = time; }
    if (Math.abs(mid.pitch) > peaks.mid) { peaks.mid = Math.abs(mid.pitch); peaks.midAt = time; }
    for (const strand of [...rig.actor.hair, ...rig.actor.ribbons]) {
      assert.ok(Math.abs(strand.angle) <= strand.limit && Math.abs(strand.pitch) <= strand.pitchLimit,
        'turn inertia respects both yaw and pitch limits');
    }
  }
  assert.ok(peaks.root > .007 && peaks.mid > .004, 'real head turns create visible but restrained secondary motion');
  assert.ok(peaks.midAt > peaks.rootAt, 'the hanging braid reaches its maximum after the attached root');
  springPeaks.push(peaks);
}
for (let index = 0; index < springRateRigs[0].actor.hair.length; index++) {
  const a = springRateRigs[0].actor.hair[index];
  const b = springRateRigs[1].actor.hair[index];
  assert.ok(a.node.quaternion.angleTo(b.node.quaternion) < .0006, 'hair spring timing stays consistent at 30 and 120 fps');
}
for (let index = 0; index < springRateRigs[0].actor.ribbons.length; index++) {
  const a = springRateRigs[0].actor.ribbons[index];
  const b = springRateRigs[1].actor.ribbons[index];
  assert.ok(a.node.quaternion.angleTo(b.node.quaternion) < .0006, 'ribbon spring timing stays consistent at 30 and 120 fps');
}
for (const rig of springRateRigs) {
  rig.actor.reducedMotion = true;
  for (let frame = 0; frame < 240; frame++) rig.actor.updateHair(1 / 60);
  assert.ok([...rig.actor.hair, ...rig.actor.ribbons].every(strand => strand.node.quaternion.angleTo(strand.rest) < 1e-6),
    'reduced motion settles all secondary motion to rest, including ambient hair movement');
  rig.actor.reducedMotion = false;
  rig.actor.update(60, 'idle', 0, new THREE.Vector2(-1, 1));
  assert.ok([...rig.actor.hair, ...rig.actor.ribbons].every(strand =>
    Number.isFinite(strand.velocity) && Math.abs(strand.angle) <= strand.limit && Math.abs(strand.pitch) <= strand.pitchLimit),
  'a long hidden-tab gap remains bounded instead of injecting a physics impulse');
}

// Compare actual skinned vertices with identical body motion and static hair /
// ribbons. This catches an unexpected long lever arm or mixed skinning region.
const movingRig = makeFaceRig();
const staticRig = makeFaceRig();
staticRig.actor.updateHair = () => {};
const affectedBones = new Set();
for (const name of secondaryNames) {
  const node = movingRig.mesh.skeleton.getBoneByName(name);
  node.traverse(bone => { if (bone.isBone) affectedBones.add(movingRig.bones.indexOf(bone)); });
}
const sampleVertices = data.vertices.flatMap((vertex, index) => index % 11 === 0 && vertex.skinIndices.some((bone, slot) =>
  affectedBones.has(bone) && vertex.skinWeights[slot] > .02) ? [index] : []);
assert.ok(sampleVertices.length > 500, 'skin safety check samples real affected geometry');
let maxSecondarySkinTravel = 0;
const movingPosition = new THREE.Vector3();
const staticPosition = new THREE.Vector3();
movingRig.actor.wave();
staticRig.actor.wave();
for (let frame = 0; frame < 180; frame++) {
  const look = new THREE.Vector2(frame < 60 ? 1 : -1, frame < 90 ? -.8 : .8);
  for (const rig of [movingRig, staticRig]) {
    rig.actor.update(1 / 60, frame < 90 ? 'listening' : 'speaking', .8, look);
    rig.mesh.updateMatrixWorld(true);
    rig.mesh.skeleton.update();
  }
  if (frame % 10) continue;
  for (const vertex of sampleVertices) {
    movingPosition.fromBufferAttribute(geometry.attributes.position, vertex);
    staticPosition.copy(movingPosition);
    movingRig.mesh.applyBoneTransform(vertex, movingPosition);
    staticRig.mesh.applyBoneTransform(vertex, staticPosition);
    maxSecondarySkinTravel = Math.max(maxSecondarySkinTravel, movingPosition.distanceTo(staticPosition));
  }
  for (const side of ['左', '右']) {
    const ribbon = movingRig.mesh.skeleton.getBoneByName(`${side}缎带_9_1`).getWorldPosition(movingPosition);
    assert.ok(ribbon.y < bodyHeight * .68, 'rear ribbon mid-joints remain below chest/face during raised-arm motion');
  }
}
assert.ok(maxSecondarySkinTravel > .02 && maxSecondarySkinTravel < bodyHeight * .02,
  `secondary skinned motion stays within 2% of body height: ${maxSecondarySkinTravel}`);

for (const rig of [gazeRig, reducedRig, slowRig, fastRig, ...phraseRigs, waveRig, ...waveRateRigs, ...springRateRigs, movingRig, staticRig]) rig.mesh.material.dispose();
console.log(JSON.stringify({ passed: true, vertexCount: geometry.attributes.position.count, boneCount: bones.length, retainedMorphs: Object.keys(mesh.morphTargetDictionary).length, appendGrants: performer.grants.length, hairSprings: performer.hair.length, ribbonSprings: performer.ribbons.length, silenceMouth: mouthSum(), secondaryMotion: { sampledVertices: sampleVertices.length, maxSkinTravel: maxSecondarySkinTravel, springPeaks }, waveHandtipBounds: { min: tipBounds.min.toArray(), max: tipBounds.max.toArray(), maxFrameTravel: maxTipStep } }, null, 2));
geometry.dispose();
mesh.material.dispose();
