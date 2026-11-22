import * as THREE from 'three';
import type { TriangleSource } from '../wayfinding/nav-grid';

/** Exposes the world-space triangles of a set of objects to the nav grid builder. */
export function trianglesOf(objects: THREE.Object3D[]): TriangleSource {
  return {
    forEachTriangle(visit) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      for (const root of objects) {
        root.updateWorldMatrix(true, true);
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
          if (!pos) return;
          const index = mesh.geometry.getIndex();
          const m = mesh.matrixWorld;
          const count = index ? index.count : pos.count;
          for (let k = 0; k + 2 < count; k += 3) {
            const ia = index ? index.getX(k) : k;
            const ib = index ? index.getX(k + 1) : k + 1;
            const ic = index ? index.getX(k + 2) : k + 2;
            a.fromBufferAttribute(pos, ia).applyMatrix4(m);
            b.fromBufferAttribute(pos, ib).applyMatrix4(m);
            c.fromBufferAttribute(pos, ic).applyMatrix4(m);
            visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
          }
        });
      }
    },
  };
}
