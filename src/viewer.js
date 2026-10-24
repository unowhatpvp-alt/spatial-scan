import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const srgbToLinear = value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

/** On-demand rendering keeps the viewer idle when the user is not interacting. */
export function createViewer(container) {
  let renderer;
  let modelRoot = null;
  let pointObject = null;
  let meshObject = null;
  let grid = null;
  let frame = 0;
  let contextAvailable = true;
  let disposed = false;
  let mode = 'points';
  let theme = 'light';
  let pointSize = 1;
  let radius = 1;
  let center = new THREE.Vector3();
  container.style.position ||= 'relative';
  const status = document.createElement('div');
  status.className = 'viewer-message';
  status.setAttribute('role', 'status');
  Object.assign(status.style, { position: 'absolute', inset: '0', display: 'none', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '32px', fontSize: '14px', lineHeight: '1.7', pointerEvents: 'none', zIndex: '2' });
  container.append(status);
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  } catch {
    status.style.display = 'flex';
    status.textContent = '3D preview is unavailable on this browser. Your reconstruction can still be saved and exported.';
    return {
      setModel() {}, clear() {}, reset() {}, setTheme(next) { status.style.color = next === 'dark' ? '#e8e9e6' : '#333631'; },
      setPointSize() {}, setMode() {}, getCanvas() { return null; }, dispose() { status.remove(); },
    };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D reconstruction. Drag to orbit, pinch or scroll to zoom. Arrow keys pan.');
  container.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  camera.position.set(1.8, 1.2, 3);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.listenToKeyEvents(renderer.domElement);

  function renderNow() {
    frame = 0;
    if (!disposed && contextAvailable) renderer.render(scene, camera);
  }
  function render() {
    if (!frame && !disposed && contextAvailable) frame = requestAnimationFrame(renderNow);
  }
  controls.addEventListener('change', render);
  const focus = () => renderer.domElement.focus({ preventScroll: true });
  renderer.domElement.addEventListener('pointerdown', focus);
  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function disposeObject(object) {
    object?.traverse(child => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
      else child.material?.dispose();
    });
    object?.removeFromParent();
  }
  function clear() {
    disposeObject(modelRoot);
    disposeObject(grid);
    modelRoot = pointObject = meshObject = grid = null;
    if (contextAvailable) status.style.display = 'none';
    radius = 1;
    center = new THREE.Vector3();
    render();
  }
  function reset() {
    if (disposed) return;
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.15;
    const direction = new THREE.Vector3(0.9, 0.45, 1.65).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(radius / 1000, 0.000001);
    camera.far = Math.max(radius * 100, camera.near * 1000);
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.015;
    controls.maxDistance = radius * 40;
    controls.target.copy(center);
    controls.update();
    render();
  }
  function setTheme(next) {
    theme = next === 'dark' ? 'dark' : 'light';
    scene.background = new THREE.Color(theme === 'dark' ? '#141715' : '#f0f1ed');
    status.style.color = theme === 'dark' ? '#e8e9e6' : '#333631';
    if (grid) {
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      materials.forEach(material => { material.color.set(theme === 'dark' ? '#d6ddd7' : '#303832'); });
    }
    render();
  }
  function setPointSize(next) {
    const parsed = Number(next);
    pointSize = Number.isFinite(parsed) ? Math.max(0.25, Math.min(8, parsed)) : 1;
    if (pointObject) pointObject.material.size = radius * 0.012 * pointSize;
    render();
  }
  function setMode(next) {
    mode = next === 'surface' ? 'surface' : 'points';
    if (pointObject) pointObject.visible = mode !== 'surface' || !meshObject;
    if (meshObject) meshObject.visible = mode === 'surface';
    render();
  }
  function setModel(model) {
    clear();
    if (!model?.positions?.length || model.positions.length % 3) return;
    const positions = new Float32Array(model.positions);
    if (!positions.every(Number.isFinite)) {
      status.textContent = 'This reconstruction contains invalid points and cannot be previewed.';
      status.style.display = 'flex';
      return;
    }
    if (contextAvailable) status.style.display = 'none';
    const colors = new Float32Array(positions.length);
    for (let i = 0; i < colors.length; i++) {
      const color = model.colors?.[i];
      colors[i] = srgbToLinear(Number.isFinite(color) ? Math.max(0, Math.min(1, color)) : 0.75);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    modelRoot = new THREE.Group();
    modelRoot.rotation.x = Math.PI;
    scene.add(modelRoot);
    pointObject = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, sizeAttenuation: true, vertexColors: true }));
    modelRoot.add(pointObject);
    if (model.indices?.length && model.indices.length % 3 === 0 && model.indices.every(index => Number.isInteger(index) && index >= 0 && index < positions.length / 3)) {
      const surfaceGeometry = geometry.clone();
      surfaceGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(model.indices), 1));
      meshObject = new THREE.Mesh(surfaceGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      modelRoot.add(meshObject);
    }
    modelRoot.updateMatrixWorld(true);
    const box = geometry.boundingBox.clone().applyMatrix4(modelRoot.matrixWorld);
    box.getCenter(center);
    radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.0001);
    grid = new THREE.GridHelper(radius * 3, 12);
    grid.position.set(center.x, box.min.y - radius * 0.03, center.z);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach(material => { material.opacity = 0.13; material.transparent = true; material.depthWrite = false; });
    scene.add(grid);
    setPointSize(pointSize);
    setMode(mode);
    setTheme(theme);
    reset();
  }
  const onLost = event => {
    event.preventDefault();
    contextAvailable = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    status.textContent = '3D preview paused because the graphics context was lost. Export remains available; reload if it does not recover.';
    status.style.display = 'flex';
  };
  const onRestored = () => {
    contextAvailable = true;
    status.style.display = 'none';
    render();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored);
  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    controls.removeEventListener('change', render);
    controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', focus);
    renderer.domElement.removeEventListener('webglcontextlost', onLost);
    renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
    renderer.dispose();
    renderer.domElement.remove();
    status.remove();
  }
  setTheme(theme);
  resize();
  return { setModel, clear, reset, setTheme, setPointSize, setMode, dispose, getCanvas: () => renderer.domElement };
}