# Contributing

Useful contributions improve real reconstruction, browser stability, accessibility, or the evidence behind compatibility claims.

Use Node.js 22+ and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm dev
```

The server serves the built `dist/` directory at `http://127.0.0.1:4173`; rebuild and reload after edits.

Keep changes focused. Add a meaningful regression when changing geometry, pose estimation, matching, or export. UI-only edits should include a short account of browser and viewport checks. Do not commit `dist/`, dependencies, captured images, private scans, or generated validation assets.

Reconstruction changes must retain genuine multiview evidence. Reject unsupported inputs instead of substituting canned geometry or treating monocular depth as accurate scanning. Preserve on-device processing and same-origin runtime assets; adding telemetry, uploads, or external inference changes the project's privacy contract.

For a bug report, include browser/OS, device class, input dimensions and view count, the visible error, and reproduction steps. Share images only if you have the right to make them public, and remove private content first. A small openly licensed test fixture is preferable to a large capture archive.

For pull requests, explain the trigger, resulting behavior, validation performed, and remaining limits. Do not claim iPhone, room-scale, metric, or Blender compatibility based only on synthetic tests. Keep the English and Chinese READMEs aligned when changing user-visible behavior.
