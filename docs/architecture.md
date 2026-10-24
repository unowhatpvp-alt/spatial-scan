# Architecture

Spatial Scan is a static browser application. GitHub Pages serves code and the vision runtime; no reconstruction service or application backend is involved.

## Data flow

1. Camera frames or imported photographs are decoded and resized in the browser. A session keeps one orientation, aspect ratio, and camera setting. The lower resource profile uses a 640-pixel processing edge and up to 24 views; the higher profile uses 900 pixels and up to 32 views.
2. A dedicated Web Worker loads the same-origin OpenCV.js build. ORB extraction and bidirectional Hamming matching identify overlapping observations.
3. A bootstrap pair is solved with normalized eight-point RANSAC. Rank constraints, essential-matrix decomposition, motion refinement, cheirality, reprojection error, and parallax checks reject unsupported geometry. Translation initially has arbitrary scale.
4. Additional cameras are registered with PnP RANSAC against existing 3D landmarks. Newly triangulated observations share that coordinate system. Independent, unit-scale pair translations are never simply chained together.
5. Optional densification searches inverse depth using normalized cross-correlation of image patches. It checks match ambiguity, reverse correspondence, geometric reprojection, and an additional registered view when available. These samples remain a point cloud.
6. Three.js renders colored points with WebGL2. Local model storage and downloads remain on the device. GLB contains `POINTS` primitives; PLY contains colored vertices.

The original images remain local. Browser storage is subject to user deletion and eviction; exported files are the durable handoff.

## Intrinsics and scale

The horizontal field of view defaults to an estimated 60°. Processing dimensions determine the focal length and centered principal point. The pipeline does not estimate lens distortion or perform camera calibration. Changing the lens, zoom, orientation, or aspect ratio during capture invalidates this assumption.

Monocular reconstruction determines shape only up to scale. The export multiplier rescales coordinates; it is not a measured distance calibration. No unit label should imply meters without independent calibration.

There is no global bundle adjustment, loop closure, watertight meshing, or confidence guarantee for large rooms. Reprojection error describes consistency of accepted image observations, not physical dimensional accuracy.

## Execution and offline behavior

The preview uses the GPU through WebGL2. Geometry runs in a single-threaded WASM/CPU worker; it does not require SharedArrayBuffer or cross-origin isolation. Camera preview and worker computation use separate execution paths, but memory pressure, heat, browser suspension, and total reconstruction work still limit mobile sessions.

A versioned service worker caches the application shell. The approximately 11 MB OpenCV engine is preloaded in the background after first paint and application-shell caching, or prepared sooner when reconstruction requests it. It is cached from the same origin. **Prepare offline engine** provides a manual preparation or retry action, with visible download status. Cached resources can be reused offline, subject to browser retention. Content changes produce a new cache version.

The app has no neural model, cloud inference, scan upload, or telemetry. Its content security policy restricts network connections and executable resources to its origin. Static hosting still receives normal requests for application assets; external project links are navigations initiated by the visitor.

## Source and build

| Component | Purpose |
| --- | --- |
| `src/main.js` | Capture workflow, local library, worker coordination, export actions |
| `src/reconstruction.worker.js` | Feature extraction, pose registration, stereo sample checks |
| `src/geometry.js` | Robust epipolar geometry and triangulation |
| `src/viewer.js`, `src/export.js` | Interactive view and geometry serialization |
| `public/` | Static interface, styles, manifest, service worker template |
| `scripts/` | Deterministic static build and local server |
| `tests/` | Geometry, actual OpenCV pipeline, and export validation |

Pinned dependencies are OpenCV.js 4.12.0-release.1, ml-matrix 6.15.1, Three.js 0.186.1, and esbuild 0.28.2. The pnpm lockfile resolves transitive dependencies. Build output and dependencies are excluded from Git. The GitHub Actions workflow builds `dist/` and deploys that artifact to Pages.

Project code is MIT licensed. [OpenCV](https://github.com/opencv/opencv/tree/4.12.0) uses Apache-2.0; the [OpenCV.js package](https://github.com/TechStark/opencv-js), [ml-matrix](https://github.com/mljs/matrix), [Three.js](https://github.com/mrdoob/three.js), and [esbuild](https://github.com/evanw/esbuild) retain their upstream licenses. Distribution must preserve applicable third-party notices.
