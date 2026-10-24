import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePair, triangulate, project, identityPose, cameraCenter } from '../src/geometry.js';

const K = { fx: 720, fy: 715, cx: 480, cy: 360 };
function random(seed = 1842) { let x = seed; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
function rotationY(a) { return [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]; }
function distance(a, b) { return Math.hypot(...a.map((v, i) => v - b[i])); }
function scene(count = 220, options = {}) {
  const rng = random(options.seed ?? 1321);
  const pose = options.pose ?? { R: rotationY(0.065), t: [-0.45, 0.025, 0.018] };
  const matches = [];
  for (let i = 0; i < count; i++) {
    const xyz = [(rng() - 0.5) * 4.5, (rng() - 0.5) * 3.2, 3 + rng() * 6];
    const a = project(xyz, identityPose(), K), b = project(xyz, pose, K);
    const noisy = (p) => p.map((v) => v + (rng() - 0.5) * (options.noise ?? 0.2));
    const bad = i < (options.outliers ?? 0);
    matches.push({ a: noisy(a), b: bad ? [rng() * 960, rng() * 720] : noisy(b), ia: i, ib: i, xyz, bad });
  }
  return { pose, matches };
}

test('triangulates known points with general world-to-camera poses', () => {
  const a = { R: rotationY(-0.22), t: [0.2, -0.1, 0.3] };
  const b = { R: rotationY(0.14), t: [-0.9, 0.08, 0.2] };
  const xyz = [0.3, 0.2, 5.1];
  const result = triangulate(project(xyz, a, K), project(xyz, b, K), a, b, K);
  assert.ok(result);
  assert.ok(distance(result.xyz, xyz) < 1e-9);
  assert.ok(result.error < 1e-9);
  const c = cameraCenter(a);
  assert.ok(Math.hypot(...[0, 1, 2].map((r) => a.R[r * 3] * c[0] + a.R[r * 3 + 1] * c[1] + a.R[r * 3 + 2] * c[2] + a.t[r])) < 1e-10);
});

test('recovers camera motion and actual 3D shape despite 27 percent outliers', () => {
  const { pose, matches } = scene(220, { outliers: 60, noise: 0.35 });
  const result = estimatePair(matches, K, { iterations: 1800, seed: 42 });
  assert.ok(result.points.length >= 130, `${result.points.length} recovered points`);
  assert.ok(result.inliers.every((m) => matches.includes(m)), 'preserves match identities');
  assert.ok(result.error < 0.7, `median reprojection ${result.error}`);
  assert.ok(distance(result.R, pose.R) < 0.045, `rotation distance ${distance(result.R, pose.R)}`);
  const baseline = Math.hypot(...pose.t);
  assert.ok(distance(result.t, pose.t.map((v) => v / baseline)) < 0.08);
  const errors = result.points.filter((p) => !p.match.bad).map((p) => distance(p.xyz.map((v) => v * baseline), p.match.xyz)).sort((a, b) => a - b);
  assert.ok(errors[errors.length >> 1] < 0.25, `median shape error ${errors[errors.length >> 1]}`);
  assert.ok(result.parallax > 1.5);
});

test('rejects camera rotation without translation rather than fabricating geometry', () => {
  const { matches } = scene(120, { pose: { R: rotationY(0.15), t: [0, 0, 0] }, noise: 0.15 });
  assert.throws(() => estimatePair(matches, K, { iterations: 700, seed: 55 }), /translation|Parallax|motion|geometry/);
});

test('rejects zero baseline, negative depth, invalid intrinsics and too few features', () => {
  assert.equal(triangulate([480, 360], [480, 360], identityPose(), identityPose(), K), null);
  assert.equal(triangulate([480, 360], [580, 360], identityPose(), { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, 0, 0] }, K), null);
  assert.throws(() => estimatePair([], K), /few/);
  assert.throws(() => estimatePair(scene().matches, { ...K, fx: 0 }), /intrinsics/);
});

test('seeded RANSAC is reproducible', () => {
  const { matches } = scene(90, { outliers: 15 });
  const first = estimatePair(matches, K, { seed: 912, iterations: 500 });
  const second = estimatePair(matches, K, { seed: 912, iterations: 500 });
  assert.deepEqual(first.R, second.R);
  assert.deepEqual(first.t, second.t);
});
test('linear epipolar fit and manifold refinement tolerate pixel noise before pose recovery', () => {
  const rng = random(4 * 5153);
  const pose = { R: rotationY(0.04 + (rng() - 0.5) * 0.2), t: [-0.5, 0.03, 0.04] };
  const camera = { ...K, fy: 720 };
  const matches = Array.from({ length: 180 }, (_, i) => {
    const xyz = [(rng() - 0.5) * 4, (rng() - 0.5) * 3, 3 + rng() * 6];
    const noisy = (p) => p.map((v) => v + (rng() - 0.5) * 1.5);
    return { a: noisy(project(xyz, identityPose(), camera)), b: i < 45 ? [rng() * 960, rng() * 720] : noisy(project(xyz, pose, camera)), ia: i, ib: i };
  });
  const result = estimatePair(matches, camera, { seed: 4, iterations: 1800 });
  assert.ok(result.points.length >= 125);
  assert.ok(result.error < 0.6);
  assert.ok(distance(result.R, pose.R) < 0.04);
});