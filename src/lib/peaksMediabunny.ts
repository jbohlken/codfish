/**
 * In-process waveform peaks via mediabunny + WebCodecs — the full-fidelity
 * replacement for the sidecar's 8 kHz mono ffmpeg pipe. Decodes the audio
 * track at its native sample rate and max-abs-reduces a mean channel downmix
 * (matching ffmpeg's `-ac 1` averaging for mono/stereo sources; >2-channel
 * layouts use an unweighted mean, which differs slightly from swresample's
 * center/LFE weighting — fine for a peaks envelope) into the same bins/sec
 * contract generate_peaks used. The Timeline falls back to the sidecar path
 * when this returns null (unreadable file, undecodable codec), so nothing
 * regresses.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { desiredBinsPerSec } from "./peaks-cache";
import { loadMediabunny } from "./mediabunnyRuntime";

export interface GeneratedPeaks {
  peaks: Float32Array;
  /** Decoded audio length in seconds (ground truth, like ffmpeg's). */
  duration: number;
  binsPerSec: number;
}

/**
 * Max-abs-reduce one interleaved f32 chunk into the peak bins.
 * `baseFrame` is the chunk's first frame index on the track's own timeline
 * (frame 0 = track start). Mean-downmix across channels per frame, abs, then
 * max into the frame's bin. Frames that land past the end of `bins` (duration
 * estimate vs. real decoded length) are dropped. Pure — unit-tested.
 */
export function reduceInterleavedIntoBins(
  bins: Float32Array,
  data: Float32Array,
  channels: number,
  baseFrame: number,
  sampleRate: number,
  binsPerSec: number,
): void {
  const frames = channels > 0 ? Math.floor(data.length / channels) : 0;
  for (let f = 0; f < frames; f++) {
    const bin = Math.floor(((baseFrame + f) / sampleRate) * binsPerSec);
    if (bin < 0 || bin >= bins.length) continue;
    let sum = 0;
    const off = f * channels;
    for (let c = 0; c < channels; c++) sum += data[off + c];
    const amp = Math.abs(sum / channels);
    if (amp > bins[bin]) bins[bin] = amp;
  }
}

/**
 * Trim the bin array to the decoded extent and derive the axis duration the
 * kept bins ACTUALLY span (usedBins / binsPerSec) — never the raw decode end.
 * Block codecs decode in fixed frames (AAC: 1024 samples), so the decoder
 * emits padding past the container's true end; reporting that padded end with
 * bins that only cover the true content stretches the waveform's time axis
 * (~0.27% for AAC — the last click of the FR7 fixture landed ~14 ms late).
 * Keeping peaks.length / duration === binsPerSec exactly is the painter's
 * axis invariant. Pure — unit-tested.
 */
export function trimPeaks(
  bins: Float32Array,
  decodedEnd: number,
  binsPerSec: number,
): { peaks: Float32Array; duration: number } {
  const usedBins = Math.min(bins.length, Math.max(1, Math.ceil(decodedEnd * binsPerSec)));
  return {
    peaks: usedBins === bins.length ? bins : bins.slice(0, usedBins),
    duration: usedBins / binsPerSec,
  };
}

/** Decode the whole audio track and produce peaks. Resolves null when the file
 *  can't be read, the codec can't be decoded in-process, or `isCancelled`
 *  reports true (checked every chunk — a clip switch stops the decode instead
 *  of letting an orphaned full-file decode churn the main thread). Never
 *  throws. */
export async function generatePeaksViaMediabunny(
  path: string,
  isCancelled?: () => boolean,
): Promise<GeneratedPeaks | null> {
  try {
    const { Input, ALL_FORMATS, UrlSource, AudioSampleSink } = await loadMediabunny();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(convertFileSrc(path)),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return null;

      const firstTs = await track.getFirstTimestamp();
      const trackDuration = Math.max(0, (await track.computeDuration()) - Math.max(firstTs, 0));
      if (trackDuration <= 0) return null;
      const binsPerSec = desiredBinsPerSec(trackDuration);

      // Sized from packet timestamps; decode can come up slightly short (or
      // long — reduce drops those frames). Trimmed to decoded length at the end.
      const bins = new Float32Array(Math.max(1, Math.ceil(trackDuration * binsPerSec)));

      const sink = new AudioSampleSink(track);
      let scratch = new Float32Array(0);
      let decodedEnd = 0;
      let chunks = 0;
      for await (const sample of sink.samples()) {
        if (isCancelled?.()) {
          sample.close();
          return null; // breaking out closes the sink iterator; finally disposes the input
        }
        // Use the DECODED sample's own rate for the frame→time mapping, not the
        // container's: SBR codecs (HE-AAC) declare half the rate they decode at,
        // which would time-smear every bin index by 2x.
        const { numberOfFrames, numberOfChannels, timestamp, sampleRate: decodedRate } = sample;
        const needed = numberOfFrames * numberOfChannels;
        if (scratch.length < needed) scratch = new Float32Array(needed);
        sample.copyTo(scratch, { planeIndex: 0, format: "f32" });
        const baseFrame = Math.round((timestamp - Math.max(firstTs, 0)) * decodedRate);
        reduceInterleavedIntoBins(
          bins,
          scratch.subarray(0, needed), // subarray so stale tail from a larger prior chunk is excluded
          numberOfChannels,
          baseFrame,
          decodedRate,
          binsPerSec,
        );
        decodedEnd = Math.max(decodedEnd, timestamp - Math.max(firstTs, 0) + sample.duration);
        sample.close();
        // WebCodecs decodes off-thread but this loop churns on the main thread;
        // breathe every so often so a long file doesn't starve rendering.
        if ((++chunks & 127) === 0) await new Promise((r) => setTimeout(r, 0));
      }

      if (decodedEnd <= 0) return null;
      return { ...trimPeaks(bins, decodedEnd, binsPerSec), binsPerSec };
    } finally {
      input.dispose();
    }
  } catch {
    return null;
  }
}
