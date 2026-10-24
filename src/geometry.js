import { Matrix, EigenvalueDecomposition, SingularValueDecomposition } from 'ml-matrix';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const DEG = 180 / Math.PI;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.hypot(...a);
const unit = (a) => { const n = norm(a); return a.map((v) => v / n); };
const mv = (m, v) => [dot(m.slice(0, 3), v), dot(m.slice(3, 6), v), dot(m.slice(6, 9), v)];
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const multiply = (a, b) => { const bt = transpose(b); return Array.from({ length: 9 }, (_, i) => dot(a.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3), bt.slice((i % 3) * 3, (i % 3) * 3 + 3))); };
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const n = sorted.length; return n ? (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2 : 0; };

export function identityPose() { return { R: [...I], t: [0, 0, 0] }; }
export function cameraCenter(pose) { return mv(transpose(pose.R), pose.t).map((v) => -v); }
export function project(xyz, pose, K) {
  const p = mv(pose.R, xyz).map((v, i) => v + pose.t[i]);
  return [K.fx * p[0] / p[2] + K.cx, K.fy * p[1] / p[2] + K.cy];
}

/** Intersect two calibrated viewing rays. Coordinates use world -> camera R,t. */
export function triangulate(a, b, poseA, poseB, K, options = {}) {
  const maxError = options.maxError ?? 3;
  const minAngle = options.minAngle ?? 0.5;
  const ca = cameraCenter(poseA), cb = cameraCenter(poseB);
  const da = unit(mv(transpose(poseA.R), [(a[0] - K.cx) / K.fx, (a[1] - K.cy) / K.fy, 1]));
  const db = unit(mv(transpose(poseB.R), [(b[0] - K.cx) / K.fx, (b[1] - K.cy) / K.fy, 1]));
  const cosine = Math.max(-1, Math.min(1, dot(da, db)));
  const angle = Math.acos(cosine) * DEG;
  if (angle < minAngle || angle > 90 || !Number.isFinite(angle)) return null;
  const denom = 1 - cosine * cosine;
  if (denom < 1e-12) return null;
  const w = sub(ca, cb), d = dot(da, w), e = dot(db, w);
  const sa = (cosine * e - d) / denom, sb = (e - cosine * d) / denom;
  if (!(sa > 0 && sb > 0)) return null;
  const xyz = ca.map((v, i) => (v + sa * da[i] + cb[i] + sb * db[i]) / 2);
  if (!xyz.every(Number.isFinite)) return null;
  const za = mv(poseA.R, xyz)[2] + poseA.t[2], zb = mv(poseB.R, xyz)[2] + poseB.t[2];
  if (za <= 1e-6 || zb <= 1e-6) return null;
  const pa = project(xyz, poseA, K), pb = project(xyz, poseB, K);
  const ea = Math.hypot(pa[0] - a[0], pa[1] - a[1]), eb = Math.hypot(pb[0] - b[0], pb[1] - b[1]);
  if (!Number.isFinite(ea + eb) || Math.max(ea, eb) > maxError) return null;
  return { xyz, error: Math.hypot(ea, eb) / Math.SQRT2, angle };
}

function validateK(K) {
  if (!K || ![K.fx, K.fy, K.cx, K.cy].every(Number.isFinite) || K.fx <= 0 || K.fy <= 0) {
    throw new Error('Invalid camera intrinsics. Set a positive focal length and retry.');
  }
}

function normalized(points) {
  const n = points.length;
  const cx = points.reduce((sum, p) => sum + p[0], 0) / n;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / n;
  const distance = points.reduce((sum, p) => sum + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  if (distance < 1e-8) throw new Error('Degenerate feature distribution.');
  const s = Math.SQRT2 / distance;
  return { points: points.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s]), T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] };
}

function svd3(values) {
  const result = new SingularValueDecomposition(new Matrix([values.slice(0, 3), values.slice(3, 6), values.slice(6, 9)]));
  const U = result.leftSingularVectors.to1DArray();
  const V = result.rightSingularVectors.to1DArray();
  return { U, V, s: result.diagonal };
}

function constrainRank2(values) {
  const { U, V, s } = svd3(values);
  return multiply(multiply(U, [s[0], 0, 0, 0, s[1], 0, 0, 0, 0]), transpose(V));
}

function constrainEssential(values) {
  const { U, V, s } = svd3(values);
  const average = (s[0] + s[1]) / 2;
  if (average < 1e-12) throw new Error('Degenerate epipolar geometry.');
  return multiply(multiply(U, [average, 0, 0, 0, average, 0, 0, 0, 0]), transpose(V));
}

/** Hartley-normalized eight-point fit in calibrated camera coordinates. */
function fitEssential(pairs) {
  const a = normalized(pairs.map((p) => p.a)), b = normalized(pairs.map((p) => p.b));
  const ata = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (let k = 0; k < pairs.length; k++) {
    const [x, y] = a.points[k], [u, v] = b.points[k];
    const row = [u * x, u * y, u, v * x, v * y, v, x, y, 1];
    for (let i = 0; i < 9; i++) for (let j = i; j < 9; j++) ata[i][j] += row[i] * row[j];
  }
  for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) ata[i][j] = ata[j][i];
  const evd = new EigenvalueDecomposition(new Matrix(ata), { assumeSymmetric: true });
  const eigenvalues = evd.realEigenvalues;
  const order = Array.from({ length: 9 }, (_, i) => i).sort((i, j) => eigenvalues[i] - eigenvalues[j]);
  // A second null direction indicates planar, collinear or otherwise ambiguous data.
  if (Math.abs(eigenvalues[order[1]]) < 1e-10) throw new Error('Ambiguous feature geometry.');
  const f = evd.eigenvectorMatrix.getColumn(order[0]);
  const E = multiply(multiply(transpose(b.T), constrainRank2(f)), a.T);
  const magnitude = Math.hypot(...E);
  return E.map((v) => v / magnitude);
}

function sampsonSquared(E, p, K) {
  const x = [...p.a, 1], y = [...p.b, 1];
  const ex = mv(E, x), ety = mv(transpose(E), y);
  const residual = dot(y, ex);
  const denominator = (ex[0] * ex[0] + ety[0] * ety[0]) / (K.fx * K.fx)
    + (ex[1] * ex[1] + ety[1] * ety[1]) / (K.fy * K.fy);
  return denominator > 1e-20 ? residual * residual / denominator : Infinity;
}

function signedSampson(E, p, K) {
  const x = [...p.a, 1], y = [...p.b, 1];
  const ex = mv(E, x), ety = mv(transpose(E), y);
  const denominator = (ex[0] * ex[0] + ety[0] * ety[0]) / (K.fx * K.fx)
    + (ex[1] * ex[1] + ety[1] * ety[1]) / (K.fy * K.fy);
  return dot(y, ex) / Math.sqrt(Math.max(1e-20, denominator));
}

function rotationIncrement(v) {
  const angle = norm(v);
  if (angle < 1e-16) return [...I];
  const [x, y, z] = v.map((n) => n / angle), c = Math.cos(angle), s = Math.sin(angle), d = 1 - c;
  return [c + x * x * d, x * y * d - z * s, x * z * d + y * s,
    y * x * d + z * s, c + y * y * d, y * z * d - x * s,
    z * x * d - y * s, z * y * d + x * s, c + z * z * d];
}
function essentialFromPose(pose) {
  const [x, y, z] = pose.t;
  return multiply([0, -z, y, z, 0, -x, -y, x, 0], pose.R);
}
function incrementPose(pose, step) {
  return { R: multiply(rotationIncrement(step.slice(0, 3)), pose.R), t: unit(pose.t.map((v, i) => v + step[i + 3])) };
}
function solveSmall(A, b) {
  const a = A.map((row, i) => [...row, b[i]]), n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-16) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const scale = a[c][c];
    for (let j = c; j <= n; j++) a[c][j] /= scale;
    for (let r = 0; r < n; r++) if (r !== c) {
      const factor = a[r][c];
      for (let j = c; j <= n; j++) a[r][j] -= factor * a[c][j];
    }
  }
  return a.map((row) => row[n]);
}

// Refine on the essential manifold, rather than leaving linear fitting bias in R,t.
function refineEpipolar(E, pairs, K, threshold) {
  let pose = decompose(E)[0], lambda = 1e-3;
  const cost = (residuals) => residuals.reduce((sum, r) => {
    const a = Math.abs(r); return sum + (a < threshold ? a * a : 2 * threshold * a - threshold * threshold);
  }, 0);
  let residuals = pairs.map((p) => signedSampson(essentialFromPose(pose), p, K));
  let value = cost(residuals);
  for (let iteration = 0; iteration < 15; iteration++) {
    const epsilon = 1e-6;
    const columns = Array.from({ length: 6 }, (_, k) => {
      const step = Array(6).fill(0); step[k] = epsilon;
      const perturbed = essentialFromPose(incrementPose(pose, step));
      return pairs.map((p, i) => (signedSampson(perturbed, p, K) - residuals[i]) / epsilon);
    });
    const h = Array.from({ length: 6 }, () => Array(6).fill(0)), g = Array(6).fill(0);
    for (let i = 0; i < pairs.length; i++) {
      const weight = Math.min(1, threshold / Math.max(1e-10, Math.abs(residuals[i])));
      for (let j = 0; j < 6; j++) {
        g[j] += columns[j][i] * residuals[i] * weight;
        for (let k = j; k < 6; k++) h[j][k] += columns[j][i] * columns[k][i] * weight;
      }
    }
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < j; k++) h[j][k] = h[k][j];
      h[j][j] += lambda * Math.max(h[j][j], 1);
    }
    const step = solveSmall(h, g.map((v) => -v));
    if (!step || !step.every(Number.isFinite)) break;
    const candidate = incrementPose(pose, step), nextE = essentialFromPose(candidate);
    const nextResiduals = pairs.map((p) => signedSampson(nextE, p, K)), nextValue = cost(nextResiduals);
    if (nextValue < value) {
      pose = candidate; residuals = nextResiduals; value = nextValue; lambda = Math.max(1e-8, lambda / 3);
      if (Math.hypot(...step) < 1e-7) break;
    } else { lambda *= 10; }
  }
  return essentialFromPose(pose);
}
function rng(seed) {
  let x = seed >>> 0 || 0x6d2b79f5;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

function sampleEight(count, random) {
  const indices = new Set();
  while (indices.size < 8) indices.add(Math.floor(random() * count));
  return [...indices];
}

function decompose(E) {
  const { U, V } = svd3(E);
  if (det(U) < 0) for (const i of [2, 5, 8]) U[i] *= -1;
  if (det(V) < 0) for (const i of [2, 5, 8]) V[i] *= -1;
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const R1 = multiply(multiply(U, W), transpose(V));
  const R2 = multiply(multiply(U, transpose(W)), transpose(V));
  const t = unit([U[2], U[5], U[8]]);
  return [{ R: R1, t }, { R: R1, t: t.map((v) => -v) }, { R: R2, t }, { R: R2, t: t.map((v) => -v) }];
}

/**
 * Recover a metric-up-to-scale bootstrap from overlapping photographs.
 * Matches are {a:[x,y], b:[x,y], ia, ib}; returned records retain their objects.
 */
export function estimatePair(matches, K, options = {}) {
  validateK(K);
  if (!Array.isArray(matches) || matches.length < 16) {
    throw new Error('Too few matching features. Capture overlapping views of a textured, stationary scene.');
  }
  const valid = matches.filter((m) => m.a?.length === 2 && m.b?.length === 2 && [...m.a, ...m.b].every(Number.isFinite));
  if (valid.length < 16) throw new Error('Too few valid feature matches.');
  const maxError = options.maxError ?? 2.5;
  const minAngle = options.minAngle ?? 0.8;
  const pairs = valid.map((match) => ({ a: [(match.a[0] - K.cx) / K.fx, (match.a[1] - K.cy) / K.fy], b: [(match.b[0] - K.cx) / K.fx, (match.b[1] - K.cy) / K.fy], match }));
  const random = rng(options.seed ?? 0x32ab1f09), thresholdSquared = maxError * maxError;
  let bestE = null, bestIndices = [], bestCost = Infinity;
  let limit = options.iterations ?? 1400;
  for (let iteration = 0; iteration < limit; iteration++) {
    let E;
    try { E = fitEssential(sampleEight(pairs.length, random).map((i) => pairs[i])); } catch { continue; }
    const indices = [];
    let cost = 0;
    for (let i = 0; i < pairs.length; i++) {
      const error = sampsonSquared(E, pairs[i], K);
      cost += Math.min(error, thresholdSquared);
      if (error <= thresholdSquared) indices.push(i);
    }
    if (indices.length > bestIndices.length || (indices.length === bestIndices.length && cost < bestCost)) {
      bestE = E; bestIndices = indices; bestCost = cost;
      const allInlierSample = Math.pow(indices.length / pairs.length, 8);
      if (allInlierSample > 0 && allInlierSample < 1) {
        const needed = Math.ceil(Math.log(0.001) / Math.log(1 - allInlierSample));
        limit = Math.min(limit, Math.max(100, iteration + 1, needed));
      }
    }
  }
  if (!bestE || bestIndices.length < Math.max(16, valid.length * 0.18)) {
    throw new Error('No stable camera motion found. Keep 70–85% overlap and move sideways instead of rotating in place.');
  }
  for (let pass = 0; pass < 3; pass++) {
    try {
      const refined = fitEssential(bestIndices.map((i) => pairs[i]));
      const indices = pairs.flatMap((p, i) => sampsonSquared(refined, p, K) <= thresholdSquared ? [i] : []);
      if (indices.length >= Math.max(16, bestIndices.length * 0.8)) { bestE = refined; bestIndices = indices; }
    } catch { break; }
  }
  bestE = constrainEssential(bestE);
  for (let pass = 0; pass < 2; pass++) {
    const refined = refineEpipolar(bestE, bestIndices.map((i) => pairs[i]), K, maxError);
    const indices = pairs.flatMap((p, i) => sampsonSquared(refined, p, K) <= thresholdSquared ? [i] : []);
    if (indices.length >= Math.max(16, bestIndices.length * 0.8)) { bestE = refined; bestIndices = indices; }
  }
  const first = identityPose();
  let best = null;
  for (const pose of decompose(bestE)) {
    const points = [];
    for (const i of bestIndices) {
      const match = pairs[i].match;
      const point = triangulate(match.a, match.b, first, pose, K, { maxError, minAngle });
      if (point) points.push({ ...point, match });
    }
    if (!best || points.length > best.points.length) best = { ...pose, points };
  }
  const needed = Math.max(16, Math.ceil(bestIndices.length * 0.55));
  if (!best || best.points.length < needed) {
    throw new Error('Insufficient translation or ambiguous geometry. Move sideways around a textured subject with visible depth.');
  }
  const parallax = median(best.points.map((p) => p.angle));
  if (parallax < (options.minParallax ?? Math.max(1, minAngle))) {
    throw new Error('Parallax is too small. Move the camera sideways farther; avoid turning from one fixed position.');
  }
  return { R: best.R, t: best.t, points: best.points, inliers: best.points.map((p) => p.match), error: median(best.points.map((p) => p.error)), parallax };
}