/**
 * Grid based navigation mesh for a single floor.
 *
 * This module is intentionally framework/three.js agnostic so that it can be
 * unit tested or pre-computed in Node. The scene adapter (`scene-nav-input.ts`)
 * converts the loaded GLB into a {@link NavInput}.
 *
 * How walkable space is derived:
 *  1. Floor polygons are rasterised into a mask (and slightly dilated so that the
 *     thin gaps under walls / door thresholds become walkable).
 *  2. Wall meshes are *sliced* at a few horizontal heights (e.g. knee & chest
 *     height). The resulting segments are rasterised as solid cells. Slicing,
 *     rather than projecting, keeps door openings open while walls stay closed.
 *  3. Furniture footprints (axis aligned boxes) are rasterised as solid cells.
 *  4. A distance-to-obstacle field is computed; cells closer than the agent
 *     radius are not walkable. The field is also used to keep routes centred in
 *     corridors.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export type TriangleVisitor = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
) => void;

/** Something that can enumerate its world-space triangles. */
export interface TriangleSource {
  forEachTriangle(visit: TriangleVisitor): void;
}

export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NavInput {
  floors: TriangleSource[];
  walls: TriangleSource[];
  obstacles: Footprint[];
  /** Optional exact floor polygons (e.g. toilets/nursing rooms) rasterised directly into `solid` with zero AABB bleed. */
  blockedFloors?: TriangleSource[];
}

export interface NavGridOptions {
  /** Size of a grid cell in metres. */
  cellSize: number;
  /** Half-width of a person; cells closer than this to an obstacle are blocked. */
  agentRadius: number;
  /** Heights (metres) at which wall geometry is sliced. */
  sliceHeights: number[];
  /** How much the floor mask is grown to bridge gaps under walls / thresholds. */
  floorBridge: number;
  /** Routes try to keep at least this distance from walls & furniture. */
  preferredClearance: number;
  /** Strength of the "stay in the middle of the corridor" cost. */
  clearanceWeight: number;
}

export const DEFAULT_NAV_OPTIONS: NavGridOptions = {
  cellSize: 0.1,
  agentRadius: 0.22,
  sliceHeights: [0.35, 1.1],
  floorBridge: 0.15,
  preferredClearance: 0.7,
  clearanceWeight: 2.5,
};

const SQRT2 = Math.SQRT2;
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  readonly cell: number;

  /** 1 = inside a floor polygon (after bridging). */
  readonly floor: Uint8Array;
  /** 1 = wall or furniture. */
  readonly solid: Uint8Array;
  /** Distance (m) to the nearest solid / off-floor cell. */
  readonly clearance: Float32Array;
  /** 1 = an agent can stand here. */
  readonly walkable: Uint8Array;
  /** Connected component id per walkable cell (0 = none). */
  readonly component: Int32Array;

  private constructor(
    readonly options: NavGridOptions,
    bounds: Footprint,
  ) {
    this.cell = options.cellSize;
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / this.cell) + 1;
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / this.cell) + 1;
    const n = this.cols * this.rows;
    this.floor = new Uint8Array(n);
    this.solid = new Uint8Array(n);
    this.clearance = new Float32Array(n);
    this.walkable = new Uint8Array(n);
    this.component = new Int32Array(n);
  }

  // ---------------------------------------------------------------- building

  static build(input: NavInput, opts: Partial<NavGridOptions> = {}): NavGrid {
    const options = { ...DEFAULT_NAV_OPTIONS, ...opts };
    const bounds = computeFloorBounds(input.floors, 1.0);
    const grid = new NavGrid(options, bounds);
    grid.rasteriseFloors(input.floors);
    grid.bridgeFloor(Math.max(1, Math.round(options.floorBridge / grid.cell)));
    grid.rasteriseWalls(input.walls);
    if (input.blockedFloors?.length) {
      grid.rasteriseMask(input.blockedFloors, grid.solid);
    }
    for (const f of input.obstacles) grid.rasteriseFootprint(f);
    grid.computeClearance();
    grid.labelComponents();
    return grid;
  }

  private rasteriseFloors(floors: TriangleSource[]): void {
    this.rasteriseMask(floors, this.floor);
  }

  private rasteriseMask(sources: TriangleSource[], target: Uint8Array): void {
    for (const src of sources) {
      src.forEachTriangle((ax, _ay, az, bx, _by, bz, cx, _cy, cz) => {
        this.fillTriangle(ax, az, bx, bz, cx, cz, target);
      });
    }
  }

  private fillTriangle(
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
    target: Uint8Array,
  ): void {
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.originX) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((Math.max(ax, bx, cx) - this.originX) / this.cell));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.originZ) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.ceil((Math.max(az, bz, cz) - this.originZ) / this.cell));
    const eps = 1e-6;
    for (let r = r0; r <= r1; r++) {
      const pz = this.originZ + (r + 0.5) * this.cell;
      for (let c = c0; c <= c1; c++) {
        const px = this.originX + (c + 0.5) * this.cell;
        const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / area;
        const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -eps && w1 >= -eps && w2 >= -eps) target[r * this.cols + c] = 1;
      }
    }
  }

  /** Morphological dilation of the floor mask by `radius` cells. */
  private bridgeFloor(radius: number): void {
    const src = this.floor.slice();
    const { cols, rows } = this;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (src[r * cols + c]) continue;
        search: for (let dr = -radius; dr <= radius; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -radius; dc <= radius; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            if (src[rr * cols + cc]) {
              this.floor[r * cols + c] = 1;
              break search;
            }
          }
        }
      }
    }
  }

  private rasteriseWalls(walls: TriangleSource[]): void {
    const heights = this.options.sliceHeights;
    for (const src of walls) {
      src.forEachTriangle((ax, ay, az, bx, by, bz, cx, cy, cz) => {
        for (const h of heights) {
          const pts: number[] = [];
          edgeCross(ax, ay, az, bx, by, bz, h, pts);
          edgeCross(bx, by, bz, cx, cy, cz, h, pts);
          edgeCross(cx, cy, cz, ax, ay, az, h, pts);
          if (pts.length >= 4) this.markSegment(pts[0], pts[1], pts[2], pts[3]);
        }
      });
    }
  }

  private markSegment(x0: number, z0: number, x1: number, z1: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.4)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const idx = this.indexOf(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (idx >= 0) this.solid[idx] = 1;
    }
  }

  private rasteriseFootprint(f: Footprint): void {
    const c0 = Math.max(0, Math.floor((f.minX - this.originX) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor((f.maxX - this.originX) / this.cell));
    const r0 = Math.max(0, Math.floor((f.minZ - this.originZ) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor((f.maxZ - this.originZ) / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) this.solid[r * this.cols + c] = 1;
    }
  }

  /** Two-pass chamfer distance transform (3-4 weights) to the nearest blocked cell. */
  private computeClearance(): void {
    const { cols, rows, cell } = this;
    const INF = 1e9;
    const d = new Float32Array(cols * rows);
    for (let i = 0; i < d.length; i++) d[i] = this.floor[i] && !this.solid[i] ? INF : 0;
    const a = 1;
    const b = SQRT2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (d[i] === 0) continue;
        let v = d[i];
        if (c > 0) v = Math.min(v, d[i - 1] + a);
        if (r > 0) {
          v = Math.min(v, d[i - cols] + a);
          if (c > 0) v = Math.min(v, d[i - cols - 1] + b);
          if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + b);
        }
        d[i] = v;
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = r * cols + c;
        if (d[i] === 0) continue;
        let v = d[i];
        if (c < cols - 1) v = Math.min(v, d[i + 1] + a);
        if (r < rows - 1) {
          v = Math.min(v, d[i + cols] + a);
          if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + b);
          if (c > 0) v = Math.min(v, d[i + cols - 1] + b);
        }
        d[i] = v;
      }
    }
    const radius = this.options.agentRadius;
    for (let i = 0; i < d.length; i++) {
      const m = d[i] * cell;
      this.clearance[i] = m;
      this.walkable[i] = m > radius ? 1 : 0;
    }
  }

  private labelComponents(): void {
    const { cols, rows } = this;
    let label = 0;
    const stack: number[] = [];
    for (let start = 0; start < this.walkable.length; start++) {
      if (!this.walkable[start] || this.component[start]) continue;
      label++;
      this.component[start] = label;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop()!;
        const r = (i / cols) | 0;
        const c = i - r * cols;
        for (const [dc, dr] of NEIGHBOURS) {
          if (dc !== 0 && dr !== 0) continue;
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
          const j = rr * cols + cc;
          if (this.walkable[j] && !this.component[j]) {
            this.component[j] = label;
            stack.push(j);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------- utilities

  indexOf(x: number, z: number): number {
    const c = Math.floor((x - this.originX) / this.cell);
    const r = Math.floor((z - this.originZ) / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  centreOf(index: number): Vec2 {
    const r = (index / this.cols) | 0;
    const c = index - r * this.cols;
    return { x: this.originX + (c + 0.5) * this.cell, z: this.originZ + (r + 0.5) * this.cell };
  }

  isWalkable(x: number, z: number): boolean {
    const i = this.indexOf(x, z);
    return i >= 0 && this.walkable[i] === 1;
  }

  /**
   * Finds the walkable cell nearest to `p` (breadth first over the grid).
   * When `component` is given only cells of that connected region qualify, and
   * when `region` is given the candidate must lie inside it (if possible).
   */
  nearestWalkable(p: Vec2, component = 0, maxDistance = 6, region?: Footprint): number {
    const startIdx = this.indexOf(
      clamp(p.x, this.originX, this.originX + (this.cols - 1) * this.cell),
      clamp(p.z, this.originZ, this.originZ + (this.rows - 1) * this.cell),
    );
    if (startIdx < 0) return -1;
    const ok = (i: number) =>
      this.walkable[i] === 1 && (component === 0 || this.component[i] === component);
    const inRegion = (i: number) => {
      if (!region) return true;
      const q = this.centreOf(i);
      return q.x >= region.minX && q.x <= region.maxX && q.z >= region.minZ && q.z <= region.maxZ;
    };
    const maxCells = Math.ceil(maxDistance / this.cell);
    const seen = new Uint8Array(this.walkable.length);
    let frontier = [startIdx];
    seen[startIdx] = 1;
    let fallback = -1;
    for (let ring = 0; ring <= maxCells && frontier.length; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (const i of frontier) {
        if (!ok(i)) continue;
        if (!inRegion(i)) {
          if (fallback < 0) fallback = i;
          continue;
        }
        const q = this.centreOf(i);
        const dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      if (best >= 0) return best;
      const next: number[] = [];
      for (const i of frontier) {
        const r = (i / this.cols) | 0;
        const c = i - r * this.cols;
        for (const [dc, dr] of NEIGHBOURS) {
          if (dc !== 0 && dr !== 0) continue;
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) continue;
          const j = rr * this.cols + cc;
          if (!seen[j]) {
            seen[j] = 1;
            next.push(j);
          }
        }
      }
      frontier = next;
    }
    return fallback;
  }

  // ------------------------------------------------------------ path finding

  /** A* between two walkable cells. Returns cell indices (start..goal) or null. */
  findPath(start: number, goal: number): number[] | null {
    if (start < 0 || goal < 0) return null;
    if (!this.walkable[start] || !this.walkable[goal]) return null;
    if (this.component[start] !== this.component[goal]) return null;
    const { cols, rows, cell } = this;
    const n = cols * rows;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const gr = (goal / cols) | 0;
    const gc = goal - gr * cols;
    const h = (i: number) => {
      const r = (i / cols) | 0;
      const c = i - r * cols;
      const dx = Math.abs(c - gc);
      const dz = Math.abs(r - gr);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * cell;
    };
    const { preferredClearance, clearanceWeight } = this.options;

    g[start] = 0;
    heap.push(start, h(start));
    while (heap.size) {
      const i = heap.pop();
      if (i === goal) break;
      if (closed[i]) continue;
      closed[i] = 1;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (const [dc, dr, w] of NEIGHBOURS) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        if (!this.walkable[j] || closed[j]) continue;
        // no corner cutting
        if (dc !== 0 && dr !== 0) {
          if (!this.walkable[r * cols + cc] || !this.walkable[rr * cols + c]) continue;
        }
        const clr = this.clearance[j];
        const penalty = clr < preferredClearance
          ? clearanceWeight * (1 - clr / preferredClearance)
          : 0;
        const ng = g[i] + w * cell * (1 + penalty);
        if (ng < g[j]) {
          g[j] = ng;
          came[j] = i;
          heap.push(j, ng + h(j));
        }
      }
    }
    if (came[goal] < 0 && start !== goal) return null;
    const out: number[] = [goal];
    let cur = goal;
    while (cur !== start) {
      cur = came[cur];
      out.push(cur);
    }
    return out.reverse();
  }

  /** True when the straight segment a→b stays on cells with at least `minClear` clearance. */
  lineOfSight(a: Vec2, b: Vec2, minClear = this.options.agentRadius): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.35)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const i = this.indexOf(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (i < 0 || !this.walkable[i] || this.clearance[i] < minClear) return false;
    }
    return true;
  }

  /**
   * Removes redundant waypoints ("string pulling") while trying to keep a
   * comfortable distance from walls.
   */
  simplify(cells: number[]): Vec2[] {
    const pts = cells.map((i) => this.centreOf(i));
    if (pts.length <= 2) return pts;
    const comfy = Math.min(this.options.preferredClearance * 0.6, 0.45);
    const out: Vec2[] = [pts[0]];
    let anchor = 0;
    while (anchor < pts.length - 1) {
      let next = anchor + 1;
      for (let k = pts.length - 1; k > anchor + 1; k--) {
        const need = Math.min(
          comfy,
          this.clearanceAt(pts[anchor]),
          this.clearanceAt(pts[k]),
        );
        if (this.lineOfSight(pts[anchor], pts[k], Math.max(this.options.agentRadius, need - 0.05))) {
          next = k;
          break;
        }
      }
      out.push(pts[next]);
      anchor = next;
    }
    return out;
  }

  clearanceAt(p: Vec2): number {
    const i = this.indexOf(p.x, p.z);
    return i < 0 ? 0 : this.clearance[i];
  }
}

// ------------------------------------------------------------------ helpers

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function edgeCross(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  h: number, out: number[],
): void {
  if ((ay - h) * (by - h) > 0 || ay === by) return;
  const t = (h - ay) / (by - ay);
  if (t < 0 || t > 1) return;
  out.push(ax + (bx - ax) * t, az + (bz - az) * t);
}

function computeFloorBounds(floors: TriangleSource[], pad: number): Footprint {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const add = (x: number, z: number) => {
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  };
  for (const f of floors) {
    f.forEachTriangle((ax, _ay, az, bx, _by, bz, cx, _cy, cz) => {
      add(ax, az);
      add(bx, bz);
      add(cx, cz);
    });
  }
  if (!Number.isFinite(b.minX)) throw new Error('NavGrid: no floor geometry found');
  return { minX: b.minX - pad, maxX: b.maxX + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad };
}

/** Small binary min-heap keyed by priority. */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= lastKey) break;
        ids[i] = ids[m];
        keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
