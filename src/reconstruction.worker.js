import { estimatePair, triangulate, project, identityPose, cameraCenter } from './geometry.js';

const scope = typeof self !== 'undefined' && typeof self.postMessage === 'function' ? self : null;
let loading;

export function loadCV() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local vision engine did not start. Reload online once, then try again.')), 45000);
    try {
      if (!scope.cv) importScripts('./vendor/opencv.js');
      const cv = scope.cv;
      const ready = () => { clearTimeout(timer); resolve({ cv }); }; // Emscripten modules are self-resolving thenables: never await cv itself.
      if (cv.Mat) ready();
      else {
        cv.onRuntimeInitialized = ready;
        cv.onAbort = (reason) => { clearTimeout(timer); reject(new Error(`Vision engine stopped: ${reason}`)); };
      }
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  return loading;
}

const dispose = (...objects) => { for (const object of objects) { try { object?.delete?.(); } catch {} } };
const median = values => { if (!values.length) return 0; const copy = [...values].sort((a, b) => a - b); return copy[Math.floor(copy.length / 2)]; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const intrinsic = (width, height, fov) => { const f = width / (2 * Math.tan(fov * Math.PI / 360)); return { fx: f, fy: f, cx: (width - 1) / 2, cy: (height - 1) / 2 }; };
const colorAt = (frame, p) => { const i = (clamp(Math.round(p[1]), 0, frame.height - 1) * frame.width + clamp(Math.round(p[0]), 0, frame.width - 1)) * 4; return [frame.rgba[i] / 255, frame.rgba[i + 1] / 255, frame.rgba[i + 2] / 255]; };

export function extractFeatures(cv, frame, maxFeatures) {
  let input, gray, keypoints, descriptors, detector, mask;
  try {
    input = cv.matFromArray(frame.height, frame.width, cv.CV_8UC4, frame.rgba);
    gray = new cv.Mat();
    cv.cvtColor(input, gray, cv.COLOR_RGBA2GRAY);
    keypoints = new cv.KeyPointVector();
    descriptors = new cv.Mat();
    mask = new cv.Mat();
    detector = new cv.ORB(maxFeatures);
    detector.detectAndCompute(gray, mask, keypoints, descriptors, false);
    const points = [];
    for (let i = 0; i < keypoints.size(); i++) { const k = keypoints.get(i); points.push([k.pt.x, k.pt.y]); }
    const result = { points, descriptors, gray: new Uint8Array(gray.data) };
    descriptors = null;
    return result;
  } finally { dispose(input, gray, keypoints, descriptors, detector, mask); }
}

export function matchFeatures(cv, a, b) {
  if (a.descriptors.rows < 2 || b.descriptors.rows < 2) return [];
  let matcher, forward, reverse;
  try {
    matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    forward = new cv.DMatchVectorVector();
    reverse = new cv.DMatchVectorVector();
    matcher.knnMatch(a.descriptors, b.descriptors, forward, 2);
    matcher.knnMatch(b.descriptors, a.descriptors, reverse, 1);
    const back = new Map();
    for (let i = 0; i < reverse.size(); i++) {
      const row = reverse.get(i);
      if (row.size()) { const m = row.get(0); back.set(m.queryIdx, m.trainIdx); }
      dispose(row);
    }
    const matches = [];
    for (let i = 0; i < forward.size(); i++) {
      const row = forward.get(i);
      if (row.size() >= 2) {
        const m = row.get(0), n = row.get(1);
        if (m.distance < 72 && m.distance < 0.78 * n.distance && back.get(m.trainIdx) === m.queryIdx) {
          matches.push({ a: a.points[m.queryIdx], b: b.points[m.trainIdx], ia: m.queryIdx, ib: m.trainIdx, distance: m.distance });
        }
      }
      dispose(row);
    }
    return matches.sort((x, y) => x.distance - y.distance);
  } finally { dispose(matcher, forward, reverse); }
}

function estimatePose(cv, correspondences, K) {
  let object, image, camera, distortion, rvec, tvec, inliers, rotation;
  try {
    if (correspondences.length < 10) return null;
    object = cv.matFromArray(correspondences.length, 1, cv.CV_64FC3, correspondences.flatMap(c => c.xyz));
    image = cv.matFromArray(correspondences.length, 1, cv.CV_64FC2, correspondences.flatMap(c => c.pixel));
    camera = cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
    distortion = cv.Mat.zeros(4, 1, cv.CV_64F);
    rvec = new cv.Mat(); tvec = new cv.Mat(); inliers = new cv.Mat(); rotation = new cv.Mat();
    const success = cv.solvePnPRansac(object, image, camera, distortion, rvec, tvec, false, 180, 2.8, 0.995, inliers, cv.SOLVEPNP_EPNP);
    if (!success || inliers.rows < 8 || inliers.rows / correspondences.length < 0.35) return null;
    cv.Rodrigues(rvec, rotation);
    const pose = { R: Array.from(rotation.data64F), t: Array.from(tvec.data64F) };
    if (pose.R.length !== 9 || pose.t.length !== 3 || ![...pose.R, ...pose.t].every(Number.isFinite)) return null;
    const accepted = [];
    for (const index of inliers.data32S) {
      const c = correspondences[index], p = project(c.xyz, pose, K);
      const depth = pose.R[6] * c.xyz[0] + pose.R[7] * c.xyz[1] + pose.R[8] * c.xyz[2] + pose.t[2];
      if (p && depth > 0 && Math.hypot(p[0] - c.pixel[0], p[1] - c.pixel[1]) < 3) accepted.push(c);
    }
    return accepted.length >= 8 ? { pose, accepted } : null;
  } catch { return null; }
  finally { dispose(object, image, camera, distortion, rvec, tvec, inliers, rotation); }
}

function depthOf(x, pose) { return pose.R[6] * x[0] + pose.R[7] * x[1] + pose.R[8] * x[2] + pose.t[2]; }
function fromRay(x, y, z, pose, K) {
  const p = [(x - K.cx) * z / K.fx - pose.t[0], (y - K.cy) * z / K.fy - pose.t[1], z - pose.t[2]], r = pose.R;
  return [r[0] * p[0] + r[3] * p[1] + r[6] * p[2], r[1] * p[0] + r[4] * p[1] + r[7] * p[2], r[2] * p[0] + r[5] * p[1] + r[8] * p[2]];
}
function sample(gray, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return NaN;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, i = iy * width + ix;
  return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + width] * (1 - fx) + gray[i + width + 1] * fx) * fy;
}
function patch(gray, width, height, x, y) {
  if (x < 4 || y < 4 || x >= width - 5 || y >= height - 5) return null;
  const values = [], half = 3;
  let mean = 0;
  for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) { const value = sample(gray, width, height, x + dx, y + dy); values.push(value); mean += value; }
  mean /= values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) { values[i] -= mean; variance += values[i] ** 2; }
  if (variance < 49 * 25) return null;
  return { values, magnitude: Math.sqrt(variance) };
}
function scorePatch(source, gray, width, height, x, y) {
  if (x < 4 || y < 4 || x >= width - 5 || y >= height - 5) return -1;
  let sum = 0, squared = 0, dot = 0, i = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const v = sample(gray, width, height, x + dx, y + dy);
    sum += v; squared += v * v; dot += source.values[i++] * v;
  }
  const variance = squared - sum * sum / 49;
  return variance > 49 * 25 ? dot / (source.magnitude * Math.sqrt(variance)) : -1;
}
function depthInterval(landmarks, pose) {
  const depths = landmarks.map(l => depthOf(l.xyz, pose)).filter(z => z > 0).sort((a, b) => a - b);
  if (depths.length < 30) return null;
  const near = depths[Math.floor(depths.length * 0.05)] * 0.8, far = depths[Math.floor(depths.length * 0.95)] * 1.2;
  return near > 0 && far > near ? [1 / far, 1 / near] : null;
}
function searchDepth(x, y, poseA, poseB, K, source, target, interval, width, height, samples = 72) {
  const values = [], delta = (interval[1] - interval[0]) / (samples - 1);
  let best = null;
  for (let i = 0; i < samples; i++) {
    const inv = interval[0] + i * delta, xyz = fromRay(x, y, 1 / inv, poseA, K);
    if (depthOf(xyz, poseB) <= 0) continue;
    const uv = project(xyz, poseB, K);
    if (!uv) continue;
    const score = scorePatch(source, target, width, height, uv[0], uv[1]);
    const c = { inv, uv, score, xyz };
    values.push(c);
    if (!best || score > best.score) best = c;
  }
  if (!best || best.score < 0.9) return null;
  const second = values.reduce((s, c) => Math.hypot(c.uv[0] - best.uv[0], c.uv[1] - best.uv[1]) > 2.5 ? Math.max(s, c.score) : s, -1);
  if (second > best.score - 0.045) return null;
  const center = best.inv;
  for (let i = -4; i <= 4; i++) {
    const inv = center + i * delta / 4;
    if (inv < interval[0] || inv > interval[1]) continue;
    const xyz = fromRay(x, y, 1 / inv, poseA, K), uv = project(xyz, poseB, K);
    if (!uv || depthOf(xyz, poseB) <= 0) continue;
    const score = scorePatch(source, target, width, height, uv[0], uv[1]);
    if (score > best.score) best = { inv, uv, score, xyz };
  }
  return best;
}

function densifyPair(a, b, features, frames, poses, landmarks, K, maxPoints, third) {
  const width = frames[a].width, height = frames[a].height;
  const intervalA = depthInterval(landmarks, poses[a]), intervalB = depthInterval(landmarks, poses[b]);
  if (!intervalA || !intervalB) return [];
  const dense = [], step = Math.max(8, Math.ceil(Math.sqrt(width * height / maxPoints)));
  for (let y = 8; y < height - 8; y += step) for (let x = 8; x < width - 8; x += step) {
    const source = patch(features[a].gray, width, height, x, y);
    if (!source) continue;
    const best = searchDepth(x, y, poses[a], poses[b], K, source, features[b].gray, intervalA, width, height);
    if (!best) continue;
    const target = patch(features[b].gray, width, height, ...best.uv);
    if (!target) continue;
    const reverse = searchDepth(...best.uv, poses[b], poses[a], K, target, features[a].gray, intervalB, width, height);
    if (!reverse || Math.hypot(reverse.uv[0] - x, reverse.uv[1] - y) > 1.5) continue;
    const p = triangulate([x, y], best.uv, poses[a], poses[b], K, { maxError: 1.5, minAngle: 0.8 });
    if (!p) continue;
    if (third !== undefined) {
      const uv = project(p.xyz, poses[third], K);
      if (!uv || depthOf(p.xyz, poses[third]) <= 0 || scorePatch(source, features[third].gray, width, height, ...uv) < 0.8) continue;
    }
    dense.push({ xyz: p.xyz, color: colorAt(frames[a], [x, y]), error: p.error, observations: third === undefined ? 2 : 3 });
  }
  return dense;
}

export async function reconstructFrames(frames, options, cv, notify = () => {}) {
  if (!Array.isArray(frames) || frames.length < 2) throw new Error('Capture or import at least two overlapping views. Move sideways between views.');
  if (frames.length > 32) throw new Error('This local session supports up to 32 views. Use a shorter sequence.');
  const { width, height } = frames[0];
  if (!width || !height || Math.max(width, height) > 960 || Math.min(width, height) < 96) throw new Error('Use images with a processing size between 96 and 960 pixels per side.');
  for (const f of frames) if (f.width !== width || f.height !== height || !f.rgba || f.rgba.length !== width * height * 4) throw new Error('All views must have the same orientation, dimensions, and camera zoom. Start a new sequence after rotating the device.');
  const fov = clamp(Number(options?.fov) || 60, 25, 110), K = intrinsic(width, height, fov);
  const features = [], poses = Array(frames.length).fill(null), trackMaps = frames.map(() => new Map()), landmarks = [];
  const maxFeatures = clamp(options?.maxFeatures || 1800, 500, 2800);
  const matchingCache = new Map();
  const matchesFor = (a, b) => {
    const key = `${a}:${b}`;
    if (!matchingCache.has(key)) matchingCache.set(key, matchFeatures(cv, features[a], features[b]));
    return matchingCache.get(key);
  };
  let bootstrap;
  try {
    for (let i = 0; i < frames.length; i++) {
      notify({ stage: 'features', progress: 0.04 + i / frames.length * 0.2, message: `Finding real image features · ${i + 1}/${frames.length}` });
      features.push(extractFeatures(cv, frames[i], maxFeatures));
    }
    const usable = features.filter(f => f.points.length >= 45).length;
    if (usable < 2) throw new Error('Too few stable image features. Use bright, even light and a textured object; avoid blank walls, reflections, and blur.');
    const count = Math.min(frames.length, 6), candidates = [];
    for (let gap = 1; gap < count; gap++) for (let a = 0; a + gap < count; a++) candidates.push([a, a + gap]);
    let lastReason = '';
    for (const [a, b] of candidates.slice(0, 12)) {
      notify({ stage: 'matching', progress: 0.26, message: `Solving camera motion · views ${a + 1} and ${b + 1}` });
      const matches = matchesFor(a, b);
      if (matches.length < 32) continue;
      try {
        const pair = estimatePair(matches, K, { maxError: 2.5, minAngle: 0.8, iterations: 1800, seed: 42 });
        if (pair.points.length < 25) continue;
        const candidate = { a, b, pair, score: pair.points.length * Math.min(pair.parallax, 8) };
        if (!bootstrap || candidate.score > bootstrap.score) bootstrap = candidate;
        if (pair.points.length >= 90 && pair.parallax >= 1.5) break;
      } catch (error) { lastReason = error.message; }
    }
    if (!bootstrap) throw new Error(`Could not establish 3D geometry. Keep 70–85% overlap and move the camera sideways, not just rotate. ${lastReason}`.trim());
    const { a, b, pair } = bootstrap;
    poses[a] = identityPose(); poses[b] = { R: pair.R, t: pair.t };
    for (const p of pair.points) {
      const ca = colorAt(frames[a], p.match.a), cb = colorAt(frames[b], p.match.b), index = landmarks.length;
      landmarks.push({ xyz: p.xyz, color: ca.map((v, j) => (v + cb[j]) / 2), error: p.error, observations: 2 });
      trackMaps[a].set(p.match.ia, index); trackMaps[b].set(p.match.ib, index);
    }
    const rejected = [];
    for (let pass = 0; pass < 2; pass++) for (let current = 0; current < frames.length; current++) {
      if (poses[current]) continue;
      notify({ stage: 'reconstructing', progress: 0.3 + (current + pass * frames.length) / (2 * frames.length) * 0.37, message: `Registering view ${current + 1}/${frames.length} against shared 3D landmarks` });
      const references = poses.map((p, i) => p ? i : -1).filter(i => i >= 0).sort((i, j) => Math.abs(i - current) - Math.abs(j - current)).slice(0, 5);
      const proposals = [];
      for (const reference of references) {
        const matches = matchesFor(reference, current), used = new Set(), correspondences = [];
        for (const match of matches) {
          const index = trackMaps[reference].get(match.ia);
          if (index !== undefined && !used.has(index)) { used.add(index); correspondences.push({ xyz: landmarks[index].xyz, pixel: match.b, feature: match.ib, index }); }
        }
        proposals.push({ reference, matches, correspondences });
      }
      proposals.sort((x, y) => y.correspondences.length - x.correspondences.length);
      let registration;
      for (const proposal of proposals.slice(0, 3)) {
        const solved = estimatePose(cv, proposal.correspondences, K);
        if (solved) { registration = { ...proposal, ...solved }; break; }
      }
      if (!registration) { if (pass === 1) rejected.push(current); continue; }
      poses[current] = registration.pose;
      for (const c of registration.accepted) { trackMaps[current].set(c.feature, c.index); landmarks[c.index].observations++; }
      for (const { reference, matches } of proposals) {
        for (const match of matches) {
          if (trackMaps[current].has(match.ib)) continue;
          const known = trackMaps[reference].get(match.ia);
          if (known !== undefined) {
            const xyz = landmarks[known].xyz, p = project(xyz, poses[current], K);
            if (p && depthOf(xyz, poses[current]) > 0 && Math.hypot(p[0] - match.b[0], p[1] - match.b[1]) < 2.5) { trackMaps[current].set(match.ib, known); landmarks[known].observations++; }
            continue;
          }
          const point = triangulate(match.a, match.b, poses[reference], poses[current], K, { maxError: 2.5, minAngle: 0.8 });
          if (!point || landmarks.length >= 50000) continue;
          const index = landmarks.length;
          landmarks.push({ xyz: point.xyz, color: colorAt(frames[current], match.b), error: point.error, observations: 2 });
          trackMaps[reference].set(match.ia, index); trackMaps[current].set(match.ib, index);
        }
      }
    }
    const registered = poses.map((p, i) => p ? i : -1).filter(i => i >= 0), sparseCount = landmarks.length;
    if (options?.dense !== false) {
      const pairs = [];
      for (let i = 0; i < registered.length - 1; i++) pairs.push([registered[i], registered[i + 1]]);
      for (let i = 0; i < Math.min(pairs.length, 10); i++) {
        notify({ stage: 'densifying', progress: 0.7 + i / Math.min(pairs.length, 10) * 0.27, message: `Checking stereo surface samples · ${i + 1}/${Math.min(pairs.length, 10)}` });
        const [ia, ib] = pairs[i], baseline = cameraCenter(poses[ia]).map((v, j) => v - cameraCenter(poses[ib])[j]);
        if (Math.hypot(...baseline) < 0.02) continue;
        const third = registered.find(k => k !== ia && k !== ib && Math.abs(k - ia) <= 3);
        landmarks.push(...densifyPair(ia, ib, features, frames, poses, landmarks.slice(0, sparseCount), K, 3500, third));
      }
    }
    if (landmarks.length < 25) throw new Error('Not enough reliable 3D points survived geometric validation. Capture a new sequence with more texture and sideways motion.');
    const positions = new Float32Array(landmarks.length * 3), colors = new Float32Array(landmarks.length * 3);
    for (let i = 0; i < landmarks.length; i++) { positions.set(landmarks[i].xyz, i * 3); colors.set(landmarks[i].color, i * 3); }
    return {
      positions, colors, cameras: registered.map(frameIndex => ({ ...poses[frameIndex], frameIndex })), units: 'relative',
      stats: { frames: frames.length, registered: registered.length, rejectedFrames: rejected, points: landmarks.length, sparsePoints: sparseCount, stereoPoints: landmarks.length - sparseCount, reprojectionError: median(landmarks.map(l => l.error)), parallax: pair.parallax, fov, width, height, calibration: 'estimated-fov', method: 'multi-view-photogrammetry', surface: 'point-cloud', scale: 'unmeasured' },
    };
  } finally { for (const feature of features) dispose(feature.descriptors); }
}

if (scope) {
  let busy = false;
  scope.onmessage = async ({ data }) => {
    if (busy) { scope.postMessage({ type: 'error', message: 'Reconstruction is already running. Wait or cancel the current session.' }); return; }
    busy = true;
    try {
      scope.postMessage({ type: 'status', stage: 'loading', progress: 0.01, message: 'Loading the local vision engine' });
      const { cv } = await loadCV();
      const apis = Object.fromEntries(['ORB', 'BFMatcher', 'solvePnPRansac', 'Rodrigues', 'matFromArray'].map(name => [name, typeof cv[name] === 'function']));
      if (Object.values(apis).some(value => !value)) throw new Error('This vision engine is missing a required reconstruction interface. Refresh the offline cache and reload.');
      if (data.type === 'init') scope.postMessage({ type: 'ready', apis });
      else if (data.type === 'reconstruct') {
        const model = await reconstructFrames(data.frames, data.options || {}, cv, status => scope.postMessage({ type: 'status', ...status }));
        scope.postMessage({ type: 'result', model }, [model.positions.buffer, model.colors.buffer]);
      }
    } catch (error) { scope.postMessage({ type: 'error', message: error.message || String(error) }); }
    finally { busy = false; }
  };
}
