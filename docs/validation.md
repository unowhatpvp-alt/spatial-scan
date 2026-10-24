# Validation record

This record separates algorithm checks from evidence about actual cameras. Passing a synthetic test does not establish handheld scanning quality.

## Automated checks

Run `pnpm test` to exercise the checked-in tests:

- General-pose triangulation, camera-center conventions, and positive-depth filtering.
- Robust camera-motion and 3D-shape recovery with incorrect feature matches and pixel noise.
- Rejection of pure rotation, zero baseline, blank images, identical textured views, and invalid inputs.
- Actual OpenCV ORB extraction and PnP registration on three rendered, non-planar views. The third camera must preserve the common reconstruction scale.
- Bidirectional stereo matching that adds photometrically checked samples.
- GLB alignment, finite coordinates, colors, point primitive decoding through an independent Three.js loader, and PLY serialization.

A development stress check also recovered 30 translated synthetic scenes and rejected 30 pure-rotation scenes, with 25% incorrect matches and up to 0.75 pixels of coordinate perturbation. A representative noise regression is saved in the test suite. These are numerical and rendered-scene checks, not scans of physical objects.

## Real photograph check

The complete image-to-geometry pipeline was run on OpenCV's public [left Aloe photograph](https://raw.githubusercontent.com/opencv/opencv/4.12.0/samples/data/aloeL.jpg) and [right Aloe photograph](https://raw.githubusercontent.com/opencv/opencv/4.12.0/samples/data/aloeR.jpg).

| Setting or result | Observed |
| --- | --- |
| Input | Two rectified stereo photographs, resized to 640 × 554 |
| Intrinsics | Estimated horizontal FOV of 60° |
| Feature budget | 2,400 per photograph |
| Registered views | 2 of 2 |
| Sparse points | 473 |
| Additional stereo samples | 1,469 |
| Total colored 3D points | 1,942 |
| Median parallax | Approximately 2.78° |
| Reconstruction scale | Relative, unmeasured |

The geometric reprojection residual was near numerical zero on this rectified pair. That measures epipolar consistency; it does **not** demonstrate metric depth accuracy. One desktop Node run took approximately 0.4 seconds for reconstruction after runtime loading and image decoding. This is not a browser or mobile performance benchmark.

The sample photographs and generated model are local validation assets, excluded from the repository. To reproduce the check, decode both linked JPEGs to same-sized RGBA frames and call `reconstructFrames` from `src/reconstruction.worker.js` with `{ fov: 60, maxFeatures: 2400, dense: true }` and the initialized pinned OpenCV runtime.

This controlled stereo pair provides real image evidence for matching, motion estimation, triangulation, and optional stereo sampling. It does not represent arbitrary handheld phone capture.

## Desktop application checks

The actual desktop browser interface was exercised with the same public Aloe photographs, processed at a 900-pixel maximum edge. Both views registered and the result contained **2,164 three-dimensional points**. The downloaded GLB was parsed and contained 2,164 vertices in a glTF `POINTS` primitive (`mode: 0`). No script errors were observed during the tested flow.

Saving to the local model library, reloading the page, and reopening the saved result were verified. The English interface and dark theme were checked at a 390-pixel viewport width without horizontal overflow. This viewport check tests responsive layout; it is not an iPhone hardware test.

## Blender import

A separate GLB exported from the 640-pixel Aloe reconstruction was imported into **Blender 5.2.2 LTS**. The imported object contained **1,942 vertices**, retained vertex color data, and had **zero faces**, matching the exported point-cloud geometry. This verifies that specific point import; it does not establish surface reconstruction or compatibility with every Blender version or external importer.

## Remaining device coverage

Physical iPhone/iPad capture, a real handheld image sequence, and full-room reconstruction have not been verified. Hardware-depth access and closed-surface generation are not implemented.

Before describing a device as verified, record its model, OS/browser version, capture conditions, registered-view count, useful geometric result, export behavior, and failures. Browser interface checks and deployment status are separate from physical scanning quality.

### Cache and cancellation check

After caching the final app shell and OpenCV runtime, the task-owned HTTP preview server was stopped and a separate HTTP request confirmed the origin was unavailable. The browser reloaded the app through its service worker, imported the same public Aloe JPEGs, and reconstructed the same 2,164-point result. Cancellation preserved the two source views, and a subsequent reconstruction succeeded without the server. This verifies cached operation against an unavailable local origin; OS airplane mode and iPhone offline behavior were not tested.