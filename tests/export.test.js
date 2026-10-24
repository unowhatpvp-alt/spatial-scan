import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toGLB, toPLY } from '../src/export.js';

const fixture = () => ({
  positions: new Float32Array([-1, 2, 3, 4, -5, 6, 0.5, 0.25, -2]),
  colors: new Float32Array([1, 0, 0, 0, 1, 0, 0.5, 0.25, 0.75]),
  units: 'relative',
});
function unpack(buffer) {
  const view = new DataView(buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), buffer.byteLength);
  const jsonLength = view.getUint32(12, true);
  assert.equal(jsonLength % 4, 0);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  const offset = 20 + jsonLength;
  assert.equal(view.getUint32(offset + 4, true), 0x004e4942);
  assert.equal(offset + 8 + view.getUint32(offset, true), buffer.byteLength);
  return { json, binary: new DataView(buffer, offset + 8) };
}

test('GLB encodes actual scaled XYZ and linear vertex colors in aligned buffers', () => {
  const { json, binary } = unpack(toGLB(fixture(), 2));
  assert.equal(json.meshes[0].primitives[0].mode, 0);
  assert.equal(json.accessors[0].count, 3);
  assert.deepEqual(json.accessors[0].min, [-2, -10, -4]);
  assert.deepEqual(json.accessors[0].max, [8, 4, 12]);
  assert.equal(binary.getFloat32(0, true), -2);
  assert.equal(binary.getFloat32(4, true), 4);
  assert.equal(binary.getFloat32(8, true), 6);
  const colorOffset = json.bufferViews[1].byteOffset;
  assert.equal(binary.getFloat32(colorOffset, true), 1);
  assert.equal(binary.getFloat32(colorOffset + 4, true), 0);
  assert.ok(Math.abs(binary.getFloat32(colorOffset + 6 * 4, true) - 0.21404114) < 1e-6);
  assert.equal(json.buffers[0].byteLength, 72);
  assert.deepEqual(json.nodes[0].rotation, [1, 0, 0, 0]);
});

test('independent Three.js GLTFLoader reads a genuine point primitive', async () => {
  const decoded = await new GLTFLoader().parseAsync(toGLB(fixture()), '');
  let points;
  decoded.scene.traverse(object => { if (object.isPoints) points = object; });
  assert.ok(points, 'The exported asset must load as a Points object.');
  assert.equal(points.geometry.getAttribute('position').count, 3);
  assert.equal(points.geometry.getAttribute('color').count, 3);
  assert.equal(points.geometry.getAttribute('position').getZ(2), -2);
  assert.equal(points.geometry.index, null);
  decoded.scene.updateMatrixWorld(true);
  assert.equal(points.matrixWorld.elements[5], -1);
  assert.equal(points.matrixWorld.elements[10], -1);
  points.geometry.dispose();
  points.material.dispose();
});

test('GLB uses indexed triangles only when the model supplies valid faces', async () => {
  const model = { ...fixture(), indices: new Uint32Array([0, 1, 2]) };
  const buffer = toGLB(model);
  const { json, binary } = unpack(buffer);
  const primitive = json.meshes[0].primitives[0];
  assert.equal(primitive.mode, 4);
  assert.equal(json.accessors[primitive.indices].count, 3);
  assert.equal(json.accessors[primitive.indices].componentType, 5125);
  const indicesOffset = json.bufferViews[2].byteOffset;
  assert.deepEqual([0, 1, 2].map(i => binary.getUint32(indicesOffset + i * 4, true)), [0, 1, 2]);
  const loaded = await new GLTFLoader().parseAsync(buffer, '');
  let mesh;
  loaded.scene.traverse(object => { if (object.isMesh) mesh = object; });
  assert.ok(mesh);
  assert.equal(mesh.geometry.index.count, 3);
  assert.equal(mesh.geometry.getAttribute('position').count, 3);
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('PLY preserves colors, triangle indices and GLB orientation', () => {
  const result = toPLY({ ...fixture(), indices: [0, 1, 2] }, 2);
  assert.match(result, /element vertex 3\n/);
  assert.match(result, /element face 1\n/);
  assert.match(result, /end_header\n-2 -4 -6 255 0 0\n/);
  assert.ok(result.endsWith('3 0 1 2\n'));
  assert.match(result, /1 -0.5 4 128 64 191\n/);
});

test('malformed or non-finite geometry is rejected before export', () => {
  for (const exportModel of [toGLB, toPLY]) {
    assert.throws(() => exportModel({ positions: [] }), /XYZ/);
    assert.throws(() => exportModel({ positions: [0, 1] }), /XYZ/);
    assert.throws(() => exportModel({ positions: [0, Infinity, 1] }), /non-finite/);
    assert.throws(() => exportModel({ positions: [0, NaN, 1] }), /non-finite/);
    assert.throws(() => exportModel({ positions: [0, 1e50, 1] }), /floating-point/);
    assert.throws(() => exportModel({ ...fixture(), colors: [1, 1, 1] }), /match/);
    assert.throws(() => exportModel({ ...fixture(), colors: [NaN, 0, 0, 0, 0, 0, 0, 0, 0] }), /non-finite color/);
    assert.throws(() => exportModel({ ...fixture(), indices: [0, 1, 3] }), /outside/);
    assert.throws(() => exportModel({ ...fixture(), indices: [0, 1] }), /complete triangles/);
    assert.throws(() => exportModel(fixture(), -1), /positive/);
  }
});