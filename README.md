# SpaceBoard PC — Interactive 3D Workspace Booking & Multi-Floor Wayfinding Kiosk

An interactive 3D workspace booking and multi-floor wayfinding kiosk built with **Angular 22** (standalone `OnPush` components & Signals) and **Three.js (r187)**, featuring Azure AD OAuth 2.0 + OpenID Connect, Microsoft Graph Outlook room booking, configurable local database / demo login, and zero-rebuild floor plan deployment.

---

## Quick Start

```bash
# Start the local development server at http://localhost:4200
npm start

# Build for production (relative base URL `./`, outputs to dist/kiosk3d/browser/)
npm run build
```

Try kiosk starting-position URLs locally:
- `http://localhost:4200/?kioskId=l12-1` (Level 12 Lobby)
- `http://localhost:4200/?kioskId=l13-1` (Level 13 North)
- `http://localhost:4200/?kioskId=l13-2` (Level 13 South)

---

## Architecture & Separation of Concerns

The codebase is organized by domain and UI responsibility:

```text
src/app/
├── app.ts / app.html / app.scss         # Thin root shell: bootstrap, Three.js lifecycle, toast & idle timer
├── kiosk.store.ts                       # Signals-based state store (floors, resources, filters, bookings, routes)
├── components/                          # Standalone OnPush UI components
│   ├── auth-gate/                       # Sign-in modal (Local DB / Demo login + Microsoft Entra ID redirect)
│   ├── top-bar/                         # Brand pill, Kiosk/Floor/Date/Time quick filters, User pill, Clock
│   ├── sidebar/                         # Collapsible Search & Booking filters, Wayfinding planner & Directory
│   ├── resource-inspector/              # Right detail drawer, 07:00–19:00 timeline, upcoming & full-day schedule
│   ├── booking-modal/                   # Create/Edit reservation modal with optional Microsoft Graph Outlook sync
│   ├── glb-analyzer/                    # In-browser drag-and-drop GLB analyzer & live 3D preview modal
│   └── map-controls/                    # Bottom-right Status Legend, Floor Switcher, 3D/2D, Cutaway, Analyze & Reset
├── auth/                                # Authentication & calendar integrations
│   ├── azure-auth.service.ts            # Unified Auth: MSAL PKCE redirect + silent revalidation + Local/Demo auth
│   └── outlook-calendar.service.ts      # Microsoft Graph Calendar API (create, update, cancel room events)
├── three/                               # Pure Three.js 3D rendering layer (no Angular UI coupling)
│   ├── floorplan-engine.ts              # Multi-floor GLTF+Meshopt loader, picking, badges, 2D/3D camera, cutaway
│   ├── floorplan-cache.ts               # CacheStorage with automatic HTTP HEAD (ETag/Last-Modified) revalidation
│   ├── route-visual.ts                  # Animated GLSL chevron route ribbon, walker puck & destination pin
│   └── three-nav-input.ts               # Pointer/touch pan, orbit, and pinch-zoom input helpers
├── wayfinding/                          # Pure TypeScript geometry & pathfinding domain (runs in browser & Node CLI)
│   ├── kiosk-config.ts                  # Runtime loader for `public/data/kiosk-config.json` (floors, kiosks, auth)
│   ├── resource-config.ts               # Regex rules (`RESOURCE_RULES`) mapping GLB node names to resources
│   ├── models.ts                        # Shared TypeScript interfaces (`KioskResource`, `Reservation`, `Route`)
│   ├── nav-grid.ts                      # 2D occupancy grid, doorway slicing, chamfer distance transform, A* + LOS
│   └── wayfinder.ts                     # Single- & multi-floor lift-transfer routing + landmark turn instructions
└── shared/
    └── formatters.ts                    # Pure formatting & color helpers (time, date, distance, duration, icons)
```

### Runtime Configuration (Client-Agnostic, Zero-Rebuild)
- **[public/data/kiosk-config.json](public/data/kiosk-config.json)** — Client branding (`branding`), configurable bookable/non-bookable resource types (`resourceTypes`: `MeetingRoom`, `PrivateRoom`, `FocusRoom`, `PhoneBooth`, `HuddleRoom`, `Desk`, etc.), floors (`floors`), physical kiosk terminals (`kioskDevices`), Azure AD OAuth 2.0 settings (`auth`), and local user database API / demo login settings (`auth.local`).
- **[public/data/spaceboard-data.json](public/data/spaceboard-data.json)** — Resource catalog metadata (including optional `exchangeId` for Outlook room mailboxes) and seed reservations.
- **[public/models/](public/models/)** — Optimized Meshopt `.glb` floor plans (`floorplan.glb`, `l13-floorplan.glb`, etc.).

---

## Onboarding a New Client / Updating 3D Floor Plans

```bash
# Analyze any GLB file against your configured resourceTypes (prints summary + starter JSON)
npm run analyze-glb -- public/models/floorplan.glb

# Rebuild Level 12 + Level 13 GLBs
npm run optimize-model

# Rebuild Level 12 only (from assets/l12/)
npm run optimize-l12

# Rebuild Level 13 only (assembles divided GLBs from assets/l13/)
npm run optimize-l13

# Assemble a brand-new divided floor (e.g. Level 14)
NODE_OPTIONS='--max-old-space-size=8192' npx tsx scripts/assemble-floorplan.ts assets/l14 public/models/l14-floorplan.glb

# Verify navigation grid reachability without opening a browser
npx tsx scripts/nav-debug.ts /tmp/nav-l13.png public/models/l13-floorplan.glb WAYFINDING_KIOSK_L13_1
```

You can also click **Analyze GLB** in the bottom-right map controls bar to drag-and-drop any `.glb` file directly in the browser, inspect matched bookable resources, copy starter JSON, and preview it live in the 3D viewport.

For full technical specifications, wayfinding algorithm details, Azure AD setup, and production deployment instructions, see **[kiosk_specifications_and_guide.md](kiosk_specifications_and_guide.md)**.
