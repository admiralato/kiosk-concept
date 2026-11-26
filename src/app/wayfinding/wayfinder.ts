import { NavGrid, type Vec2 } from './nav-grid';
import type { KioskResource, Route, RouteSegment, RouteStep, TurnKind } from './models';
import type { LiftShaftConfig } from './kiosk-config';

/** Average indoor walking speed in m/s used for the time estimate. */
const WALKING_SPEED = 1.2;

/** Estimated lift wait + vertical travel time in seconds between floors. */
const LIFT_TRANSFER_SECONDS = 25;

/**
 * Computes routes between resources on a single floor's {@link NavGrid} and turns
 * them into human readable turn-by-turn instructions.
 */
export class Wayfinder {
  private readonly byId = new Map<string, KioskResource>();
  private readonly mainComponent: number;

  constructor(
    readonly grid: NavGrid,
    readonly resources: KioskResource[],
    homeId?: string,
  ) {
    for (const r of resources) this.byId.set(r.id, r);
    const home =
      (homeId ? this.byId.get(homeId) : undefined) ??
      resources.find((r) => r.kind === 'kiosk') ??
      resources[0];
    if (!home) throw new Error('Wayfinder: no resources found in floor plan');

    // The walkable region the kiosk stands in is "the floor". Everything that is
    // routable must be reachable from it.
    const homeCell = grid.nearestWalkable(home.center);
    this.mainComponent = homeCell >= 0 ? grid.component[homeCell] : 0;

    for (const r of resources) {
      const region = r.kind === 'meeting-room' ? r.bounds : undefined;
      const cell = grid.nearestWalkable(r.center, this.mainComponent, 8, region);
      r.anchor = cell >= 0 ? grid.centreOf(cell) : null;
    }
  }

  get(id: string): KioskResource | undefined {
    return this.byId.get(id);
  }

  lifts(): KioskResource[] {
    return this.resources.filter((r) => r.kind === 'lift' && r.anchor);
  }

  route(fromId: string, toId: string): Route | null {
    const from = this.byId.get(fromId);
    const to = this.byId.get(toId);
    if (!from?.anchor || !to?.anchor || from === to) return null;
    const a = this.grid.indexOf(from.anchor.x, from.anchor.z);
    const b = this.grid.indexOf(to.anchor.x, to.anchor.z);
    const cells = this.grid.findPath(a, b);
    if (!cells) return null;

    const corners = this.grid.simplify(cells);
    if (corners.length === 1) corners.push({ ...corners[0] });
    const length = polylineLength(corners);
    const smooth = roundCorners(corners, 0.6, 6);
    const steps = this.describe(corners, from, to);
    const segment: RouteSegment = {
      floor: from.floor,
      level: from.level,
      from,
      to,
      corners,
      smooth,
      length,
      seconds: length / WALKING_SPEED,
      steps,
    };
    return {
      from,
      to,
      multiFloor: false,
      segments: [segment],
      corners,
      smooth,
      length,
      seconds: segment.seconds,
      steps,
    };
  }

  /**
   * Computes a multi-floor route from `fromId` on this Wayfinder's floor to `toId`
   * on `targetWayfinder`'s floor via paired lift shafts.
   *
   * Pairing priority:
   * 1. Explicit `liftShafts` configured in `data/kiosk-config.json` (links exact lift IDs across floors).
   * 2. Strict trailing lift-number matching (`_1 ↔ _1`, `_2 ↔ _2`) when no explicit shaft mapping covers
   *    these two floors — never cross-pairing mismatched lifts (e.g. Lift 6 → Lift 1).
   */
  routeMultiFloor(
    fromId: string,
    toId: string,
    targetWayfinder: Wayfinder,
    activeFloor: string,
    liftShafts?: ReadonlyArray<LiftShaftConfig>,
  ): Route | null {
    const from = this.byId.get(fromId);
    const to = targetWayfinder.get(toId);
    if (!from?.anchor || !to?.anchor) return null;

    const originLifts = this.lifts();
    const targetLifts = targetWayfinder.lifts();
    if (!originLifts.length || !targetLifts.length) return null;

    const candidatePairs: Array<{
      origin: KioskResource;
      target: KioskResource;
      shaftLabel?: string;
    }> = [];

    // 1. Try explicit liftShafts from kiosk-config.json first
    if (liftShafts?.length) {
      for (const shaft of liftShafts) {
        const idSet = new Set(shaft.lifts.map((id) => id.trim().toLowerCase()));
        const origMatches = originLifts.filter((l) => idSet.has(l.id.toLowerCase()));
        const targMatches = targetLifts.filter((l) => idSet.has(l.id.toLowerCase()));
        for (const l1 of origMatches) {
          for (const l2 of targMatches) {
            candidatePairs.push({ origin: l1, target: l2, shaftLabel: shaft.label?.trim() });
          }
        }
      }
    }

    // 2. Fallback: strict trailing lift-number matching (e.g. LIFT_12_1 <-> Lifts_L13_1)
    if (!candidatePairs.length) {
      for (const l1 of originLifts) {
        const liftNum = l1.id.split('_').pop()?.toLowerCase();
        if (!liftNum) continue;
        const paired = targetLifts.find((l2) => l2.id.split('_').pop()?.toLowerCase() === liftNum);
        if (paired) {
          candidatePairs.push({ origin: l1, target: paired });
        }
      }
    }

    let bestLeg1: Route | null = null;
    let bestLeg2: Route | null = null;
    let bestLiftOrigin: KioskResource | null = null;
    let bestLiftTarget: KioskResource | null = null;
    let bestShaftLabel: string | undefined;
    let bestTotalDist = Infinity;

    for (const pair of candidatePairs) {
      const leg1 = this.route(from.id, pair.origin.id);
      const leg2 = targetWayfinder.route(pair.target.id, to.id);
      if (!leg1 || !leg2) continue;
      const total = leg1.length + leg2.length;
      if (total < bestTotalDist) {
        bestTotalDist = total;
        bestLeg1 = leg1;
        bestLeg2 = leg2;
        bestLiftOrigin = pair.origin;
        bestLiftTarget = pair.target;
        bestShaftLabel = pair.shaftLabel;
      }
    }

    if (!bestLeg1 || !bestLeg2 || !bestLiftOrigin || !bestLiftTarget) return null;

    const originLiftName = bestShaftLabel || bestLiftOrigin.code;
    const targetLiftName = bestShaftLabel || bestLiftTarget.code;

    // Replace the last 'arrive' step of leg 1 with a 'lift' transfer step
    const leg1Steps: RouteStep[] = bestLeg1.steps.slice(0, -1).map((s) => ({
      ...s,
      floor: from.floor,
    }));
    const transferStep: RouteStep = {
      turn: 'lift',
      text: `Take ${originLiftName} from ${from.floor} to ${to.floor}`,
      distance: 0,
      at: bestLiftOrigin.center,
      floor: from.floor,
    };
    leg1Steps.push(transferStep);

    // Format leg 2 steps starting from the destination floor lift
    const leg2Steps: RouteStep[] = bestLeg2.steps.map((s, idx) => ({
      ...s,
      floor: to.floor,
      text:
        idx === 0
          ? `Exit ${targetLiftName} on ${to.floor}`
          : s.text,
    }));

    const seg1: RouteSegment = {
      floor: from.floor,
      level: from.level,
      from,
      to: bestLiftOrigin,
      corners: bestLeg1.corners,
      smooth: bestLeg1.smooth,
      length: bestLeg1.length,
      seconds: bestLeg1.seconds,
      steps: leg1Steps,
    };

    const seg2: RouteSegment = {
      floor: to.floor,
      level: to.level,
      from: bestLiftTarget,
      to,
      corners: bestLeg2.corners,
      smooth: bestLeg2.smooth,
      length: bestLeg2.length,
      seconds: bestLeg2.seconds,
      steps: leg2Steps,
    };

    const activeSeg = activeFloor === to.floor ? seg2 : seg1;

    return {
      from,
      to,
      multiFloor: true,
      segments: [seg1, seg2],
      corners: activeSeg.corners,
      smooth: activeSeg.smooth,
      length: seg1.length + seg2.length,
      seconds: seg1.seconds + seg2.seconds + LIFT_TRANSFER_SECONDS,
      steps: [...leg1Steps, ...leg2Steps],
    };
  }

  // ---------------------------------------------------------- instructions

  private describe(pts: Vec2[], from: KioskResource, to: KioskResource): RouteStep[] {
    // merge very short legs so tiny zig-zags do not become instructions
    const legs = mergeShortLegs(pts, 0.8);
    const steps: RouteStep[] = [];
    const startText = from.kind === 'kiosk'
      ? `Start at ${from.name} (${from.floor})`
      : `Start at ${from.name}`;

    let pending = legs.length > 1 ? dist(legs[0], legs[1]) : 0;
    steps.push({ turn: 'start', text: startText, distance: pending, at: legs[0], floor: from.floor });

    for (let i = 1; i < legs.length - 1; i++) {
      const angle = signedTurn(legs[i - 1], legs[i], legs[i + 1]);
      const turn = classifyTurn(angle);
      const next = dist(legs[i], legs[i + 1]);
      if (turn === 'straight') {
        steps[steps.length - 1].distance += next;
        continue;
      }
      const landmark = this.landmarkNear(legs[i], [from.id, to.id]);
      steps.push({
        turn,
        text: turnText(turn) + (landmark ? ` near ${landmark.name}` : ''),
        distance: next,
        at: legs[i],
        floor: from.floor,
      });
    }

    const last = legs[legs.length - 1];
    const side = legs.length >= 2 ? sideOf(legs[legs.length - 2], last, to.center) : null;
    steps.push({
      turn: 'arrive',
      text: `Arrive at ${to.name}` + (side ? ` on your ${side}` : ''),
      distance: 0,
      at: last,
      floor: to.floor,
    });
    return steps;
  }

  private landmarkNear(p: Vec2, exclude: string[]): KioskResource | null {
    let best: KioskResource | null = null;
    let bestD = 2.5;
    for (const r of this.resources) {
      if (r.kind === 'kiosk' || exclude.includes(r.id)) continue;
      const d = distanceToBox(p, r.bounds);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }
}

// --------------------------------------------------------------- geometry

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function polylineLength(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

function distanceToBox(p: Vec2, b: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Signed heading change at `b` in degrees. Positive = left turn for a person
 * walking on the floor plane (three.js: +Y up).
 */
function signedTurn(a: Vec2, b: Vec2, c: Vec2): number {
  const d1x = b.x - a.x, d1z = b.z - a.z;
  const d2x = c.x - b.x, d2z = c.z - b.z;
  // left of d1 (with +Y up) is (d1z, -d1x)
  const cross = d2x * d1z - d2z * d1x;
  const dot = d1x * d2x + d1z * d2z;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function sideOf(a: Vec2, b: Vec2, target: Vec2): 'left' | 'right' | null {
  const dx = b.x - a.x, dz = b.z - a.z;
  const tx = target.x - b.x, tz = target.z - b.z;
  const len = Math.hypot(dx, dz) * Math.hypot(tx, tz);
  if (len < 1e-6) return null;
  const cross = (tx * dz - tz * dx) / len;
  if (Math.abs(cross) < 0.35) return null; // straight ahead
  return cross > 0 ? 'left' : 'right';
}

function classifyTurn(angle: number): TurnKind {
  const a = Math.abs(angle);
  if (a < 25) return 'straight';
  if (a > 150) return 'u-turn';
  if (a < 60) return angle > 0 ? 'slight-left' : 'slight-right';
  return angle > 0 ? 'left' : 'right';
}

function turnText(turn: TurnKind): string {
  switch (turn) {
    case 'slight-left': return 'Bear left';
    case 'slight-right': return 'Bear right';
    case 'left': return 'Turn left';
    case 'right': return 'Turn right';
    case 'u-turn': return 'Turn around';
    default: return 'Continue';
  }
}

function mergeShortLegs(pts: Vec2[], minLeg: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minLeg) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Replaces sharp corners with small quadratic arcs for a nicer looking path. */
function roundCorners(pts: Vec2[], radius: number, segments: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const r = Math.min(radius, dist(a, b) / 2, dist(b, c) / 2);
    const p0 = towards(b, a, r);
    const p2 = towards(b, c, r);
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const u = 1 - t;
      out.push({
        x: u * u * p0.x + 2 * u * t * b.x + t * t * p2.x,
        z: u * u * p0.z + 2 * u * t * b.z + t * t * p2.z,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function towards(from: Vec2, to: Vec2, d: number): Vec2 {
  const l = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / l) * d, z: from.z + ((to.z - from.z) / l) * d };
}
