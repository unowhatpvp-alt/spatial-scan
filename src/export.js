/** Binary glTF / PLY export. Reconstruction colors are sRGB, positions use OpenCV axes. */
const align4 = value => (value + 3) & ~3;
const linear = value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

function normalizedModel(model, scale) {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Export scale must be a finite positive number.');
  const input = model?.positions;
  if (!input || input.length < 3 || input.length % 3 !== 0) throw new Error('A model needs complete XYZ vertices.');
  const count = input.length / 3;
  const positions = new Float32Array(input.length);
  const colors = new Float32Array(input.length);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  if (model.colors && model.colors.length !== input.length) throw new Error('Vertex colors must match the position count.');
  for (let i = 0; i < input.length; i++) {
    const value = Number(input[i]) * scale;
    if (!Number.isFinite(value)) throw new Error('Model contains a non-finite position.');
    positions[i] = value;
    if (!Number.isFinite(positions[i])) throw new Error('Position exceeds the GLB floating-point range.');
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
    const color = model.colors ? Number(model.colors[i]) : 0.75;
    if (!Number.isFinite(color)) throw new Error('Model contains a non-finite color.');
    colors[i] = Math.max(0, Math.min(1, color));
  }
  let indices = null;
  if (model.indices?.length) {
    if (model.indices.length % 3 !== 0) throw new Error('Surface indices must form complete triangles.');
    indices = new Uint32Array(model.indices.length);
    for (let i = 0; i < indices.length; i++) {
      const index = Number(model.indices[i]);
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Surface index is outside the vertex range.');
      indices[i] = index;
    }
  }
  return { positions, colors, indices, count, min, max };
}

/** Produce a self-contained glTF 2.0 GLB. POINTS unless valid surface indices are present. */
export function toGLB(model, scale = 1) {
  const { positions, colors, indices, count, min, max } = normalizedModel(model, scale);
  const positionBytes = positions.byteLength;
  const colorBytes = colors.byteLength;
  const indexBytes = indices?.byteLength || 0;
  const binary = new ArrayBuffer(positionBytes + colorBytes + indexBytes);
  const binaryView = new DataView(binary);
  for (let i = 0; i < positions.length; i++) {
    binaryView.setFloat32(i * 4, positions[i], true);
    binaryView.setFloat32(positionBytes + i * 4, linear(colors[i]), true);
  }
  if (indices) for (let i = 0; i < indices.length; i++) binaryView.setUint32(positionBytes + colorBytes + i * 4, indices[i], true);
  const bufferViews = [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34962 },
    { buffer: 0, byteOffset: positionBytes, byteLength: colorBytes, target: 34962 },
  ];
  const accessors = [
    { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
  ];
  const primitive = { attributes: { POSITION: 0, COLOR_0: 1 }, material: 0, mode: indices ? 4 : 0 };
  if (indices) {
    bufferViews.push({ buffer: 0, byteOffset: positionBytes + colorBytes, byteLength: indexBytes, target: 34963 });
    accessors.push({ bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' });
    primitive.indices = 2;
  }
  const json = {
    asset: { version: '2.0', generator: 'Spatial Scan' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // A rotation around X converts OpenCV's Y-down / Z-forward coordinates to glTF's Y-up.
    nodes: [{ name: 'Reconstruction', mesh: 0, rotation: [1, 0, 0, 0] }],
    meshes: [{ name: indices ? 'Reconstructed surface' : 'Reconstructed points', primitives: [primitive] }],
    materials: [{ name: 'Vertex colors', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, extensions: { KHR_materials_unlit: {} } }],
    extensionsUsed: ['KHR_materials_unlit'],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
    extras: { reconstruction: 'multi-view triangulation', units: scale === 1 ? 'relative' : 'user-scaled', exportScale: scale },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(encoded.byteLength);
  const binaryLength = align4(binary.byteLength);
  const output = new ArrayBuffer(12 + 8 + jsonLength + 8 + binaryLength);
  const header = new DataView(output);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, output.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(output, 20, jsonLength).fill(0x20);
  new Uint8Array(output, 20, encoded.byteLength).set(encoded);
  const binOffset = 20 + jsonLength;
  header.setUint32(binOffset, binaryLength, true);
  header.setUint32(binOffset + 4, 0x004e4942, true);
  new Uint8Array(output, binOffset + 8, binary.byteLength).set(new Uint8Array(binary));
  return output;
}

/** ASCII PLY preserves sRGB colors and writes the same upright coordinate frame as the GLB. */
export function toPLY(model, scale = 1) {
  const { positions, colors, indices, count } = normalizedModel(model, scale);
  const lines = ['ply', 'format ascii 1.0', 'comment Spatial Scan: multi-view reconstruction', 'comment coordinates: Y-up, relative scale unless user-scaled', `element vertex ${count}`, 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue'];
  if (indices) lines.push(`element face ${indices.length / 3}`, 'property list uchar uint vertex_indices');
  lines.push('end_header');
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(`${positions[i]} ${-positions[i + 1]} ${-positions[i + 2]} ${Math.round(colors[i] * 255)} ${Math.round(colors[i + 1] * 255)} ${Math.round(colors[i + 2] * 255)}`);
  }
  if (indices) for (let i = 0; i < indices.length; i += 3) lines.push(`3 ${indices[i]} ${indices[i + 1]} ${indices[i + 2]}`);
  return lines.join('\n') + '\n';
}

/** Trigger a normal local download without contacting a server. */
export function downloadFile(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari may not have started reading the object URL at the end of the click handler.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}