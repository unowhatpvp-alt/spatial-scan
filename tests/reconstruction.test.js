import test from 'node:test';
import assert from 'node:assert/strict';
import cv from '@techstark/opencv-js';
import { reconstructFrames } from '../src/reconstruction.worker.js';

const runtime = new Promise(resolve => { if (cv.Mat) resolve(); else cv.onRuntimeInitialized = () => resolve(); });
const width = 640, height = 480, focal = width / (2 * Math.tan(Math.PI / 6));
const fract = x => x - Math.floor(x);
const hash = (x, y, z = 0) => fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453);

function hitBox(origin, ray, min, max) {
  let near = -Infinity, far = Infinity, axis = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ray[i]) < 1e-12) { if (origin[i] < min[i] || origin[i] > max[i]) return null; continue; }
    const p = (min[i] - origin[i]) / ray[i], q = (max[i] - origin[i]) / ray[i];
    const a = Math.min(p, q), b = Math.max(p, q);
    if (a > near) { near = a; axis = i; }
    far = Math.min(far, b);
  }
  return far >= near && near > 0 ? { distance: near, axis } : null;
}
export function renderScene(cameraX, cameraY = 0) {
  const rgba = new Uint8ClampedArray(width * height * 4), origin = [cameraX, cameraY, 0];
  const boxes = [ [[-1.25,-0.65,3.5],[-0.25,0.65,4.15]], [[0.25,-0.35,4.3],[1.3,0.8,5.1]] ];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ray = [(x - (width-1)/2) / focal, (y - (height-1)/2) / focal, 1];
    let distance = 6, axis = 2, surface = 2;
    for (let b = 0; b < boxes.length; b++) { const hit = hitBox(origin, ray, ...boxes[b]); if (hit && hit.distance < distance) { distance = hit.distance; axis = hit.axis; surface = b; } }
    const point = origin.map((v, i) => v + distance * ray[i]);
    const axes = [0,1,2].filter(a => a !== axis);
    const u = Math.floor(point[axes[0]] * 85), v = Math.floor(point[axes[1]] * 85);
    const value = 35 + hash(u, v, surface * 3 + axis) * 205;
    const i = (y * width + x) * 4;
    rgba[i] = value; rgba[i+1] = value * (surface === 0 ? 0.82 : 0.95); rgba[i+2] = value * (surface === 1 ? 0.85 : 0.95); rgba[i+3] = 255;
  }
  return { width, height, rgba };
}

test('actual OpenCV ORB and common-scale PnP reconstruct rendered non-planar views', { timeout: 90000 }, async () => {
  await runtime;
  const frames = [renderScene(-0.28), renderScene(0), renderScene(0.28,0.025)];
  const status = [];
  const model = await reconstructFrames(frames, { fov: 60, maxFeatures: 2400, dense: false }, cv, s => status.push(s.stage));
  console.log('Rendered-scene pipeline statistics:', JSON.stringify(model.stats));
  assert.equal(model.stats.registered, 3, 'third camera must be registered through shared 3D landmarks');
  assert.ok(model.stats.points > 50);
  assert.ok(model.stats.reprojectionError < 2.5);
  assert.equal(model.positions.length, model.colors.length);
  assert.ok([...model.positions].every(Number.isFinite));
  const centers = model.cameras.map(c => [0,1,2].map(j => -(c.R[j]*c.t[0]+c.R[j+3]*c.t[1]+c.R[j+6]*c.t[2])));
  const d = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
  const ratio = d(centers[0],centers[1]) / d(centers[1],centers[2]);
  assert.ok(ratio > 0.7 && ratio < 1.3, `relative camera baselines must share scale, got ${ratio}`);
  assert.ok(status.includes('reconstructing'));
});

test('blank frames fail instead of producing geometry', { timeout: 30000 }, async () => {
  await runtime;
  const blank = { width, height, rgba: new Uint8ClampedArray(width*height*4).fill(255) };
  await assert.rejects(reconstructFrames([blank,blank], { dense:false }, cv), /Too few stable image features/);
});

test('bidirectional stereo adds photometrically checked points', { timeout: 30000 }, async () => {
  await runtime;
  const model = await reconstructFrames([renderScene(-0.28), renderScene(0), renderScene(0.28,0.025)], { fov:60, maxFeatures:2400, dense:true }, cv);
  console.log('Stereo validation:', JSON.stringify(model.stats));
  assert.ok(model.stats.stereoPoints > 20);
  assert.equal(model.stats.surface, 'point-cloud');
  assert.equal(model.stats.scale, 'unmeasured');
});

test('identical textured views fail without camera translation', { timeout: 30000 }, async () => {
  await runtime;
  const frame = renderScene(0);
  await assert.rejects(reconstructFrames([frame,frame], {fov:60,maxFeatures:1800,dense:false}, cv), /Could not establish 3D geometry/);
});
