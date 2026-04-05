/**
 * IndexedDB cache for WaveSurfer peak data.
 * Keyed by file path so decoded waveforms survive across sessions.
 */

const DB_NAME = "codfish-peaks";
const DB_VERSION = 1;
const STORE = "peaks";

interface PeakEntry {
  path: string;
  peaks: Float32Array[];
  duration: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "path" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedPeaks(
  path: string,
): Promise<{ peaks: Float32Array[]; duration: number } | null> {
  try {
    const db = await open();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(path);
      req.onsuccess = () => {
        const entry = req.result as PeakEntry | undefined;
        if (entry) {
          // IndexedDB may deserialize typed arrays as plain arrays
          const peaks = entry.peaks.map(
            (ch) => (ch instanceof Float32Array ? ch : new Float32Array(ch)),
          );
          resolve({ peaks, duration: entry.duration });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePeaks(
  path: string,
  peaks: Float32Array[],
  duration: number,
): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ path, peaks, duration } satisfies PeakEntry);
  } catch {
    // Caching is best-effort
  }
}
