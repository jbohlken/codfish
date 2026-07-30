// Phase-0 mediabunny spike. Runs a metadata/decode/seek battery over media
// files through both candidate byte sources — UrlSource (asset protocol,
// range requests) and CustomSource (Rust read_file_range IPC) — and reports
// per-step timings. Three entry points: "pick file + run" (manual, one file),
// "run all fixtures" (everything in test-media/mediabunny-spike, report saved
// to RESULTS.md), and auto mode (VITE_SPIKE_AUTO=1: run all on launch, save,
// then force-quit the app — used for unattended battery runs). Throwaway
// evaluation harness: nothing here touches playback, the store, or project
// files. Loaded lazily by MediaSpike so mediabunny stays out of startup.
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  CustomSource,
  Input,
  Source,
  UrlSource,
  VideoSampleSink,
  type InputAudioTrack,
  type InputVideoTrack,
} from "mediabunny";
import { generatePeaksViaMediabunny } from "../lib/peaksMediabunny";
import { loadMediabunny } from "../lib/mediabunnyRuntime";

// ProRes/AC-3 decoder registration goes through the SAME shared runtime loader
// production uses (lib/mediabunnyRuntime) — so the battery exercises exactly
// the decoder set the app ships with, instead of registering its own.
void loadMediabunny();

const AUTO = import.meta.env.VITE_SPIKE_AUTO === "1";

type LogLine = { kind: "head" | "info" | "ok" | "err"; text: string };
type Figure = { label: string; canvas: HTMLCanvasElement };

type VideoMetrics = {
  codec: string | null;
  params: string | null;
  width: number;
  height: number;
  rotation: number;
  fps: number;
  mbps: number;
  canDecode: boolean;
  rotationApplied?: boolean;
  firstFrameMs?: number;
  thumbsDrawn?: number;
  thumbsTotalMs?: number;
  seekMsSorted?: number[];
  stepFirstMs?: number;
  stepAvgMs?: number;
};
type AudioMetrics = {
  codec: string | null;
  params: string | null;
  sampleRate: number;
  channels: number;
  canDecode: boolean;
  bufferMs?: number;
  windowSecs?: number;
  windowMs?: number;
  xRealtime?: number;
};
type SourceMetrics = {
  source: string;
  format?: string;
  mime?: string;
  durationS?: number;
  firstTs?: number;
  trackTypes?: string[];
  video?: VideoMetrics;
  audio?: AudioMetrics;
  ipc?: { calls: number; bytes: number };
  errors: string[];
  totalMs?: number;
};
type FileResult = { file: string; sizeMB?: number; sources: SourceMetrics[] };

const SPIKE_EXTS = [
  "mp4", "m4v", "m4a", "mov", "webm", "mkv", "ts", "m2ts", "mts",
  "ogg", "ogv", "oga", "opus", "mp3", "wav", "aac", "flac",
  // Deliberately outside mediabunny's container list, to see the failure mode:
  "avi", "wmv",
];

const fmtS = (s: number) => s.toFixed(3);
const fmtMs = (ms: number) => `${ms.toFixed(1)} ms`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const median = (sorted: number[]) => sorted[Math.floor(sorted.length / 2)];

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });

/** Copy a (possibly pooled/offscreen) sink canvas into a plain DOM canvas we own. */
function cloneToCanvas(source: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  out.getContext("2d")!.drawImage(source, 0, 0);
  return out;
}

function CanvasFigure({ figure }: { figure: Figure }) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    el.appendChild(figure.canvas);
    return () => figure.canvas.remove();
  }, [figure]);
  return (
    <div style={{ margin: "6px 0" }}>
      <div style={{ opacity: 0.7, marginBottom: 2 }}>{figure.label}</div>
      <div ref={holder} style={{ lineHeight: 0, maxWidth: "100%", overflow: "hidden" }} />
    </div>
  );
}

export function MediaSpikePanel({ onClose }: { onClose: () => void }) {
  const lines = useRef<LogLine[]>([]);
  const figures = useRef<Figure[]>([]);
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const [running, setRunning] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  // Battery generation counter: bumped by every new run and by unmount, so a
  // superseded or abandoned battery stops at its next checkpoint instead of
  // racing the new one (or outliving the panel).
  const runGeneration = useRef(0);
  useEffect(() => () => {
    runGeneration.current++;
  }, []);

  const push = (kind: LogLine["kind"], text: string, metrics?: SourceMetrics) => {
    lines.current.push({ kind, text });
    if (kind === "err" && metrics) metrics.errors.push(text.trim());
    bump();
  };
  const addFigure = (label: string, canvas: HTMLCanvasElement) => {
    if (AUTO) return; // nobody's watching; don't accumulate 48 canvases
    figures.current.push({ label, canvas });
    bump();
  };

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Time a step; log ok/err; return the value or null on failure. */
  const step = async <T,>(name: string, metrics: SourceMetrics, fn: () => Promise<T>): Promise<{ value: T; ms: number } | null> => {
    const t0 = performance.now();
    try {
      const value = await fn();
      const ms = performance.now() - t0;
      push("ok", `${name} — ${fmtMs(ms)}`);
      return { value, ms };
    } catch (e) {
      push("err", `${name} — FAILED: ${errText(e)}`, metrics);
      return null;
    }
  };

  const videoBattery = async (label: string, m: SourceMetrics, video: InputVideoTrack, firstTs: number, duration: number, isStale: () => boolean) => {
    const codec = await video.getCodec();
    const stats = await video.computePacketStats(120);
    const v: VideoMetrics = {
      codec,
      params: await video.getCodecParameterString(),
      width: await video.getCodedWidth(),
      height: await video.getCodedHeight(),
      rotation: await video.getRotation(),
      fps: stats.averagePacketRate,
      mbps: stats.averageBitrate / 1e6,
      canDecode: false,
    };
    m.video = v;
    push(
      "info",
      `  video: ${v.codec ?? "unrecognized"} (${v.params ?? "?"}) ${v.width}x${v.height} rot=${v.rotation}° `
        + `~${v.fps.toFixed(3)} fps ${v.mbps.toFixed(2)} Mbps`,
    );

    v.canDecode = await video.canDecode();
    if (!v.canDecode) {
      push("err", `  video canDecode() = false${codec === null ? " (codec not recognized)" : " (no decoder for codec)"}`, m);
      return;
    }
    push("ok", "  video canDecode() = true");

    // Probe at the video track's own start, not the file-wide first timestamp:
    // AAC priming makes the file start slightly negative (e.g. -0.0213s), and
    // getCanvas() before the first frame correctly returns null.
    const videoFirstTs = Math.max(firstTs, await video.getFirstTimestamp());
    const firstFrameSink = new CanvasSink(video, { width: 320, fit: "contain" });
    const first = await step("  decode first frame", m, () => firstFrameSink.getCanvas(videoFirstTs));
    if (first?.value) {
      v.firstFrameMs = first.ms;
      addFigure(`${label} — first frame @ ${fmtS(first.value.timestamp)}s`, cloneToCanvas(first.value.canvas));
      // Rotation check: for ±90° metadata on landscape-coded video, the sink's
      // output must come out portrait — this is the assertion the rotated
      // fixture exists for (previously only checkable by eyeballing figures).
      if ((v.rotation === 90 || v.rotation === 270) && v.width > v.height) {
        const c = first.value.canvas;
        v.rotationApplied = c.height > c.width;
        push(
          v.rotationApplied ? "ok" : "err",
          `  rotation ${v.rotation}°: CanvasSink ${v.rotationApplied ? "applied (portrait output)" : "NOT applied"}`,
          v.rotationApplied ? undefined : m,
        );
      }
    }

    // Sparse thumbnail strip — the filmstrip use case.
    const THUMBS = 8;
    const slotW = 120;
    const slotH = 68;
    const thumbSink = new CanvasSink(video, { width: slotW, height: slotH, fit: "contain" });
    const stamps = Array.from(
      { length: THUMBS },
      (_, i) => firstTs + ((i + 0.5) / THUMBS) * Math.max(duration - firstTs, 0),
    );
    const strip = document.createElement("canvas");
    strip.width = THUMBS * (slotW + 4) - 4;
    strip.height = slotH;
    const stripCtx = strip.getContext("2d")!;
    const t0 = performance.now();
    let slot = 0;
    let drawn = 0;
    try {
      for await (const wrapped of thumbSink.canvasesAtTimestamps(stamps)) {
        if (wrapped) {
          stripCtx.drawImage(wrapped.canvas, slot * (slotW + 4), 0);
          drawn++;
        }
        slot++;
      }
      const dt = performance.now() - t0;
      v.thumbsDrawn = drawn;
      v.thumbsTotalMs = dt;
      push("ok", `  thumbnail strip: ${drawn}/${THUMBS} frames — ${fmtMs(dt)} total, ${fmtMs(dt / THUMBS)}/frame`);
      addFigure(`${label} — ${THUMBS} thumbnails across the file`, strip);
    } catch (e) {
      push("err", `  thumbnail strip — FAILED: ${errText(e)}`, m);
    }

    // Random seeks — cold-ish decode latency at arbitrary points.
    const sampleSink = new VideoSampleSink(video);
    const seekTimes: number[] = [];
    for (let i = 0; i < 6; i++) {
      if (isStale()) return;
      const t = firstTs + Math.random() * Math.max(duration - firstTs, 0);
      const s0 = performance.now();
      try {
        const sample = await sampleSink.getSample(t);
        const dt = performance.now() - s0;
        if (sample) {
          seekTimes.push(dt);
          sample.close();
        } else {
          push("err", `  random seek @ ${fmtS(t)}s → no sample`, m);
        }
      } catch (e) {
        push("err", `  random seek @ ${fmtS(t)}s — FAILED: ${errText(e)}`, m);
      }
    }
    if (seekTimes.length) {
      const sorted = [...seekTimes].sort((a, b) => a - b);
      v.seekMsSorted = sorted;
      push(
        "ok",
        `  random-seek latency (${sorted.length}x): min ${fmtMs(sorted[0])} / median ${fmtMs(median(sorted))} / max ${fmtMs(sorted[sorted.length - 1])}`,
      );
    }

    // Sequential stepping from the middle — the frame-step use case. The first
    // sample pays the seek-to-keyframe cost; the following ones ride the open
    // decoder.
    if (isStale()) return;
    const mid = firstTs + Math.max(duration - firstTs, 0) / 2;
    const iterator = sampleSink.samples(mid);
    const STEPS = 10;
    try {
      const s0 = performance.now();
      let firstMs = 0;
      let count = 0;
      for await (const sample of iterator) {
        if (count === 0) firstMs = performance.now() - s0;
        sample.close();
        if (++count === STEPS || isStale()) break;
      }
      const total = performance.now() - s0;
      if (count > 1) {
        v.stepFirstMs = firstMs;
        v.stepAvgMs = (total - firstMs) / (count - 1);
        push(
          "ok",
          `  frame stepping @ ${fmtS(mid)}s: first frame ${fmtMs(firstMs)}, then ${fmtMs(v.stepAvgMs)}/frame over ${count - 1}`,
        );
      }
    } catch (e) {
      push("err", `  frame stepping — FAILED: ${errText(e)}`, m);
    }
  };

  const audioBattery = async (m: SourceMetrics, audio: InputAudioTrack, firstTs: number, duration: number, isStale: () => boolean) => {
    const codec = await audio.getCodec();
    const a: AudioMetrics = {
      codec,
      params: await audio.getCodecParameterString(),
      sampleRate: await audio.getSampleRate(),
      channels: await audio.getNumberOfChannels(),
      canDecode: false,
    };
    m.audio = a;
    push("info", `  audio: ${a.codec ?? "unrecognized"} (${a.params ?? "?"}) ${a.sampleRate} Hz, ${a.channels} ch`);

    a.canDecode = await audio.canDecode();
    if (!a.canDecode) {
      push("err", `  audio canDecode() = false${codec === null ? " (codec not recognized)" : " (no decoder for codec)"}`, m);
      return;
    }
    push("ok", "  audio canDecode() = true");

    const sink = new AudioBufferSink(audio);
    const mid = firstTs + Math.max(duration - firstTs, 0) / 2;
    const wrapped = await step(`  decode audio @ ${fmtS(mid)}s`, m, () => sink.getBuffer(mid));
    if (wrapped?.value) {
      a.bufferMs = wrapped.ms;
      push("info", `    AudioBuffer: ${wrapped.value.buffer.numberOfChannels} ch, ${wrapped.value.buffer.sampleRate} Hz, ${fmtS(wrapped.value.buffer.duration)}s chunk`);
    }

    // Throughput over a 5 s window — the waveform/peaks use case, full fidelity
    // (vs. today's 8 kHz ffmpeg pipe).
    if (isStale()) return;
    const end = Math.min(mid + 5, duration);
    const t0 = performance.now();
    let secs = 0;
    try {
      for await (const { buffer } of sink.buffers(mid, end)) {
        secs += buffer.duration;
        if (isStale()) break;
      }
      const dt = performance.now() - t0;
      a.windowSecs = secs;
      a.windowMs = dt;
      a.xRealtime = dt > 0 ? (secs * 1000) / dt : Infinity;
      push("ok", `  decoded ${fmtS(secs)}s of audio in ${fmtMs(dt)} (${a.xRealtime.toFixed(1)}x realtime)`);
    } catch (e) {
      push("err", `  audio window decode — FAILED: ${errText(e)}`, m);
    }
  };

  const runSource = async (label: string, source: Source, m: SourceMetrics, isStale: () => boolean) => {
    push("head", `━━ ${label} ━━`);
    const t0 = performance.now();
    const input = new Input({ formats: ALL_FORMATS, source });
    try {
      const format = await step("recognize format", m, () => input.getFormat());
      if (!format || isStale()) return;
      m.format = format.value.name;
      m.mime = await input.getMimeType();
      push("info", `  ${m.format} · ${m.mime}`);

      const duration = await step("computeDuration", m, () => input.computeDuration(undefined, { skipLiveWait: true }));
      if (duration === null) return;
      m.durationS = duration.value;
      m.firstTs = await input.getFirstTimestamp();
      push("info", `  duration ${fmtS(duration.value)}s, first timestamp ${fmtS(m.firstTs)}s`);

      const tracks = await input.getTracks();
      m.trackTypes = tracks.map((t) => t.type);
      push("info", `  tracks: ${m.trackTypes.join(", ") || "(none)"}`);

      if (isStale()) return;
      const video = await input.getPrimaryVideoTrack();
      if (video) await videoBattery(label, m, video, m.firstTs, duration.value, isStale);
      else push("info", "  no video track");

      if (isStale()) return;
      const audio = await input.getPrimaryAudioTrack();
      if (audio) await audioBattery(m, audio, m.firstTs, duration.value, isStale);
      else push("info", "  no audio track");

      if (m.ipc) {
        push("info", `  IPC reads: ${m.ipc.calls} calls, ${(m.ipc.bytes / 1e6).toFixed(2)} MB transferred`);
      }
    } catch (e) {
      push("err", `${label} — FAILED: ${errText(e)}`, m);
    } finally {
      m.totalMs = performance.now() - t0;
      input.dispose();
    }
  };

  /** Run both byte sources over one file; returns the structured record. */
  const runFile = async (path: string, isStale: () => boolean): Promise<FileResult> => {
    const rec: FileResult = { file: basename(path), sources: [] };
    push("head", `═══ ${rec.file} ═══`);
    try {
      rec.sizeMB = (await invoke<number>("file_size", { path })) / 1e6;
      push("info", `size: ${rec.sizeMB.toFixed(2)} MB`);
    } catch (e) {
      push("err", `file_size failed: ${errText(e)}`);
    }

    if (!isStale()) {
      const m: SourceMetrics = { source: "UrlSource", errors: [] };
      rec.sources.push(m);
      await withTimeout(runSource("UrlSource (asset protocol)", new UrlSource(convertFileSrc(path)), m, isStale), 90_000, "UrlSource battery")
        .catch((e) => push("err", `UrlSource battery — ${errText(e)}`, m));
    }
    if (!isStale()) {
      const m: SourceMetrics = { source: "Rust IPC", errors: [], ipc: { calls: 0, bytes: 0 } };
      rec.sources.push(m);
      const source = new CustomSource({
        getSize: () => invoke<number>("file_size", { path }),
        read: async (start, end) => {
          const buf = await invoke<ArrayBuffer>("read_file_range", { path, start, end });
          m.ipc!.calls++;
          m.ipc!.bytes += buf.byteLength;
          return new Uint8Array(buf);
        },
        prefetchProfile: "fileSystem",
      });
      await withTimeout(runSource("CustomSource (Rust read_file_range)", source, m, isStale), 90_000, "CustomSource battery")
        .catch((e) => push("err", `CustomSource battery — ${errText(e)}`, m));
    }
    return rec;
  };

  const buildReport = (all: FileResult[], sanity: string[] = []): string => {
    const row = (r: FileResult, m: SourceMetrics) => {
      const v = m.video;
      const a = m.audio;
      const cells = [
        r.file,
        m.source,
        m.format ?? "—",
        m.durationS !== undefined ? fmtS(m.durationS) : "—",
        v ? `${v.codec ?? "?"} ${v.canDecode ? "✓" : "✗"}` : "—",
        v?.firstFrameMs !== undefined ? v.firstFrameMs.toFixed(0) : "—",
        v?.seekMsSorted ? median(v.seekMsSorted).toFixed(0) : "—",
        v?.stepAvgMs !== undefined ? v.stepAvgMs.toFixed(1) : "—",
        a ? `${a.codec ?? "?"} ${a.canDecode ? "✓" : "✗"}` : "—",
        a?.xRealtime !== undefined ? `${a.xRealtime.toFixed(0)}x` : "—",
        m.ipc ? `${m.ipc.calls}/${(m.ipc.bytes / 1e6).toFixed(1)}MB` : "—",
        m.errors.length ? m.errors.map((e) => e.replace(/\|/g, "/")).join("; ") : "",
      ];
      return `| ${cells.join(" | ")} |`;
    };
    return [
      "# mediabunny spike — battery results",
      "",
      `- generated: ${new Date().toISOString()}`,
      `- userAgent: ${navigator.userAgent}`,
      `- WebCodecs: VideoDecoder=${"VideoDecoder" in window} AudioDecoder=${"AudioDecoder" in window}`,
      `- hardwareConcurrency: ${navigator.hardwareConcurrency}`,
      "",
      "| file | src | format | dur s | video (canDec) | 1st frame ms | seek med ms | step ms/f | audio (canDec) | audio ×rt | IPC calls/MB | errors |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...all.flatMap((r) => r.sources.map((m) => row(r, m))),
      "",
      "## Peaks sanity (production lib/peaksMediabunny path)",
      "",
      ...(sanity.length ? sanity.map((s) => `- ${s}`) : ["- (not run)"]),
      "",
      "## Raw data",
      "",
      "```json",
      JSON.stringify(all, null, 1),
      "```",
      "",
    ].join("\n");
  };

  const runAll = async () => {
    const generation = ++runGeneration.current;
    const isStale = () => runGeneration.current !== generation;
    setRunning(true);
    try {
      await loadMediabunny(); // decoders must be registered before canDecode checks
      const dir = await invoke<string>("spike_fixture_dir");
      const listing = await invoke<{ files: string[]; folders: { name: string; media: string[] }[] }>(
        "collect_dropped_media",
        { paths: [dir], exts: SPIKE_EXTS },
      );
      const files = [...listing.files, ...listing.folders.flatMap((f) => f.media)].sort();
      push("info", `fixture dir: ${dir}`);
      push("info", `WebCodecs: VideoDecoder=${"VideoDecoder" in window} AudioDecoder=${"AudioDecoder" in window}`);
      if (files.length === 0) {
        push("err", "no fixtures found — run `npm run spike:media` first");
        return;
      }
      push("info", `${files.length} fixtures`);

      const all: FileResult[] = [];
      for (const path of files) {
        if (isStale()) return;
        all.push(await runFile(path, isStale));
      }

      // End-to-end check of the production peaks path (lib/peaksMediabunny).
      // Guards against decode-pipeline bugs that produce plausible-but-empty
      // output — unit tests can't reach the real WebCodecs integration.
      push("head", "━━ peaks sanity (lib/peaksMediabunny) ━━");
      const sanity: string[] = [];
      for (const path of files) {
        if (isStale()) return;
        const name = basename(path);
        if (!/control-h264|control-vp9|vbr\.mp3|prores-hq/.test(name)) continue;
        const r = await generatePeaksViaMediabunny(path, isStale);
        if (!r) {
          const line = `${name}: declined (fallback path would run)`;
          sanity.push(line);
          push("err", `  ${line}`);
          continue;
        }
        let max = 0;
        let nonzero = 0;
        for (let i = 0; i < r.peaks.length; i++) {
          const v = r.peaks[i];
          if (v > max) max = v;
          if (v > 0.001) nonzero++;
        }
        // Axis invariant: the stored bins and reported duration must agree, or
        // the painter stretches/squeezes the waveform's time axis (FR7 drift).
        const axisOff = Math.abs(r.peaks.length / r.duration - r.binsPerSec) > 0.01;
        const flag = max < 0.01 ? " ← FLAT" : axisOff ? " ← AXIS MISMATCH" : "";
        const line = `${name}: bins=${r.peaks.length} max=${max.toFixed(3)} `
          + `nonzero=${((nonzero / r.peaks.length) * 100).toFixed(0)}% dur=${r.duration.toFixed(3)}s`;
        sanity.push(line + flag);
        push(flag ? "err" : "ok", `  ${line}${flag}`);
      }

      if (isStale()) return;
      const saved = await invoke<string>("save_spike_report", { content: buildReport(all, sanity) });
      push("head", `━━ report saved → ${saved} ━━`);
    } catch (e) {
      push("err", `run all — FAILED: ${errText(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const runOne = async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Media (spike superset)", extensions: SPIKE_EXTS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    const generation = ++runGeneration.current;
    const isStale = () => runGeneration.current !== generation;
    setRunning(true);
    try {
      await loadMediabunny();
      await runFile(picked, isStale);
      if (!isStale()) push("head", "━━ done ━━");
    } finally {
      setRunning(false);
    }
  };

  // Unattended mode: run everything on mount, save the report, quit the app so
  // the invoking terminal gets its exit.
  useEffect(() => {
    if (!AUTO || autoStarted.current) return;
    autoStarted.current = true;
    void (async () => {
      push("head", "AUTO mode — running all fixtures, will quit when done");
      await runAll();
      await invoke("force_quit").catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lineColor: Record<LogLine["kind"], string> = {
    head: "#e8b64c",
    info: "#c8cdd4",
    ok: "#7ec97e",
    err: "#e46a6a",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 44,
        right: 12,
        bottom: 12,
        width: 620,
        maxWidth: "calc(100vw - 24px)",
        display: "flex",
        flexDirection: "column",
        background: "rgba(16, 18, 22, 0.96)",
        border: "1px solid #3a4150",
        borderRadius: 8,
        zIndex: 10000,
        color: "#c8cdd4",
        font: "11px/1.5 Consolas, monospace",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid #3a4150" }}>
        <strong style={{ color: "#e8b64c" }}>mediabunny spike</strong>
        <button onClick={() => void runOne()} disabled={running} style={{ padding: "2px 10px" }}>
          pick file + run
        </button>
        <button onClick={() => void runAll()} disabled={running} style={{ padding: "2px 10px" }}>
          {running ? "running…" : "run all fixtures"}
        </button>
        <span style={{ opacity: 0.6 }}>Esc closes</span>
        <button onClick={onClose} style={{ marginLeft: "auto", padding: "2px 8px" }}>✕</button>
      </div>
      <div ref={scroller} style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {lines.current.length === 0 && (
          <div style={{ opacity: 0.6 }}>
            "run all fixtures" sweeps test-media/mediabunny-spike (generate with
            `npm run spike:media`) through both byte sources and saves RESULTS.md
            next to the fixtures. "pick file + run" tests a single file of your
            choosing. Battery: format probe, tracks, exact duration, first-frame
            decode, 8-thumbnail strip, random-seek latency, frame stepping, audio
            decode throughput.
          </div>
        )}
        {lines.current.map((l, i) => (
          <div key={i} style={{ color: lineColor[l.kind], whiteSpace: "pre-wrap" }}>{l.text}</div>
        ))}
        {figures.current.map((f, i) => (
          <CanvasFigure key={i} figure={f} />
        ))}
      </div>
    </div>
  );
}
