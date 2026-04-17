/**
 * IndexedDB cache for downsampled waveform peaks.
 * Keyed by path; mtime stored so an in-place edit invalidates the entry.
 */

const DB_NAME = "codfish-peaks";
const DB_VERSION = 2;
const STORE = "peaks";

interface PeakEntry {
  path: string;
  mtime: number;
  peaks: Float32Array;
  duration: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Old v1 store held full decoded PCM in a different shape — drop it
      // rather than trying to migrate.
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "path" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedPeaks(
  path: string,
  mtime: number,
): Promise<{ peaks: Float32Array; duration: number } | null> {
  try {
    const db = await open();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(path);
      req.onsuccess = () => {
        const entry = req.result as PeakEntry | undefined;
        if (!entry || entry.mtime !== mtime) {
          resolve(null);
          return;
        }
        const peaks = entry.peaks instanceof Float32Array
          ? entry.peaks
          : new Float32Array(entry.peaks);
        resolve({ peaks, duration: entry.duration });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePeaks(
  path: string,
  mtime: number,
  peaks: Float32Array,
  duration: number,
): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ path, mtime, peaks, duration } satisfies PeakEntry);
  } catch {
    // Caching is best-effort
  }
}
