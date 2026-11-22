# Level 12 Interactive 3D Wayfinding Kiosk

An interactive 3D floor plan and wayfinding kiosk built with **Angular 22** and **Three.js (r187)**.

## Quick Start

```bash
# Start the local development server at http://localhost:4200
npm start

# Build for production (outputs to dist/kiosk3d)
npm run build
```

## Updating the 3D Floor Plan GLB

Whenever `assets/test-floorplan.glb` is updated, re-run the optimizer so `public/models/floorplan.glb` is refreshed with Meshopt compression while preserving all scene node names:

```bash
npm run optimize-model
```

To verify the navigation grid and check that all resources are reachable from `WAYFINDING_KIOSK_L12_1` without opening a browser:

```bash
npx tsx scripts/nav-debug.ts /tmp/nav.ppm
```

## Architecture & Maintainer Guide

- **[src/app/wayfinding/resource-config.ts](src/app/wayfinding/resource-config.ts)** — Regex patterns (`RESOURCE_RULES`) defining which GLB nodes become interactive resources (`MeetingRoom_12_1`..`8`, `Desk_12_001`..`003`, `WAYFINDING_LIFT_12_1`..`2`, `WAYFINDING_KIOSK_L12_1`). All other `furniture_*` nodes are treated strictly as non-clickable decorations and pathfinding obstacles.
- **[src/app/wayfinding/nav-grid.ts](src/app/wayfinding/nav-grid.ts)** — 2D navigation mesh generator: rasterises floor polygons, slices walls horizontally at knee/chest height (`0.35 m` and `1.1 m`) so doorways stay passable, stamps decorative furniture footprints, computes a chamfer distance transform for corridor centering, and runs $A^*$ + line-of-sight string-pulling.
- **[src/app/wayfinding/wayfinder.ts](src/app/wayfinding/wayfinder.ts)** — High-level route planner that snaps resources to walkable anchors, rounds corners, and generates landmark-aware turn-by-turn directions.
- **[src/app/three/floorplan-engine.ts](src/app/three/floorplan-engine.ts)** — Three.js scene controller: GLTF + Meshopt loading, lighting/shadows, resource plates/outlines, CSS2D pill badges, raycast picking, 2D/3D camera transitions, and dollhouse cutaway walls.
- **[src/app/three/route-visual.ts](src/app/three/route-visual.ts)** — Custom GLSL animated chevron route ribbon, walker puck, and pulsing destination pin.
- **[src/app/kiosk.store.ts](src/app/kiosk.store.ts)** — Angular Signals store managing search, category filters, selected resources, and origin/destination routing.
