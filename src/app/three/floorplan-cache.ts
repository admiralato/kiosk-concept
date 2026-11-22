/**
 * Two-tier caching service for heavy 3D floor plan GLB files:
 *
 * 1. **Persistent Disk Cache (Browser Cache Storage API — `spaceboard-glb-cache-v1`)**:
 *    Stores the raw binary GLB response in IndexedDB/CacheStorage on the kiosk machine so
 *    subsequent page reloads, URL query switches (`?kioskId=l13-1`), or browser restarts
 *    load the 35–40 MB GLB from local disk in <150 ms with zero network download.
 *
 * 2. **In-Memory Scene & Wayfinder Cache**:
 *    FloorplanEngine caches parsed Three.js scenes, classified resources, and pre-computed
 *    NavGrid/Wayfinder instances per floor in memory so switching between Level 12 and
 *    Level 13 during multi-floor wayfinding is instantaneous.
 */

const CACHE_NAME = 'spaceboard-glb-cache-v12';

/**
 * Fetches a GLB URL as an `ArrayBuffer`, reading from the persistent Browser Cache Storage
 * if available, or streaming from the network with progress reporting and storing into Cache Storage.
 */
export async function fetchCachedGlbBuffer(
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const hasCacheApi = typeof window !== 'undefined' && 'caches' in window;

  if (hasCacheApi) {
    try {
      const cache = await window.caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(url);
      if (cachedResponse && cachedResponse.ok) {
        onProgress?.(0.5);
        const buf = await cachedResponse.arrayBuffer();
        onProgress?.(1);
        return buf;
      }
    } catch (err) {
      console.warn('CacheStorage read skipped:', err);
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${response.status})`);
  }

  // Clone before consuming body if we have CacheStorage
  const cloneForCache = hasCacheApi ? response.clone() : null;

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  let buffer: ArrayBuffer;

  if (response.body && contentLength > 0) {
    const reader = response.body.getReader();
    const out = new Uint8Array(contentLength);
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (loaded + value.byteLength <= out.byteLength) {
          out.set(value, loaded);
        }
        loaded += value.byteLength;
        onProgress?.(Math.min(1, loaded / contentLength));
      }
    }
    buffer = out.buffer;
  } else {
    buffer = await response.arrayBuffer();
    onProgress?.(1);
  }

  if (hasCacheApi && cloneForCache) {
    window.caches
      .open(CACHE_NAME)
      .then((cache) => cache.put(url, cloneForCache))
      .catch((err) => console.warn('CacheStorage write skipped:', err));
  }

  return buffer;
}

/** Checks whether a GLB model URL is already stored in persistent browser CacheStorage. */
export async function isGlbCachedOnDisk(url: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window)) return false;
  try {
    const cache = await window.caches.open(CACHE_NAME);
    const match = await cache.match(url);
    return !!match;
  } catch {
    return false;
  }
}
