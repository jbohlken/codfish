import { useRef, useEffect } from "preact/hooks";
import { SkipBackIcon as SkipBack, PlayIcon as Play, PauseIcon as Pause, MinusIcon as Minus, PlusIcon as Plus } from "@phosphor-icons/react";
import { useSignalEffect, signal } from "@preact/signals";
import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  selectedMedia,
  selectedCaptionIndex,
  playbackTime,
  isPlaying,
  mediaDuration,
  project,
  pushHistory,
  activeProfile,
} from "../../store/app";
import type { CaptionBlock } from "../../types/project";
import { snapToFrame } from "../../lib/pipeline";
import { validate } from "../../lib/pipeline/validate";
import type { ValidationWarning } from "../../lib/pipeline/types";

type TimecodeMode = "time" | "smpte" | "frames";
const timecodeMode = signal<TimecodeMode>("time");
const resizeIndicator = signal<number | null>(null);
const zoomLevel = signal(1);

export function Timeline() {
  const media = selectedMedia.value;
  const currentTime = playbackTime.value;
  const playing = isPlaying.value;
  const profileDefaultFps = activeProfile.value.timing.defaultFps;
  const effectiveFps = media?.fps ?? profileDefaultFps;
  const fpsIsDetected = media != null && media.fps != null;

  const playingIndex = media?.captions.find(
    (c) => currentTime >= c.start && currentTime < c.end
  )?.index ?? null;

  const waveCanvasRef = useRef<HTMLDivElement>(null);
  const blocksRowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

  const captionDuration = media?.captions.length
    ? media.captions[media.captions.length - 1].end
    : 0;
  const duration = mediaDuration.value || captionDuration;

  // Init / reinit WaveSurfer when media changes
  useEffect(() => {
    const container = waveCanvasRef.current;
    wsRef.current?.destroy();
    wsRef.current = null;

    if (!container || !media) return;

    const ws = WaveSurfer.create({
      container,
      waveColor: "#374151",
      progressColor: "#4b5563",
      height: "auto" as any,
      normalize: true,
      interact: false,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
    });

    ws.load(convertFileSrc(media.path)).catch(() => {});

    // Sync zoom once audio is decoded and duration is known
    ws.on("ready", () => {
      const dur = ws.getDuration();
      if (!dur) return;
      const visibleWidth = scrollRef.current?.clientWidth ?? 800;
      ws.zoom((visibleWidth * zoomLevel.peek()) / dur);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [media?.path]);

  // Sync zoomLevel → WaveSurfer pxPerSec, then re-sync its internal scroll
  useSignalEffect(() => {
    const ws = wsRef.current;
    const zoom = zoomLevel.value;
    const dur = mediaDuration.value;
    if (!ws || !dur) return;
    const visibleWidth = scrollRef.current?.clientWidth ?? 800;
    ws.zoom((visibleWidth * zoom) / dur);
    requestAnimationFrame(() => syncWsScroll());
  });

  // WaveSurfer renders only its internally "visible" region. Our outer scroll
  // container moves the content without WaveSurfer knowing, so we push our
  // scrollLeft into WaveSurfer's own scroll container after every scroll event.
  const syncWsScroll = () => {
    const wsScroll = waveCanvasRef.current?.firstElementChild as HTMLElement | null;
    const outer = scrollRef.current;
    if (wsScroll && outer) wsScroll.scrollLeft = outer.scrollLeft;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", syncWsScroll, { passive: true });
    return () => el.removeEventListener("scroll", syncWsScroll);
  }, [media?.path]);

  // Sync playbackTime → WaveSurfer visual cursor
  useSignalEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const dur = ws.getDuration();
    if (!dur) return;
    ws.seekTo(playbackTime.value / dur);
  });

  // Auto-scroll to keep playhead in view during playback
  useSignalEffect(() => {
    const scroll = scrollRef.current;
    const time = playbackTime.value;
    const dur = mediaDuration.value;
    const isCurrentlyPlaying = isPlaying.value;
    const zoom = zoomLevel.value;

    if (!scroll || !dur || zoom <= 1 || !isCurrentlyPlaying) return;

    const fraction = time / dur;
    const totalWidth = scroll.scrollWidth;
    const visibleWidth = scroll.clientWidth;
    const playheadPx = fraction * totalWidth;
    const scrollLeft = scroll.scrollLeft;

    if (
      playheadPx < scrollLeft + visibleWidth * 0.1 ||
      playheadPx > scrollLeft + visibleWidth * 0.85
    ) {
      scroll.scrollLeft = Math.max(0, playheadPx - visibleWidth * 0.5);
    }
  });

  // Ctrl+Wheel → zoom (non-passive so preventDefault works)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
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
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [media?.path]);

  // Mousedown on waveform → seek immediately, then drag to scrub
  const handleWaveMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !duration) return;
    const el = e.currentTarget as HTMLElement;

    const seek = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const fraction = (ev.clientX - rect.left) / rect.width;
      playbackTime.value = Math.max(0, Math.min(duration, fraction * duration));
    };

    seek(e);

    const onMove = (ev: MouseEvent) => seek(ev);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Live-update caption timing during drag (no history entry yet)
  const handleResizeLive = (index: number, newStart: number, newEnd: number) => {
    const proj = project.value;
    if (!proj || !media) return;
    project.value = {
      ...proj,
      media: proj.media.map((m) =>
        m.id !== media.id ? m : {
          ...m,
          captions: m.captions.map((c) =>
            c.index !== index ? c : {
              ...c,
              start: Math.max(0, newStart),
              end: Math.max(newStart + 0.1, newEnd),
            }
          ),
        }
      ),
    };
  };

  // Commit caption timing after drag ends → push to undo history
  const handleResizeCommit = () => {
    if (project.value) pushHistory(project.value, "Resize caption");
  };

  const zoom = zoomLevel.value;

  const profile = activeProfile.value;
  const warningsByIndex = new Map<number, ValidationWarning[]>();
  if (media) {
    const report = validate(media.captions, profile, media.fps ?? undefined);
    for (const w of report.warnings) {
      const arr = warningsByIndex.get(w.blockIndex) ?? [];
      arr.push(w);
      warningsByIndex.set(w.blockIndex, arr);
    }
  }

  // Zoom in/out keeping the playhead visually stationary.
  // If the playhead is off-screen, anchors to the center of the visible area instead.
  const zoomAroundPlayhead = (factor: number) => {
    const scroll = scrollRef.current;
    const oldZoom = zoomLevel.peek();
    const newZoom = Math.max(1, Math.min(500, oldZoom * factor));
    if (newZoom === oldZoom) return;

    if (!scroll || !duration) {
      zoomLevel.value = newZoom;
      return;
    }

    const playheadFraction = currentTime / duration;
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

  return (
    <div class="timeline">
      {/* Transport controls */}
      <div class="timeline-transport">
        <button
          class="timeline-btn"
          onClick={() => { playbackTime.value = 0; }}
          data-tooltip="Go to start"
        ><SkipBack size={14} weight="fill" /></button>
        <button
          class="timeline-btn timeline-btn--play"
          onClick={() => { isPlaying.value = !playing; }}
          data-tooltip={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
        </button>
        <span class="timeline-mode-label">
          {timecodeMode.value === "time" && "Time"}
          {timecodeMode.value === "smpte" && "SMPTE"}
          {timecodeMode.value === "frames" && "Frames"}
        </span>
        <button
          class="timeline-btn timeline-btn--timecode"
          onClick={() => {
            const modes: TimecodeMode[] = ["time", "smpte", "frames"];
            const next = modes[(modes.indexOf(timecodeMode.value) + 1) % modes.length];
            timecodeMode.value = next;
          }}
          data-tooltip="Click to cycle timecode mode"
        >
          {formatTime(currentTime, timecodeMode.value, effectiveFps)}
          {duration > 0 ? ` / ${formatTime(duration, timecodeMode.value, effectiveFps)}` : ""}
        </button>
        {media && (
          <span
            class={`timeline-fps-badge${fpsIsDetected ? "" : " timeline-fps-badge--default"}`}
            data-tooltip={fpsIsDetected ? "Detected from file" : `No framerate detected — using profile default (${profileDefaultFps} fps)`}
          >
            {effectiveFps} fps{fpsIsDetected ? "" : "*"}
          </span>
        )}

        {/* Zoom controls */}
        <div class="timeline-zoom-controls">
          <button
            class="timeline-btn timeline-btn--sm"
            onClick={() => zoomAroundPlayhead(1 / 1.5)}
            data-tooltip="Zoom out (Ctrl+Scroll)"
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
            data-tooltip="Zoom in (Ctrl+Scroll)"
          ><Plus size={12} /></button>
        </div>
      </div>

      {/* Track area */}
      <div class="timeline-track-area">
        {!media ? (
          <div class="timeline-empty">No media selected</div>
        ) : (
          <div
            class="timeline-scroll-outer"
            ref={scrollRef}
          >
            <div
              class="timeline-scroll-inner"
              style={{ width: zoom <= 1 ? "100%" : `${zoom * 100}%` }}
            >
              {/* Ruler */}
              {duration > 0 && (
                <RulerRow
                  duration={duration}
                  zoom={zoom}
                  visibleWidth={scrollRef.current?.clientWidth ?? 800}
                  mode={timecodeMode.value}
                  fps={effectiveFps}
                />
              )}

              {/* Waveform row — click to seek */}
              <div
                class="timeline-waveform-row"
                onMouseDown={handleWaveMouseDown}
                style={{ cursor: "pointer" }}
              >
                <div ref={waveCanvasRef} style={{ width: "100%", height: "100%" }} />
                {duration > 0 && (
                  <div
                    class="timeline-playhead"
                    style={{ left: `${(currentTime / duration) * 100}%` }}
                  />
                )}
                {duration > 0 && resizeIndicator.value !== null && (
                  <div
                    class="timeline-resize-indicator"
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
                    prevEnd={media.captions[i - 1]?.end ?? 0}
                    nextStart={media.captions[i + 1]?.start ?? duration}
                    blocksRowRef={blocksRowRef}
                    selected={selectedCaptionIndex.value === block.index}
                    playing={playingIndex === block.index}
                    warnings={warningsByIndex.get(block.index) ?? []}
                    onResizeLive={handleResizeLive}
                    onResizeCommit={handleResizeCommit}
                    onClick={() => {
                      selectedCaptionIndex.value = block.index;
                      playbackTime.value = block.start;
                    }}
                  />
                ))}
              </div>
            </div>
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
  prevEnd,
  nextStart,
  blocksRowRef,
  selected,
  playing,
  warnings,
  onResizeLive,
  onResizeCommit,
  onClick,
}: {
  block: CaptionBlock;
  duration: number;
  fps: number;
  prevEnd: number;
  nextStart: number;
  blocksRowRef: { current: HTMLDivElement | null };
  selected: boolean;
  playing: boolean;
  warnings: ValidationWarning[];
  onResizeLive: (index: number, start: number, end: number) => void;
  onResizeCommit: () => void;
  onClick: () => void;
}) {
  const left = (block.start / duration) * 100;
  const width = ((block.end - block.start) / duration) * 100;

  const hasStrict = warnings.some(w => w.strict);
  const hasFuzzy = warnings.some(w => !w.strict);
  const warnClass = [
    hasStrict ? "timeline-block--warning-strict" : "",
    hasFuzzy  ? "timeline-block--warning-fuzzy"  : "",
  ].filter(Boolean).join(" ");

  const startEdgeDrag = (e: MouseEvent, edge: "left" | "right") => {
    e.stopPropagation();
    const rowEl = blocksRowRef.current;
    if (!rowEl) return;

    // getBoundingClientRect accounts for scroll offset, so secPerPx is correct at any zoom
    const rect = rowEl.getBoundingClientRect();
    const secPerPx = duration / rect.width;
    const minDuration = 1 / fps;
    const originX = e.clientX;
    const originStart = block.start;
    const originEnd = block.end;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - originX;
      if (edge === "left") {
        const newStart = snapToFrame(Math.max(prevEnd, Math.min(originStart + dx * secPerPx, originEnd - minDuration)), fps);
        resizeIndicator.value = newStart;
        onResizeLive(block.index, newStart, originEnd);
      } else {
        const newEnd = snapToFrame(Math.max(originStart + minDuration, Math.min(originEnd + dx * secPerPx, nextStart)), fps);
        resizeIndicator.value = newEnd;
        onResizeLive(block.index, originStart, newEnd);
      }
    };

    const onUp = () => {
      resizeIndicator.value = null;
      onResizeCommit();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      class={`timeline-block${selected ? " timeline-block--selected" : ""}${playing ? " timeline-block--playing" : ""}${warnClass ? ` ${warnClass}` : ""}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      onClick={onClick}
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

function RulerRow({ duration, zoom, visibleWidth, mode, fps }: {
  duration: number;
  zoom: number;
  visibleWidth: number;
  mode: TimecodeMode;
  fps: number;
}) {
  const pxPerSec = (visibleWidth * zoom) / duration;
  const candidates = [1 / fps, 0.5, 1, 2, 5, 10, 30, 60, 300, 600];
  const interval = candidates.find(i => i * pxPerSec >= 60) ?? 600;

  const ticks: number[] = [];
  for (let t = 0; t <= duration + interval * 0.01; t += interval) {
    ticks.push(Math.min(t, duration));
  }

  return (
    <div class="timeline-ruler-row">
      {ticks.map(t => (
        <div
          key={t}
          class="timeline-ruler-tick"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          <span class="timeline-ruler-label">{formatTime(t, mode, fps)}</span>
        </div>
      ))}
    </div>
  );
}

function formatTime(seconds: number, mode: TimecodeMode, fps: number): string {
  switch (mode) {
    case "time": {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
      }
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    }
    case "smpte": {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const f = Math.floor((seconds % 1) * fps);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
    }
    case "frames": {
      return `${Math.floor(seconds * fps)}f`;
    }
  }
}
