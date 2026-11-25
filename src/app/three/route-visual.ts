import * as THREE from 'three';
import type { Vec2 } from '../wayfinding/nav-grid';

const ROUTE_Y = 0.035;

/**
 * Animated route drawn on the floor: a ribbon with travelling chevrons, a
 * walker puck that follows the path, and a destination pin.
 */
export class RouteVisual {
  readonly group = new THREE.Group();
  private ribbon?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private curve?: THREE.CurvePath<THREE.Vector3>;
  private length = 0;
  private readonly walker: THREE.Group;
  private readonly pin: THREE.Group;
  private readonly pinRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly startRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private elapsed = 0;
  private drawProgress = 0;

  constructor(private readonly color = new THREE.Color('#2563eb')) {
    this.group.name = 'route';
    this.group.visible = false;
    this.group.renderOrder = 10;

    // walker: glowing puck
    this.walker = new THREE.Group();
    const puck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.06, 32),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    );
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.08, 32),
      new THREE.MeshBasicMaterial({ color }),
    );
    puck.position.y = core.position.y = 0.06;
    this.walker.add(puck, core);
    this.group.add(this.walker);

    // destination pin
    this.pin = new THREE.Group();
    const pinMat = new THREE.MeshStandardMaterial({ color: '#ef4444', roughness: 0.35, metalness: 0.1 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 16), pinMat);
    head.position.y = 1.35;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 32), pinMat);
    tip.rotation.x = Math.PI;
    tip.position.y = 1.05;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 8), new THREE.MeshBasicMaterial({ color: '#fff' }));
    dot.position.set(0, 1.38, 0.17);
    this.pin.add(head, tip, dot);
    this.pinRing = makeRing('#ef4444');
    this.pin.add(this.pinRing);
    this.group.add(this.pin);

    this.startRing = makeRing(color.getStyle());
    this.group.add(this.startRing);
  }

  show(points: Vec2[], destination: Vec2): void {
    this.clear();
    if (points.length < 2) return;
    const pts3 = points.map((p) => new THREE.Vector3(p.x, ROUTE_Y, p.z));
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < pts3.length; i++) {
      if (pts3[i].distanceToSquared(pts3[i - 1]) > 1e-8) path.add(new THREE.LineCurve3(pts3[i - 1], pts3[i]));
    }
    this.curve = path;
    this.length = path.getLength();

    const geometry = buildRibbon(pts3, 0.3);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: this.color },
        uLength: { value: this.length },
        uReveal: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aDist;
        attribute float aSide;
        varying float vDist;
        varying float vSide;
        void main() {
          vDist = aDist;
          vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uLength;
        uniform float uReveal;
        varying float vDist;
        varying float vSide;
        void main() {
          if (vDist > uReveal * uLength) discard;
          float side = abs(vSide);
          float edge = 1.0 - smoothstep(0.82, 1.0, side);
          float s = vDist / 0.55 - uTime * 1.6 + side * 0.45;
          float f = fract(s);
          float chev = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.28, 0.36, f));
          chev *= 1.0 - smoothstep(0.55, 0.75, side);
          vec3 col = mix(uColor, vec3(1.0), chev * 0.95);
          float border = smoothstep(0.62, 0.8, side);
          col = mix(col, uColor * 0.7, border);
          gl_FragColor = vec4(col, 0.92 * edge);
        }
      `,
    });
    this.ribbon = new THREE.Mesh(geometry, material);
    this.ribbon.renderOrder = 10;
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);

    this.pin.position.set(destination.x, 0, destination.z);
    const s = pts3[0];
    this.startRing.position.set(s.x, ROUTE_Y + 0.005, s.z);
    this.walker.position.copy(s);
    this.elapsed = 0;
    this.drawProgress = 0;
    this.group.visible = true;
  }

  clear(): void {
    if (this.ribbon) {
      this.group.remove(this.ribbon);
      this.ribbon.geometry.dispose();
      this.ribbon.material.dispose();
      this.ribbon = undefined;
    }
    this.curve = undefined;
    this.group.visible = false;
  }

  update(dt: number): void {
    if (!this.group.visible || !this.ribbon || !this.curve) return;
    this.elapsed += dt;
    // reveal the route over ~1.2 seconds, then animate the walker
    this.drawProgress = Math.min(1, this.drawProgress + dt / 1.2);
    const u = this.ribbon.material.uniforms;
    u['uTime'].value = this.elapsed;
    u['uReveal'].value = easeOutCubic(this.drawProgress);

    const walkSpeed = 2.4; // m/s (visual)
    const cycle = this.length / walkSpeed + 1.2;
    const t = this.drawProgress < 1 ? easeOutCubic(this.drawProgress) : Math.min(1, ((this.elapsed - 1.2) % cycle) / (cycle - 1.2));
    this.walker.position.copy(this.curve.getPointAt(Math.min(1, Math.max(0, t))));

    const bob = Math.sin(this.elapsed * 3) * 0.08;
    this.pin.children[0].position.y = 1.35 + bob;
    this.pin.children[1].position.y = 1.05 + bob;
    this.pin.children[2].position.y = 1.38 + bob;
    pulse(this.pinRing, this.elapsed);
    pulse(this.startRing, this.elapsed + 0.6);
  }
}

function makeRing(color: string): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.42, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = ROUTE_Y + 0.01;
  ring.renderOrder = 11;
  return ring;
}

function pulse(ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>, t: number): void {
  const p = (t % 1.6) / 1.6;
  const s = 0.6 + p * 1.6;
  ring.scale.set(s, s, s);
  ring.material.opacity = 0.9 * (1 - p);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Flat ribbon along a polyline, with distance-along and side attributes. */
function buildRibbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  const dists: number[] = [];
  const sides: number[] = [];
  const indices: number[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    if (i > 0) acc += p.distanceTo(prev);
    const dir = new THREE.Vector3().subVectors(next, prev).setY(0);
    if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
    dir.normalize();
    const nx = -dir.z;
    const nz = dir.x;
    positions.push(p.x + nx * half, p.y, p.z + nz * half, p.x - nx * half, p.y, p.z - nz * half);
    dists.push(acc, acc);
    sides.push(1, -1);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dists, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
  g.setIndex(indices);
  return g;
}
