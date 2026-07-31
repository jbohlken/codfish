/**
 * IndexedDB cache for filmstrip thumbnails, so re-opening a clip paints its
 * strip instantly instead of re-decoding (decode is cheap per thumb, but a
 * populated lane is ~20 slots and the cold lag is visible).
 *
 * Keyed (path, mtime, laneHeight, thumbKey): an in-place file edit
 * invalidates via mtime (same rule as the peaks cache); a lane-height/dpr
 * change misses cleanly rather than upscaling stored pixels blurrily. Thumbs
 * are stored as WebP blobs (~1-3 KB each) and rehydrated via
 * createImageBitmap. Everything is best-effort: any failure degrades to a
 * cold cache, never an error the painter sees.
 */

const DB_NAME = "codfish-thumbs";
const DB_VERSION = 1;
const STORE = "thumbs";

interface ThumbEntry {
  k: string;
  path: string;
  mtime: number;
  blob: Blob;
}

/** Composite primary key. \u0000 can't appear in paths, so fields can't collide. */
export function thumbCacheKey(path: string, mtime: number, heightPx: number, key: number): string {
  return `${path}\u0000${mtime}\u0000${heightPx}\u0000${key}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: "k" });
      store.createIndex("path", "path");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Fetch any cached thumbs for the given keys, rehydrated to ImageBitmaps. */
export async function getCachedThumbs(
  path: string,
  mtime: number,
  heightPx: number,
  keys: number[],
): Promise<Map<number, ImageBitmap>> {
  const found = new Map<number, ImageBitmap>();
  try {
    const db = await open();
    const blobs = await new Promise<Map<number, Blob>>((resolve) => {
      const out = new Map<number, Blob>();
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      for (const key of keys) {
        const req = store.get(thumbCacheKey(path, mtime, heightPx, key));
        req.onsuccess = () => {
          const entry = req.result as ThumbEntry | undefined;
          if (entry) out.set(key, entry.blob);
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
    });
    for (const [key, blob] of blobs) {
      try {
        found.set(key, await createImageBitmap(blob));
      } catch {
        // corrupt entry — leave it a miss; the painter re-decodes
      }
    }
  } catch {
    // cache unavailable — cold path
  }
  return found;
}

/** Best-effort write-behind of a freshly decoded thumb. */
export function cacheThumb(
  path: string,
  mtime: number,
  heightPx: number,
  key: number,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): void {
  void (async () => {
    try {
      const blob = canvas instanceof OffscreenCanvas
        ? await canvas.convertToBlob({ type: "image/webp", quality: 0.8 })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
      if (!blob) return;
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        k: thumbCacheKey(path, mtime, heightPx, key),
        path,
        mtime,
        blob,
      } satisfies ThumbEntry);
    } catch {
      // caching is best-effort
    }
  })();
}

/** Drop every stored thumb for `path` whose mtime differs — the file was
 *  edited/replaced in place. Called when a filmstrip opens. */
export function pruneStaleThumbs(path: string, mtime: number): void {
  void (async () => {
    try {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index("path");
      const cursorReq = index.openCursor(IDBKeyRange.only(path));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const entry = cursor.value as ThumbEntry;
        if (entry.mtime !== mtime) cursor.delete();
        cursor.continue();
      };
    } catch {
      // pruning is best-effort
    }
  })();
}
