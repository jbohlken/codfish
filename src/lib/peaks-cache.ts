/**
 * IndexedDB cache for downsampled waveform peaks.
 * Keyed by path; mtime stored so an in-place edit invalidates the entry,
 * binsPerSec stored so a density-policy change invalidates it too.
 */

const DB_NAME = "codfish-peaks";
const DB_VERSION = 2;
const STORE = "peaks";

interface PeakEntry {
  path: string;
  mtime: number;
  peaks: Float32Array;
  duration: number;
  binsPerSec: number;
}

/**
 * Peak density policy: scale inversely with duration so every file gets
 * roughly the same total bin count (~300k ≈ the bar count of a fully
 * zoomed-in timeline at 500× in a typical window). Short files get dense
 * bins and stay sharp at max zoom; long files keep the legacy 100/sec
 * floor. Null duration (video metadata never loaded) falls back to the
 * legacy density. The 2000/sec cap keeps requests well under the
 * sidecar's 8 kHz decode rate.
 */
export function desiredBinsPerSec(duration: number | null): number {
  if (!duration || duration <= 0) return 100;
  return Math.min(2000, Math.max(100, Math.ceil(300_000 / duration)));
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
  binsPerSec: number,
): Promise<{ peaks: Float32Array; duration: number } | null> {
  try {
    const db = await open();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(path);
      req.onsuccess = () => {
        const entry = req.result as PeakEntry | undefined;
        if (!entry || entry.mtime !== mtime || !entry.duration) {
          resolve(null);
          return;
        }
        // Entries from before the density policy lack the field; their
        // effective density is derivable (and ≈100 in practice), which
        // keeps long-file entries valid instead of regenerating them.
        const entryBins = entry.binsPerSec
          ?? Math.round(entry.peaks.length / entry.duration);
        if (entryBins !== binsPerSec) {
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
  binsPerSec: number,
): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ path, mtime, peaks, duration, binsPerSec } satisfies PeakEntry);
  } catch {
    // Caching is best-effort
  }
}
