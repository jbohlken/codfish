import { useRef, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { MinusIcon as Minus, PlusIcon as Plus, MagnetIcon as Magnet, WaveSineIcon as WaveSine, WaveformIcon as Waveform, CrosshairIcon as Crosshair } from "@phosphor-icons/react";
import { useSignalEffect, signal, batch } from "@preact/signals";
import { invoke } from "@tauri-apps/api/core";
import { getCachedPeaks, cachePeaks, desiredBinsPerSec } from "../../lib/peaks-cache";
import { createWaveformPainter, type WaveformStyle } from "../../lib/waveform";
import { nextBoundary, clampStart, clampEnd, computeTrim, computeRoll } from "../../lib/playhead";
import {
  selectedMedia,
  selectedMediaId,
  selectedCaptionIndex,
  playbackTime,
  isPlaying,
  stepPlayhead,
  scrubbing,
  revealCaptionTick,
  zoomLevel,
  timelineScroll,
  mediaDuration,
  project,
  pushHistory,
  activeProfile,
  playingCaptionIndex,
  followPlayhead,
  warningsByCaption,
  isBatchRunning,
} from "../../store/app";
import { isUpdating } from "../UpdateNotice";
import { editingIndex, editText, commitActiveEdit } from "./CaptionPanel";
import type { CaptionBlock } from "../../types/project";
import { snapToFrame } from "../../lib/pipeline";
import type { ValidationWarning } from "../../lib/pipeline/types";
import { formatDisplayTime, type DisplayMode } from "../../lib/time";

type TimecodeCycle = "time" | "smpte" | "frames";
const VALID_MODES: TimecodeCycle[] = ["time", "smpte", "frames"];
const stored = localStorage.getItem("codfish:timecodeMode") as TimecodeCycle;
const timecodeMode = signal<TimecodeCycle>(VALID_MODES.includes(stored) ? stored : "time");
const snapEnabled = signal(true);
const storedWaveStyle = localStorage.getItem("codfish:waveformStyle");
const waveformStyle = signal<WaveformStyle>(storedWaveStyle === "bars" ? "bars" : "continuous");
const resizeIndicator = signal<number | null>(null);
const resizeSnapped = signal(false);
// True while a caption edge is being dragged — suspends timeline auto-follow so a
// trim during playback isn't disrupted by the view paging out from under it.
const isResizing = signal(false);
// While playing, a manual interaction (scroll or trim) "detaches" auto-follow so
// the view holds where you are; it re-attaches when the playhead catches up from
// behind, or on a seek/reveal. No timer — a backward look / trim sticks.
const followDetached = signal(false);

const EDGE_PAN_PX = 48;        // px from each viewport edge that triggers edge-panning
const EDGE_PAN_MAX_SPEED = 16; // px/frame at the very edge
// Edge-pan rAF loop shared by the waveform scrub and the caption-edge resize drags:
// while active() (the drag gate) and zoomed in, scroll `el` toward whichever viewport
// edge the cursor (clientX()) is within EDGE_PAN_PX of — ramping with edge depth and
// stopping at the content ends — then run onStep(clientX) so the caller re-derives
// what tracks the cursor (seek while scrubbing, trim while resizing). Returns a stop().
function startEdgePan(
  el: HTMLElement | null,
  active: () => boolean,
  clientX: () => number,
  onStep: (clientX: number) => void,
): () => void {
  let raf = requestAnimationFrame(function tick() {
    raf = requestAnimationFrame(tick);
    if (!active() || !el || zoomLevel.peek() <= 1) return;
    const rect = el.getBoundingClientRect();
    const x = clientX() - rect.left;
    let delta = 0;
    if (x < EDGE_PAN_PX) delta = -((EDGE_PAN_PX - x) / EDGE_PAN_PX) * EDGE_PAN_MAX_SPEED;
    else if (x > rect.width - EDGE_PAN_PX) delta = ((x - (rect.width - EDGE_PAN_PX)) / EDGE_PAN_PX) * EDGE_PAN_MAX_SPEED;
    if (!delta) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
    if (next === el.scrollLeft) return; // already at an end
    el.scrollLeft = next;
    onStep(clientX());
  });
  return () => cancelAnimationFrame(raf);
}

// Outer viewport width, mirrored into a signal so the virtualized ruler can
// subscribe locally — the Timeline body itself stays off the per-frame
// scroll/zoom hot path. (Scroll position lives in the store as timelineScroll so
// it's part of the per-clip view memory.)
const timelineViewport = signal(800);

export function resetTimelineView(): void {
  zoomLevel.value = 1;
  timelineScroll.value = 0;
}
type WaveformState = "idle" | "loading" | "ready" | "failed" | "no-audio";
const waveformState = signal<WaveformState>("idle");
// The sidecar/ffmpeg-reported audio length for the current clip's peaks. The
// <video> element's duration (mediaDuration) is 0 mid-switch and unreliable for
// asset:// media (the reason peaks come from the sidecar at all), so this is the
// timeline length used when the video clock hasn't reported one.
const waveformAudioDuration = signal(0);

const SNAP_THRESHOLD_PX = 8;

function trySnap(value: number, snapPoints: number[], thresholdSec: number): number | null {
  for (const point of snapPoints) {
    if (Math.abs(value - point) <= thresholdSec) return point;
  }
  return null;
}

/** Wait for the video element to report a duration via loadedmetadata.
 *  Resolves with null on timeout so callers can fall back to sidecar data
 *  rather than hang forever if the element never fires the event. */
function waitForMediaDuration(timeoutMs: number): Promise<number | null> {
  const current = mediaDuration.peek();
  if (current > 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsub(); resolve(null); }, timeoutMs);
    const unsub = mediaDuration.subscribe((v) => {
      if (v > 0) { clearTimeout(timer); unsub(); resolve(v); }
    });
  });
}

export function Timeline() {
  const media = selectedMedia.value;
  const profileDefaultFps = activeProfile.value.timing.defaultFps;
  const effectiveFps = media?.fps ?? profileDefaultFps;
  const fpsIsDetected = media != null && media.fps != null;
  // Resolve "smpte" cycle mode to the actual DisplayMode based on media's DF setting
  const smpteMode: DisplayMode = timecodeMode.value === "smpte" && media?.dropFrame
    ? "smpte-df"
    : timecodeMode.value;

  // Subscribes only to caption-boundary crossings, not every rAF tick. The
  // playhead position itself is rendered by <TimelinePlayhead> below, which
  // owns the per-tick playbackTime subscription locally.
  const playingIndex = playingCaptionIndex.value;

  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const blocksRowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<ReturnType<typeof createWaveformPainter> | null>(null);

  const captionDuration = media?.captions.length
    ? media.captions[media.captions.length - 1].end
    : 0;
  const duration = mediaDuration.value || waveformAudioDuration.value || captionDuration;
  const waveStyle = waveformStyle.value;

  // Init / reinit the waveform painter when media changes
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    const scrollEl = scrollRef.current;
    waveformAudioDuration.value = 0; // reset for the new clip; set once peaks load

    if (!canvas || !scrollEl || !media) {
      waveformState.value = "idle";
      return;
    }

    // No audio stream — don't run the peaks pipeline at all. It would just
    // fail on ffmpeg stream-missing and spam a traceback.
    if (media.hasAudio === false) {
      waveformState.value = "no-audio";
      return;
    }

    waveformState.value = "loading";

    let cancelled = false;
    // Created before the async pipeline so its first paint clears any
    // previous media's waveform while the spinner is up. The layout axis is
    // driven separately by the reactive effect below (and seeded here), so the
    // pipeline only has to supply peaks.
    const painter = createWaveformPainter({
      canvas,
      scrollEl,
      rowEl: canvas.parentElement as HTMLElement,
    });
    painterRef.current = painter;
    painter.setLayoutDuration(duration);
    painter.setStyle(waveStyle);
    painter.setColor(getComputedStyle(canvas).getPropertyValue("--tl-waveform").trim() || "#374151");

    const flog = (m: string) =>
      invoke("frontend_log", { message: `[waveform] ${m}` }).catch(() => {});

    // Peaks come from the sidecar's ffmpeg, not from a browser fetch+decode.
    // The browser-side path is unreliable for the Tauri asset protocol
    // (whole-file fetch fails for many files even though playback via range
    // requests works fine) and can't handle codecs WebAudio doesn't support.
    // On failure (no sidecar, no audio stream) drop the spinner so
    // "Generating waveform…" doesn't hang forever.
    const markFailed = (reason: string) => {
      flog(reason);
      if (!cancelled && waveformState.value !== "ready") {
        waveformState.value = "failed";
      }
    };
    flog(`init path=${media.path}`);
    (async () => {
      const mtime = await invoke<number>("file_mtime", { path: media.path });
      if (cancelled) return;
      let peaks: Float32Array;
      let audioDuration: number;
      // Look up by (path, mtime) only — independent of density, so a stale
      // <video> duration on a media switch can't cause a spurious miss.
      const cached = await getCachedPeaks(media.path, mtime);
      if (cancelled) return;
      if (cached) {
        flog(`cache hit bins=${cached.peaks.length}`);
        peaks = cached.peaks;
        audioDuration = cached.duration;
      } else {
        // Density scales with duration (denser bins for shorter files). Only
        // needed when actually generating, so we wait for the <video> metadata
        // here rather than up front — the cache lookup above doesn't need it.
        // The painter is density-agnostic, so an approximate value is fine.
        const videoDuration = await waitForMediaDuration(5000);
        if (cancelled) return;
        const binsPerSec = desiredBinsPerSec(videoDuration);
        flog(`cache miss → generate_peaks binsPerSec=${binsPerSec}`);
        const r = await invoke<{ peaks: number[]; duration: number }>(
          "generate_peaks",
          { path: media.path, binsPerSec },
        );
        if (cancelled) return;
        peaks = new Float32Array(r.peaks);
        audioDuration = r.duration;
        cachePeaks(media.path, mtime, peaks, audioDuration, binsPerSec);
        flog(`generated bins=${peaks.length} duration=${audioDuration.toFixed(2)}s`);
      }
      painter.setPeaks(peaks, audioDuration);
      waveformAudioDuration.value = audioDuration;
      waveformState.value = "ready";
      flog(`painter ready audioDuration=${audioDuration.toFixed(2)}s bins=${peaks.length}`);
    })().catch((e) => markFailed(`peaks pipeline failed: ${(e as any)?.message ?? String(e)}`));

    return () => {
      cancelled = true;
      painter.destroy();
      painterRef.current = null;
    };
  }, [media?.path]);

  // Keep the painter's layout axis on the SAME duration the ruler/blocks/playhead
  // use, so the waveform always shares their scale. Driven by a post-render effect
  // on `duration` (not a signal effect): a signal effect can fire mid-switch while
  // painterRef still points at the outgoing clip's painter, leaving the freshly
  // created painter stuck at its seed (e.g. captionDuration, when the <video> clock
  // is momentarily 0). A render effect runs once painterRef holds the new painter.
  useEffect(() => {
    painterRef.current?.setLayoutDuration(duration);
  }, [duration]);

  // Push the chosen render style to the painter (same post-render pattern as
  // duration, so it lands on the current painter after a media switch).
  useEffect(() => {
    painterRef.current?.setStyle(waveStyle);
  }, [waveStyle]);

  // Scroll- and zoom-driven repaints are owned by the painter itself: it
  // listens to the outer container's scroll and observes the waveform row
  // for size changes (zoom changes the row's width, since the scroll-inner
  // is sized at zoom × 100%).

  // Mirror the outer scroll position and viewport width into signals for
  // the virtualized ruler.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { timelineScroll.value = el.scrollLeft; };
    const measure = () => { timelineViewport.value = el.clientWidth; };
    // Don't re-read scrollLeft into the signal on a media change — openClip has
    // already set timelineScroll to the incoming clip's remembered value, and the
    // DOM restore below applies it. Reading the stale DOM here would clobber it.
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [media?.path]);

  // Restore the remembered horizontal scroll on a clip switch, after the
  // zoom-driven content width has been laid out (rAF). openClip set timelineScroll
  // to the incoming clip's value in its batch (so the persist effect stays
  // consistent); this applies it to the DOM, and the scroll listener mirrors it
  // back. Paired with zoom so a zoomed clip returns to the same region.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => { el.scrollLeft = timelineScroll.peek(); });
    return () => cancelAnimationFrame(raf);
  }, [media?.id]);

  // Auto-scroll to keep the playhead in view when it MOVES on its own — during
  // playback, or on a seek (selecting a caption in the panel, including
  // re-selecting an off-screen active one). NOT while manually scrubbing/clicking
  // the timeline: there the playhead is at the pointer and already visible, so a
  // click shouldn't jump the view. Keyed on playbackTime (+ a reveal tick);
  // mediaDuration/zoom/scrubbing are peeked so a settling duration, a zoom step
  // (which has its own playhead-anchored scroll), or the scrub-release edge don't
  // trigger it. Skipped at fit zoom and on a clip switch (the [media?.id] effect
  // restores the remembered scroll there; following the playhead would clobber it).
  const lastAutoScrollClip = useRef<string | null | undefined>(undefined);
  const lastRevealTick = useRef(0);
  // Last playback time we saw — lets us tell forward playback drift from an
  // explicit seek / backward step.
  const lastFollowTime = useRef(0);
  useSignalEffect(() => {
    const scroll = scrollRef.current;
    const time = playbackTime.value;
    // The selection ID signal — only changes on an actual clip switch. NOT the
    // selectedMedia computed: that re-emits on every caption edit, so a live
    // resize/trim would re-fire this effect and yank the view to the playhead.
    const clipId = selectedMediaId.value;
    // Same duration fallback the rest of the timeline renders with (line ~148):
    // the <video> clock (mediaDuration) is 0/unreliable for asset:// media, so fall
    // back to the sidecar audio length, then the last caption end. Peeked (like the
    // media reads above) so it doesn't re-fire the effect. Without this, auto-follow
    // was dead for any clip whose <video> never reports a duration.
    const m = selectedMedia.peek();
    const dur = mediaDuration.peek() || waveformAudioDuration.peek()
      || (m?.captions.length ? m.captions[m.captions.length - 1].end : 0);
    const zoom = zoomLevel.peek();
    // Subscribe to panel reveal requests: re-clicking an active caption bumps this
    // so we re-scroll to it even though its start is already the playhead.
    const revealTick = revealCaptionTick.value;

    // Record the clip on every pass so a switch is detected exactly once — at the
    // switch itself — even when we bail below because the duration hasn't loaded
    // yet. On the switch pass we skip: the [media?.id] effect restores the
    // remembered scroll.
    const switched = clipId !== lastAutoScrollClip.current;
    lastAutoScrollClip.current = clipId;
    // A clip switch (or project close) clears any detach carried from the previous
    // clip, so the new clip's auto-follow isn't silently suppressed — followDetached
    // is a module signal that would otherwise leak across clips.
    if (switched) followDetached.value = false;

    const isReveal = revealTick !== lastRevealTick.current;
    lastRevealTick.current = revealTick;

    // What counts as explicit navigation we should follow to (vs. forward playback
    // drift, which page-scrolls). While PAUSED, every playbackTime change is a seek
    // / frame-step / region-jump, so always treat it as navigation — otherwise a
    // small FORWARD step toward an off-left playhead has no path to reveal it, while
    // the backward step (dt<0) does. While playing, only a backward move or a big
    // forward jump is navigation; small forward deltas are drift.
    const dt = time - lastFollowTime.current;
    lastFollowTime.current = time;
    const isNav = !isPlaying.peek() || dt < -0.01 || dt > 0.5;

    // Skipped while scrubbing/clicking the timeline (peeked, so the release edge
    // doesn't fire a scroll either) — the playhead is at the pointer, in view.
    if (!scroll || !dur || zoom <= 1 || switched || scrubbing.peek() || isResizing.peek()) return;

    const totalWidth = scroll.scrollWidth;
    const visibleWidth = scroll.clientWidth;
    const playheadPx = (time / dur) * totalWidth;
    const scrollLeft = scroll.scrollLeft;

    // Explicit navigation (reveal / seek / backward step): center the playhead if
    // it's outside the comfortable band, and re-attach following.
    if (isReveal || isNav) {
      followDetached.value = false;
      if (
        playheadPx < scrollLeft + visibleWidth * 0.1 ||
        playheadPx > scrollLeft + visibleWidth * 0.85
      ) {
        scroll.scrollLeft = Math.max(0, playheadPx - visibleWidth * 0.5);
      }
      return;
    }

    // Manual scroll during playback "detaches" following (set in the wheel handler)
    // so you can dwell on an earlier — or upcoming — caption for as long as you
    // like, with no snap-back. It re-attaches only once the playhead has caught up
    // from BEHIND — i.e. it's in the LEFT half of the view (a scroll-ahead that
    // playback reached). A BACKWARD scroll pushes the playhead into the right half
    // / off the right edge, so it stays detached and the view holds (resume by
    // seeking or clicking a caption). Checking the left half — not mere visibility —
    // is what stops a back-scroll from paging forward the instant the playhead
    // crosses the right edge mid-scroll.
    const caughtUp = playheadPx >= scrollLeft && playheadPx <= scrollLeft + visibleWidth * 0.5;
    if (followDetached.peek()) {
      if (!caughtUp) return;
      followDetached.value = false;
    }

    // Forward playback = PAGE SCROLL: when the playhead advances past the right
    // edge, jump one page so it reappears near the left with a fresh page ahead.
    if (playheadPx > scrollLeft + visibleWidth * 0.9) {
      scroll.scrollLeft = Math.max(0, playheadPx - visibleWidth * 0.1);
    }
  });

  // Wheel: Ctrl → zoom, plain → horizontal scroll (vertical wheel maps to
  // horizontal since the timeline's primary axis is time). Non-passive so
  // preventDefault works for both.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
        const oldZoom = zoomLevel.peek();
        const newZoom = Math.max(1, Math.min(500, oldZoom * factor));
        if (newZoom === oldZoom) return;

        // Zoom around cursor position
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const fraction = (el.scrollLeft + mouseX) / el.scrollWidth;

        zoomLevel.value = newZoom;

        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, fraction * el.scrollWidth - mouseX);
        });
        return;
      }
      // Plain wheel → horizontal scroll. Most mice only have vertical wheel
      // and there's nothing useful to scroll vertically here.
      if (e.deltaY !== 0 && el.scrollWidth > el.clientWidth) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
        // Manual scroll during playback detaches auto-follow so the view stays put
        // wherever you scroll (see the follow effect); it re-attaches when the
        // playhead catches up from behind, or on a seek/reveal.
        if (isPlaying.peek()) followDetached.value = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [media?.path]);

  // Mousedown on waveform → seek immediately, then drag to scrub.
  // Pauses playback for the duration of the drag and resumes on release if
  // we were playing — without this, "stop moving but don't release" would
  // leave the rAF loop advancing past the scrub position.
  const handleWaveMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !duration) return;
    const el = e.currentTarget as HTMLElement;

    const scroll = scrollRef.current;
    scrubbing.value = true; // pause per-action view persistence until release
    const wasPlaying = isPlaying.peek();
    if (wasPlaying) isPlaying.value = false;

    const seekToClientX = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      playbackTime.value = Math.max(0, Math.min(duration, fraction * duration));
    };

    seekToClientX(e.clientX);

    // Edge-pan: once you've started dragging, holding the pointer near a viewport
    // edge scrolls the timeline that way (and keeps seeking under the pointer) so
    // you can scrub past what's visible. Speed ramps with how deep into the edge
    // zone the pointer is, so it stays gentle; a plain click never pans (the
    // `dragged` gate), and it stops at the content ends.
    const startX = e.clientX;
    let lastClientX = e.clientX;
    let dragged = false;
    // Edge-pan past the viewport while dragging, keeping the playhead under the
    // pointer (a plain click never pans — the `dragged` gate).
    const stopPan = startEdgePan(scroll, () => dragged, () => lastClientX, seekToClientX);

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) > 4) dragged = true;
      lastClientX = ev.clientX;
      seekToClientX(ev.clientX);
    };
    const onUp = () => {
      stopPan();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      if (wasPlaying) isPlaying.value = true;
      scrubbing.value = false; // landed — the persist effect saves the spot (if paused)
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // If focus is lost mid-drag (alt-tab / OS dialog), the mouseup can be delivered
    // to another window — end the drag on blur too so scrubbing / rAF / listeners
    // don't strand (a stranded `scrubbing` would also suppress auto-follow).
    window.addEventListener("blur", onUp);
  };

  const profile = activeProfile.value;
  const fps = media?.fps ?? profile.timing.defaultFps;
  const minGapRule = profile.timing.minGapSeconds;
  const minGap = profile.timing.minGapEnabled
    ? (minGapRule.unit === "fr" ? minGapRule.value / fps : minGapRule.value)
    : null;
  const warningsByIndex = warningsByCaption.value;

  // Live-update caption timing during drag (no history entry yet)
  const handleResizeLive = (index: number, newStart: number, newEnd: number) => {
    const proj = project.value;
    const med = selectedMedia.value; // live, not the render-time const — the
    const f = med?.fps ?? activeProfile.value.timing.defaultFps; // [/] keydown
    if (!proj || !med) return; // handler reuses this from a mount-time closure
    project.value = {
      ...proj,
      media: proj.media.map((m) =>
        m.id !== med.id ? m : {
          ...m,
          captions: m.captions.map((c) =>
            c.index !== index ? c : {
              ...c,
              start: Math.max(0, newStart),
              end: Math.max(newStart + 1 / f, newEnd),
            }
          ),
        }
      ),
    };
  };

  // Commit caption timing after drag ends → push to undo history
  const handleResizeCommit = (label = "Resize caption") => {
    if (project.value) pushHistory(project.value, label);
  };

  // Zoom in/out keeping the playhead visually stationary.
  // If the playhead is off-screen, anchors to the center of the visible area instead.
  // Reads signals via .peek() so a stable reference works from an effect-registered
  // handler — no render-scope captures to go stale.
  const zoomAroundPlayhead = (factor: number) => {
    const scroll = scrollRef.current;
    const oldZoom = zoomLevel.peek();
    const newZoom = Math.max(1, Math.min(500, oldZoom * factor));
    if (newZoom === oldZoom) return;

    const m = selectedMedia.peek();
    const capDur = m?.captions.length ? m.captions[m.captions.length - 1].end : 0;
    const liveDuration = mediaDuration.peek() || capDur;

    if (!scroll || !liveDuration) {
      zoomLevel.value = newZoom;
      return;
    }

    const playheadFraction = playbackTime.peek() / liveDuration;
    const playheadPx = playheadFraction * scroll.scrollWidth;
    const visibleWidth = scroll.clientWidth;
    const scrollLeft = scroll.scrollLeft;

    // If playhead is off-screen, anchor to visible center instead
    const isVisible = playheadPx >= scrollLeft && playheadPx <= scrollLeft + visibleWidth;
    const anchorContent = isVisible ? playheadPx : scrollLeft + visibleWidth / 2;
    const anchorScreen = anchorContent - scrollLeft;
    const anchorFraction = anchorContent / scroll.scrollWidth;

    zoomLevel.value = newZoom;

    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, anchorFraction * scroll.scrollWidth - anchorScreen);
    });
  };

  // Timeline keyboard shortcuts. Gated like the caption-panel shortcuts:
  // skipped in text inputs, with no media, during an active caption edit, or
  // while blocked (update / batch generation) — document-level keydown isn't
  // caught by the inert app-shell.
  //   G            → toggle gap snap
  //   +/-          → zoom around playhead ("=" unshifted; "+"/"_" shifted/numpad)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;
      if (isUpdating() || isBatchRunning.value) return;
      if (!selectedMedia.value) return;
      if (editingIndex.value !== null) return;
      if (e.key === "g" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        snapEnabled.value = !snapEnabled.value;
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomAroundPlayhead(1.5);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAroundPlayhead(1 / 1.5);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Step the playhead one frame, paused (Premiere-style).
        e.preventDefault();
        stepPlayhead(e.key === "ArrowRight" ? 1 : -1);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Jump to the adjacent region boundary: every caption start/end, plus the
        // timeline start (0) and end. Down → next, Up → previous.
        e.preventDefault();
        const m = selectedMedia.value;
        const dur = mediaDuration.peek() || (m?.captions.length ? m.captions[m.captions.length - 1].end : 0);
        if (!dur) return;
        isPlaying.value = false; // jumping is a paused review action
        const bounds = [0, dur];
        if (m) for (const c of m.captions) bounds.push(c.start, c.end);
        const target = nextBoundary(playbackTime.peek(), bounds, e.key === "ArrowDown" ? 1 : -1);
        if (target !== undefined) playbackTime.value = Math.max(0, Math.min(dur, target));
      } else if ((e.key === "[" || e.key === "]") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Trim the selected caption's in ([) / out (]) edge to the playhead, then
        // commit through the same path the resize-handle drag uses. Reads live.
        e.preventDefault();
        const m = selectedMedia.value;
        const idx = selectedCaptionIndex.value;
        if (!m || idx == null) return;
        const f = m.fps ?? activeProfile.value.timing.defaultFps;
        const dur = mediaDuration.peek() || (m.captions.length ? m.captions[m.captions.length - 1].end : 0);
        const trimmed = computeTrim(m.captions, idx, e.key === "[" ? "in" : "out", playbackTime.peek(), f, dur);
        if (!trimmed) return; // caption not found, or clamped to no change
        handleResizeLive(idx, trimmed.start, trimmed.end);
        if (project.value) pushHistory(project.value, e.key === "[" ? "Trim caption in" : "Trim caption out");
      } else if ((e.key === "{" || e.key === "}") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Rolling edit: { (Shift+[) rolls the cut on the selected caption's IN
        // side, } (Shift+]) the OUT side — moving BOTH flanking edges to the
        // playhead at once. Only fires when that boundary is shared (touching);
        // a gapped edge has no single cut to roll, so it's a no-op.
        e.preventDefault();
        const m = selectedMedia.value;
        const idx = selectedCaptionIndex.value;
        if (!m || idx == null) return;
        const f = m.fps ?? activeProfile.value.timing.defaultFps;
        const roll = computeRoll(m.captions, idx, e.key === "{" ? "in" : "out", playbackTime.peek(), f);
        if (!roll) return; // no shared boundary on that side, or no change
        batch(() => {
          handleResizeLive(roll.left.index, roll.left.start, roll.left.end);
          handleResizeLive(roll.right.index, roll.right.start, roll.right.end);
        });
        if (project.value) pushHistory(project.value, "Roll edit");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div class="timeline">
      {/* Timeline toolbar — only with a clip loaded: the timecode/fps readout on
          the left, view tools (snap, follow, waveform, zoom) on the right.
          Playback transport lives under the video — see <TransportBar />. */}
      {media && (
      <div class="timeline-toolbar">
        <span class="timeline-mode-label">
          {timecodeMode.value === "time" && "Time"}
          {timecodeMode.value === "smpte" && (media?.dropFrame ? "SMPTE DF" : "SMPTE")}
          {timecodeMode.value === "frames" && "Frames"}
        </span>
        <button
          class="timeline-btn timeline-btn--timecode"
          onClick={() => {
            const modes: TimecodeCycle[] = ["time", "smpte", "frames"];
            const next = modes[(modes.indexOf(timecodeMode.value) + 1) % modes.length];
            timecodeMode.value = next;
            localStorage.setItem("codfish:timecodeMode", next);
          }}
          data-tooltip="Click to cycle timecode mode"
        >
          <TransportTimecode mode={smpteMode} fps={effectiveFps} duration={duration} />
        </button>
        {media && (
          <span
            class={`timeline-fps-badge${fpsIsDetected ? "" : " timeline-fps-badge--default"}${media.vfr ? " timeline-fps-badge--vfr" : ""}`}
            data-tooltip={
              media.vfr
                ? "Variable frame rate detected — frame-snapping may be imprecise"
                : fpsIsDetected
                  ? "Detected from file"
                  : `No framerate detected — using profile default (${profileDefaultFps} fps)`
            }
          >
            {effectiveFps} fps{fpsIsDetected ? "" : "*"}{media.vfr ? " VFR" : ""}
          </span>
        )}

        <button
          class={`timeline-btn timeline-tools-start${snapEnabled.value ? " timeline-btn--active" : ""}`}
          onClick={() => { snapEnabled.value = !snapEnabled.value; }}
          data-tooltip={snapEnabled.value ? "Gap snapping on (G)" : "Gap snapping off (G)"}
        >
          <Magnet size={14} />
        </button>

        <button
          class={`timeline-btn${followPlayhead.value ? " timeline-btn--active" : ""}`}
          onClick={() => {
            followPlayhead.value = !followPlayhead.value;
            localStorage.setItem("codfish:followPlayhead", String(followPlayhead.value));
          }}
          data-tooltip={followPlayhead.value ? "Auto-select caption under playhead: on" : "Auto-select caption under playhead: off"}
        >
          <Crosshair size={14} />
        </button>

        <button
          class="timeline-btn"
          onClick={() => {
            const next: WaveformStyle = waveformStyle.value === "continuous" ? "bars" : "continuous";
            waveformStyle.value = next;
            localStorage.setItem("codfish:waveformStyle", next);
          }}
          data-tooltip={waveformStyle.value === "continuous" ? "Waveform: continuous" : "Waveform: bars"}
        >
          {waveformStyle.value === "continuous" ? <WaveSine size={14} /> : <Waveform size={14} />}
        </button>

        <ZoomControls scrollRef={scrollRef} zoomAroundPlayhead={zoomAroundPlayhead} />
      </div>
      )}

      {/* Track area */}
      <div class="timeline-track-area">
        {!media ? (
          <div class="timeline-empty">No media selected</div>
        ) : (
          <div
            class="timeline-scroll-outer"
            ref={scrollRef}
          >
            <ScrollInner>
              {/* Ruler */}
              {duration > 0 && (
                <RulerRow duration={duration} mode={smpteMode} fps={effectiveFps} onMouseDown={handleWaveMouseDown} />
              )}

              {/* Waveform row — click to seek */}
              <div
                class="timeline-waveform-row"
                onMouseDown={handleWaveMouseDown}
                style={{ cursor: "pointer" }}
              >
                <canvas ref={waveCanvasRef} class="timeline-waveform-canvas" />
                {waveformState.value === "loading" && (
                  <div class="timeline-waveform-loading">
                    <div class="timeline-waveform-loading-spinner" />
                    <span>Generating waveform…</span>
                  </div>
                )}
                {waveformState.value === "failed" && (
                  <div class="timeline-waveform-loading">
                    <span>No waveform available</span>
                  </div>
                )}
                {waveformState.value === "no-audio" && (
                  <div class="timeline-waveform-loading">
                    <span>No audio track</span>
                  </div>
                )}
                {duration > 0 && <TimelinePlayhead duration={duration} />}
                {duration > 0 && resizeIndicator.value !== null && (
                  <div
                    class={`timeline-resize-indicator${resizeSnapped.value ? " timeline-resize-indicator--snapped" : ""}`}
                    style={{ left: `${(resizeIndicator.value / duration) * 100}%` }}
                  />
                )}
              </div>

              {/* Caption blocks row */}
              <div
                ref={blocksRowRef}
                class="timeline-blocks-row"
                onClick={(e) => { if (e.target === e.currentTarget) selectedCaptionIndex.value = null; }}
              >
                {duration > 0 && media.captions.map((block, i) => (
                  <ResizableCaptionBlock
                    key={block.index}
                    block={block}
                    duration={duration}
                    fps={effectiveFps}
                    prev={media.captions[i - 1] ?? null}
                    next={media.captions[i + 1] ?? null}
                    minGap={minGap}
                    blocksRowRef={blocksRowRef}
                    scrollRef={scrollRef}
                    selected={selectedCaptionIndex.value === block.index}
                    playing={playingIndex === block.index}
                    warnings={warningsByIndex.get(block.index) ?? []}
                    onResizeLive={handleResizeLive}
                    onResizeCommit={handleResizeCommit}
                    onClick={() => {
                      selectedCaptionIndex.value = block.index;
                      playbackTime.value = block.start;
                    }}
                    onDblClick={() => {
                      selectedCaptionIndex.value = block.index;
                      isPlaying.value = false;
                      editingIndex.value = block.index;
                      editText.value = block.lines.join("\n");
                    }}
                  />
                ))}
              </div>
            </ScrollInner>
          </div>
        )}
      </div>
    </div>
  );
}

function ResizableCaptionBlock({
  block,
  duration,
  fps,
  prev,
  next,
  minGap,
  blocksRowRef,
  scrollRef,
  selected,
  playing,
  warnings,
  onResizeLive,
  onResizeCommit,
  onClick,
  onDblClick,
}: {
  block: CaptionBlock;
  duration: number;
  fps: number;
  prev: CaptionBlock | null;
  next: CaptionBlock | null;
  minGap: number | null;
  blocksRowRef: { current: HTMLDivElement | null };
  scrollRef: { current: HTMLDivElement | null };
  selected: boolean;
  playing: boolean;
  warnings: ValidationWarning[];
  onResizeLive: (index: number, start: number, end: number) => void;
  onResizeCommit: (label?: string) => void;
  onClick: () => void;
  onDblClick: () => void;
}) {
  const left = (block.start / duration) * 100;
  const width = ((block.end - block.start) / duration) * 100;

  // The trim/snap code works off the neighbours' adjacent edges; rolling also
  // needs their far edges + indices, so the component takes the whole neighbour
  // captions and derives the adjacent edges here.
  const prevEnd = prev?.end ?? null;
  const nextStart = next?.start ?? null;

  const hasStrict = warnings.some(w => w.strict);
  const hasFuzzy = warnings.some(w => !w.strict);
  const warnClass = [
    hasStrict ? "timeline-block--warning-strict" : "",
    hasFuzzy  ? "timeline-block--warning-fuzzy"  : "",
  ].filter(Boolean).join(" ");

  const startEdgeDrag = (e: MouseEvent, edge: "left" | "right") => {
    e.stopPropagation();
    // stopPropagation prevents the textarea's click-outside listener from
    // firing, so an active edit would linger through the drag and corrupt
    // state (resize history pushed with phantom caption still present, then
    // cancel reverts to pre-add and loses the resize). Commit the edit and
    // abort this drag — indices may have shifted, so require a fresh click.
    if (editingIndex.value !== null) {
      commitActiveEdit();
      return;
    }
    const rowEl = blocksRowRef.current;
    if (!rowEl) return;

    // Select the caption you grab — deterministically, here on mousedown, not via
    // the post-drag click (which is suppressed below). The playhead is left where
    // it is: a trim/roll targets the playhead, it shouldn't also move it.
    selectedCaptionIndex.value = block.index;
    // Suspend auto-follow for the duration of the interaction so playback can't page
    // the view out from under it. (Detaching follow so the view holds on release is
    // gated on actual drag movement below — a bare click must not detach.)
    isResizing.value = true;

    // After a drag, the browser fires a synthetic `click` whose target is the
    // common ancestor of the mousedown (this handle) and mouseup elements. When
    // that resolves to the block it reaches the block's onClick, which seeks the
    // playhead to the caption start and reselects — the intermittent jump the
    // handle should never cause. Swallow that one click (capture phase).
    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      document.removeEventListener("click", swallowClick, true);
    };

    const rect = rowEl.getBoundingClientRect();
    const secPerPx = duration / rect.width;
    const minDuration = 1 / fps;
    const snapThresholdSec = SNAP_THRESHOLD_PX * secPerPx;
    const originX = e.clientX;
    const originScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const originStart = block.start;
    const originEnd = block.end;
    let lastStart = originStart;
    let lastEnd = originEnd;
    let lastClientX = e.clientX;
    let dragged = false; // flips true past a small move threshold — gates pan / trim / detach

    // Shift-drag a handle sitting on a shared boundary = rolling edit: move the
    // cut between this caption and its neighbour, dragging both edges together.
    // Decided at mousedown; a gapped edge has no shared cut, so it stays a trim.
    const EPS = 1e-4;
    const rolling = e.shiftKey && (
      (edge === "left" && prev !== null && Math.abs(prev.end - originStart) < EPS) ||
      (edge === "right" && next !== null && Math.abs(next.start - originEnd) < EPS)
    );
    if (rolling) e.preventDefault(); // don't let the shift-drag select page text

    // Apply the trim/roll for a given cursor position. dx is the cursor's travel in
    // CONTENT pixels = its viewport movement plus however far we've edge-panned, so
    // the edit keeps tracking the cursor even as the timeline scrolls under it.
    const applyTrim = (clientX: number) => {
      const scroll = scrollRef.current;
      const dx = (clientX - originX) + (scroll ? scroll.scrollLeft - originScrollLeft : 0);
      if (rolling) {
        // The cut follows the cursor; computeRoll clamps it within the two
        // captions (each keeps ≥ 1 frame), snaps to a frame, and reports both edges.
        const rawCut = (edge === "left" ? originStart : originEnd) + dx * secPerPx;
        const pair = edge === "left" ? [prev!, block] : [block, next!];
        const roll = computeRoll(pair, block.index, edge === "left" ? "in" : "out", rawCut, fps);
        if (roll) {
          batch(() => {
            onResizeLive(roll.left.index, roll.left.start, roll.left.end);
            onResizeLive(roll.right.index, roll.right.start, roll.right.end);
          });
          const cut = roll.left.end; // === roll.right.start
          resizeIndicator.value = cut;
          resizeSnapped.value = false;
          if (edge === "left") lastStart = cut; else lastEnd = cut;
        }
        return;
      }
      // Live snap state — snapEnabled is a signal, read per-move (not captured) so
      // toggling gap snapping mid-drag takes effect on the active edit immediately.
      const snap = snapEnabled.peek();
      if (edge === "left") {
        let rawTime = originStart + dx * secPerPx;
        let snapped: number | null = null;
        if (snap) {
          // Dead zone + snap only when there's an actual preceding caption;
          // at the media start (prevEnd === null) the first caption can begin
          // at 0 without a minGap buffer.
          if (prevEnd !== null && minGap !== null && minGap > 0) {
            const gap = rawTime - prevEnd;
            if (gap > 0 && gap < minGap) {
              rawTime = gap < minGap / 2 ? prevEnd : snapToFrame(prevEnd + minGap, fps);
            }
          }
          if (prevEnd !== null) {
            const snapPoints = [prevEnd];
            if (minGap !== null && minGap > 0) snapPoints.push(snapToFrame(prevEnd + minGap, fps));
            snapped = trySnap(rawTime, snapPoints, snapThresholdSec);
          }
        }
        const newStart = snapped !== null
          ? clampStart(snapped, prevEnd, originEnd, minDuration)
          : snapToFrame(clampStart(rawTime, prevEnd, originEnd, minDuration), fps);
        resizeIndicator.value = newStart;
        resizeSnapped.value = snapped !== null;
        onResizeLive(block.index, newStart, originEnd);
        lastStart = newStart;
      } else {
        let rawTime = originEnd + dx * secPerPx;
        let snapped: number | null = null;
        if (snap) {
          // Dead zone + snap only when there's an actual following caption;
          // at the media end (nextStart === null) the last caption can run
          // all the way to duration without a minGap buffer.
          if (nextStart !== null && minGap !== null && minGap > 0) {
            const gap = nextStart - rawTime;
            if (gap > 0 && gap < minGap) {
              rawTime = gap < minGap / 2 ? nextStart : snapToFrame(nextStart - minGap, fps);
            }
          }
          if (nextStart !== null) {
            const snapPoints = [nextStart];
            if (minGap !== null && minGap > 0) snapPoints.push(snapToFrame(nextStart - minGap, fps));
            snapped = trySnap(rawTime, snapPoints, snapThresholdSec);
          }
        }
        const newEnd = snapped !== null
          ? clampEnd(snapped, originStart, nextStart, duration, minDuration)
          : snapToFrame(clampEnd(rawTime, originStart, nextStart, duration, minDuration), fps);
        resizeIndicator.value = newEnd;
        resizeSnapped.value = snapped !== null;
        onResizeLive(block.index, originStart, newEnd);
        lastEnd = newEnd;
      }
    };

    // Edge-pan past the viewport while dragging, re-applying the trim under the
    // cursor — the same loop the scrub uses.
    const stopPan = startEdgePan(scrollRef.current, () => dragged, () => lastClientX, applyTrim);

    const onMove = (ev: MouseEvent) => {
      lastClientX = ev.clientX;
      // Past a small threshold this is a real drag: only then detach follow,
      // edge-pan, or apply the trim — so a bare click neither moves the caption,
      // commits an undo entry, nor stops auto-follow (mirrors the scrub handler).
      if (!dragged && Math.abs(ev.clientX - originX) > 4) {
        dragged = true;
        if (isPlaying.peek()) followDetached.value = true;
      }
      if (dragged) applyTrim(ev.clientX);
    };

    const onUp = () => {
      stopPan();
      isResizing.value = false;
      resizeIndicator.value = null;
      resizeSnapped.value = false;
      // Skip commit if the final snapped values land back on the origin —
      // a drag that snaps into its starting position produced no net change.
      if (lastStart !== originStart || lastEnd !== originEnd) onResizeCommit(rolling ? "Roll edit" : undefined);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      // Eat the trailing click (registered now so it's live before the click
      // fires); tidy the listener up next tick if no click follows.
      document.addEventListener("click", swallowClick, true);
      setTimeout(() => document.removeEventListener("click", swallowClick, true), 0);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // End the drag if focus is lost mid-trim (alt-tab / OS dialog) so a stranded
    // isResizing / followDetached / rAF / listeners can't persistently suppress
    // auto-follow (see the follow effect's isResizing guard).
    window.addEventListener("blur", onUp);
  };

  return (
    <div
      class={`timeline-block${selected ? " timeline-block--selected" : ""}${playing ? " timeline-block--playing" : ""}${warnClass ? ` ${warnClass}` : ""}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      onClick={onClick}
      onDblClick={onDblClick}
    >
      <div
        class="timeline-block-handle timeline-block-handle--left"
        onMouseDown={(e) => startEdgeDrag(e, "left")}
      />
      <div class="timeline-block-label">
        {block.lines.map((line, i) => <span key={i}>{line}</span>)}
      </div>
      <div
        class="timeline-block-handle timeline-block-handle--right"
        onMouseDown={(e) => startEdgeDrag(e, "right")}
      />
    </div>
  );
}

/** Reads playbackTime locally so the parent Timeline doesn't have to
 *  subscribe to the rAF tick — only this 1-div component re-renders 60×/s. */
function TimelinePlayhead({ duration }: { duration: number }) {
  const currentTime = playbackTime.value;
  return (
    <div
      class="timeline-playhead"
      style={{ left: `${(currentTime / duration) * 100}%` }}
    />
  );
}

/** Same isolation pattern as TimelinePlayhead — owns the per-tick
 *  playbackTime read so the surrounding timeline toolbar stays static. */
function TransportTimecode({ mode, fps, duration }: {
  mode: DisplayMode;
  fps: number;
  duration: number;
}) {
  const currentTime = playbackTime.value;
  return (
    <>
      {formatDisplayTime(currentTime, mode, fps)}
      {duration > 0 ? ` / ${formatDisplayTime(duration, mode, fps)}` : ""}
    </>
  );
}

/** Subscribes to zoom/scroll/viewport locally and renders only the ticks
 *  inside the visible window (±1 screen). Without the windowing, tick
 *  count scales with zoom — tens of thousands of divs rebuilt on every
 *  zoom step; with it, renders stay at a few dozen nodes and panning
 *  re-renders only this row. */
function RulerRow({ duration, mode, fps, onMouseDown }: {
  duration: number;
  mode: DisplayMode;
  fps: number;
  onMouseDown: (e: MouseEvent) => void;
}) {
  const zoom = zoomLevel.value;
  const scrollLeft = timelineScroll.value;
  const visibleWidth = timelineViewport.value;

  const pxPerSec = (visibleWidth * zoom) / duration;
  const candidates = [1 / fps, 0.5, 1, 2, 5, 10, 30, 60, 300, 600];
  const interval = candidates.find(i => i * pxPerSec >= 60) ?? 600;

  const windowStart = Math.max(0, (scrollLeft - visibleWidth) / pxPerSec);
  const windowEnd = Math.min(duration, (scrollLeft + 2 * visibleWidth) / pxPerSec);

  const ticks: number[] = [];
  for (
    let t = Math.floor(windowStart / interval) * interval;
    t <= windowEnd + interval * 0.01;
    t += interval
  ) {
    ticks.push(Math.min(t, duration));
  }

  return (
    <div class="timeline-ruler-row" onMouseDown={onMouseDown}>
      {ticks.map(t => (
        <div
          key={t}
          class="timeline-ruler-tick"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          <span class="timeline-ruler-label">{formatDisplayTime(t, mode, fps)}</span>
        </div>
      ))}
    </div>
  );
}

/** Owns the zoom → content-width binding. The children vnodes are created
 *  by the zoom-independent Timeline render and passed through unchanged,
 *  so a zoom step re-renders this wrapper but Preact bails out of the
 *  child subtree on vnode identity — caption blocks never re-diff. */
function ScrollInner({ children }: { children: ComponentChildren }) {
  const zoom = zoomLevel.value;
  return (
    <div
      class="timeline-scroll-inner"
      style={{ width: zoom <= 1 ? "100%" : `${zoom * 100}%` }}
    >
      {children}
    </div>
  );
}

/** Reads zoomLevel locally so zoom steps re-render three buttons, not the
 *  whole timeline toolbar. */
function ZoomControls({ scrollRef, zoomAroundPlayhead }: {
  scrollRef: { current: HTMLDivElement | null };
  zoomAroundPlayhead: (factor: number) => void;
}) {
  const zoom = zoomLevel.value;
  return (
    <div class="timeline-zoom-controls">
      <button
        class="timeline-btn timeline-btn--sm"
        onClick={() => zoomAroundPlayhead(1 / 1.5)}
        data-tooltip="Zoom out (− or Ctrl/Cmd+Scroll)"
        disabled={zoom <= 1}
      ><Minus size={12} /></button>
      <button
        class="timeline-btn timeline-btn--zoom-label"
        onClick={() => {
          zoomLevel.value = 1;
          if (scrollRef.current) scrollRef.current.scrollLeft = 0;
        }}
        data-tooltip="Reset zoom to fit"
      >
        {zoom > 1 ? `${zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1)}×` : "Fit"}
      </button>
      <button
        class="timeline-btn timeline-btn--sm"
        onClick={() => zoomAroundPlayhead(1.5)}
        data-tooltip="Zoom in (+ or Ctrl/Cmd+Scroll)"
      ><Plus size={12} /></button>
    </div>
  );
}

