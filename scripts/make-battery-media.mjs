#!/usr/bin/env node
// Generates the synthetic media fixture suite for the media battery into
// test-media/battery/ (gitignored — this script is the source of
// truth; re-run it anywhere instead of copying files around). Each fixture
// targets one question: a container/codec the <video> element can't play, an
// edge case from codfish's bug history (VBR duration, moov-at-end, rotation,
// VFR), or a deliberate failure (AVI). See the generated README.md for the
// full matrix. Requires ffmpeg + ffprobe on PATH.
//
// Usage: node scripts/make-battery-media.mjs   (or: npm run battery:media)

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-media", "battery");
mkdirSync(OUT, { recursive: true });

// Pulsing two-tone stereo so waveforms have visible shape, 48 kHz.
const TONE =
  "aevalsrc=0.28*(0.55+0.45*sin(2*PI*t*0.7))*sin(440*2*PI*t)|"
  + "0.28*(0.55+0.45*sin(2*PI*t*0.9))*sin(587*2*PI*t):s=48000:c=stereo";
const VSRC = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"];
const ASRC = ["-f", "lavfi", "-i", TONE];
const AV = [...VSRC, ...ASRC];
const AAC = ["-c:a", "aac", "-b:a", "128k"];
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"];

const results = [];

function ff(label, args, { tool = "ffmpeg" } = {}) {
  const res = spawnSync(tool, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: OUT,
    encoding: "utf8",
    // ffprobe JSON for long files can exceed the default 1 MB buffer
    maxBuffer: 32 * 1024 * 1024,
  });
  const ok = res.status === 0;
  if (label) results.push({ label, ok, err: ok ? "" : (res.stderr || res.error?.message || "").trim() });
  return res;
}

const make = (name, args) => ff(name, [...args, "-t", "5", name]);

// ── Controls ─────────────────────────────────────────────────────────────────
make("control-h264-aac.mp4", [...AV, ...X264, ...AAC, "-movflags", "+faststart"]);
make("control-vp9-opus.webm", [...AV, "-c:v", "libvpx-vp9", "-b:v", "400k", "-cpu-used", "5", "-c:a", "libopus", "-b:a", "96k"]);

// ── Playable only via mediabunny (WebView2 rejects the container/codec) ──────
make("prores-hq-pcm.mov", [...AV, "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"]);
make("prores-proxy-aac.mov", [...AV, "-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", ...AAC]);
make("h264-aac.mkv", [...AV, ...X264, ...AAC]);
make("h264-aac.ts", [...AV, ...X264, ...AAC, "-f", "mpegts"]);
make("aac.m4a", [...ASRC, ...AAC, "-vn"]);
make("ac3-h264.mp4", [...AV, ...X264, "-c:a", "ac3", "-b:a", "192k"]); // @mediabunny/ac3
make("eac3-h264.ts", [...AV, ...X264, "-c:a", "eac3", "-b:a", "192k", "-f", "mpegts"]); // @mediabunny/ac3

// ── Codec-availability probes (decoder depends on OS/WebCodecs build) ────────
make("hevc-aac.mp4", [...AV, "-c:v", "libx265", "-preset", "fast", "-crf", "30", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", ...AAC]);
make("av1-aac.mp4", [...AV, "-c:v", "libsvtav1", "-preset", "12", "-crf", "45", "-pix_fmt", "yuv420p", ...AAC]);

// ── Edge cases from codfish's bug history ────────────────────────────────────
// moov at end (ffmpeg's default): the "duration is Infinity/NaN at first
// loadedmetadata" case from VideoPanel.tsx.
make("nofaststart-h264-aac.mp4", [...AV, ...X264, ...AAC]);

// 90° display-matrix rotation: CanvasSink should auto-rotate like <video> does.
{
  const rot = ff("rotated90-h264-aac.mp4",
    ["-display_rotation", "90", "-i", "control-h264-aac.mp4", "-c", "copy", "rotated90-h264-aac.mp4"]);
  if (rot.status !== 0) {
    // Older ffmpeg: fall back to the deprecated rotate tag.
    results.pop();
    ff("rotated90-h264-aac.mp4 (rotate-tag fallback)",
      ["-i", "control-h264-aac.mp4", "-c", "copy", "-metadata:s:v", "rotate=90", "rotated90-h264-aac.mp4"]);
  }
}

// True VFR: 3 s @ 24 fps + 3 s @ 60 fps stream-copied together — frame
// durations change mid-file (the FR7 waveform/caption drift case).
{
  // Shared timescale (divisible by 24 and 60) so the stream-copy concat keeps
  // true frame timing instead of rescaling the second segment.
  const TS = ["-video_track_timescale", "15360"];
  ff(null, [...VSRC.slice(0, 2), "-i", "testsrc2=size=640x360:rate=24", ...X264, ...TS, "-t", "3", "_seg24.mp4"]);
  ff(null, [...VSRC.slice(0, 2), "-i", "testsrc2=size=640x360:rate=60", ...X264, ...TS, "-t", "3", "_seg60.mp4"]);
  writeFileSync(join(OUT, "_concat.txt"), "file '_seg24.mp4'\nfile '_seg60.mp4'\n");
  ff("vfr-h264.mp4", ["-f", "concat", "-safe", "0", "-i", "_concat.txt", "-c", "copy", "vfr-h264.mp4"]);

  // FR7 alignment fixture: the same VFR video plus sharp 1 kHz clicks at
  // t = 0.5, 1.5, …, 5.5 s (60 ms bursts). testsrc2 burns a running clock into
  // the frames, so waveform clicks, ruler ticks, captions, and on-frame time
  // can be cross-checked directly at any zoom — before AND after the 3 s
  // 24→60 fps switch.
  ff("vfr-clicks-h264-aac.mp4", [
    "-i", "vfr-h264.mp4",
    "-f", "lavfi", "-i", "aevalsrc=0.85*sin(2*PI*1000*t)*lt(mod(t+0.5\\,1)\\,0.06):s=48000",
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...AAC, "-t", "6",
    "vfr-clicks-h264-aac.mp4",
  ]);

  for (const f of ["_seg24.mp4", "_seg60.mp4", "_concat.txt"]) rmSync(join(OUT, f), { force: true });
}

// VBR MP3: the element-duration-overestimate case. CBR as control.
make("vbr.mp3", [...ASRC, "-c:a", "libmp3lame", "-q:a", "5"]);
make("cbr.mp3", [...ASRC, "-c:a", "libmp3lame", "-b:a", "128k"]);

// MP3 with attached cover art (probe_fps skips attached_pic; make sure
// mediabunny doesn't surface it as a real video track either).
{
  ff(null, ["-f", "lavfi", "-i", "testsrc2=size=300x300:rate=1", "-frames:v", "1", "_cover.png"]);
  ff("coverart-vbr.mp3", [
    ...ASRC, "-i", "_cover.png", "-map", "0:a", "-map", "1:v",
    "-c:a", "libmp3lame", "-q:a", "5", "-c:v", "png", "-id3v2_version", "3",
    "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)",
    "-t", "5", "coverart-vbr.mp3",
  ]);
  rmSync(join(OUT, "_cover.png"), { force: true });
}

// ── Remaining audio containers from the app's accept list ────────────────────
make("pcm16.wav", [...ASRC, "-c:a", "pcm_s16le"]);
make("lossless.flac", [...ASRC, "-c:a", "flac"]);
make("vorbis.ogg", [...ASRC, "-c:a", "libvorbis", "-q:a", "4"]);
make("opus.opus", [...ASRC, "-c:a", "libopus", "-b:a", "96k"]);
make("adts.aac", [...ASRC, ...AAC, "-f", "adts"]);

// ── Long-duration audio (issue #44: per-format SEEK cost, not chunk shape) ──
// MP3 is index-less — finding a deep position means walking frame headers;
// WAV is sample-addressable O(1). Invisible on 5 s fixtures; these make the
// battery's grain probe measure cold/warm fetch latency at t≈250 s.
ff("long-vbr.mp3", [...ASRC, "-c:a", "libmp3lame", "-q:a", "5", "-t", "300", "long-vbr.mp3"]);
ff("long-pcm16.wav", [...ASRC, "-c:a", "pcm_s16le", "-t", "300", "long-pcm16.wav"]);

// ── Subtitle track (caption-editor context: mediabunny lists it as a track) ──
{
  writeFileSync(join(OUT, "_subs.srt"),
    "1\n00:00:00,500 --> 00:00:02,000\nFirst caption\n\n"
    + "2\n00:00:02,200 --> 00:00:03,800\nSecond caption\n\n"
    + "3\n00:00:04,000 --> 00:00:04,900\nThird caption\n");
  ff("subs-h264-aac.mkv", [...AV, "-i", "_subs.srt", "-map", "0:v", "-map", "1:a", "-map", "2:s",
    ...X264, ...AAC, "-c:s", "srt", "-t", "5", "subs-h264-aac.mkv"]);
  rmSync(join(OUT, "_subs.srt"), { force: true });
}

// ── Expected failure: container mediabunny does not support ──────────────────
make("unsupported-mpeg4-mp3.avi", [...AV, "-c:v", "mpeg4", "-qscale:v", "8", "-c:a", "libmp3lame", "-b:a", "128k"]);

// ── Verify with ffprobe and report ───────────────────────────────────────────
console.log("\nfixture                          size      probe");
console.log("-".repeat(78));
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.log(`${r.label.padEnd(32)} FAILED: ${r.err.split("\n")[0]}`);
    continue;
  }
  const path = join(OUT, r.label.split(" ")[0]);
  if (!existsSync(path)) {
    failed++;
    console.log(`${r.label.padEnd(32)} MISSING`);
    continue;
  }
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type,codec_name",
    "-of", "json", path,
  ], { encoding: "utf8" });
  let desc = "unprobeable";
  try {
    const info = JSON.parse(probe.stdout);
    const streams = (info.streams ?? []).map((s) => `${s.codec_type[0]}:${s.codec_name}`).join(" ");
    desc = `${streams} · ${Number(info.format?.duration ?? 0).toFixed(2)}s`;
  } catch { failed++; }
  const mb = (statSync(path).size / 1e6).toFixed(2).padStart(7);
  console.log(`${r.label.padEnd(32)} ${mb} MB  ${desc}`);
}

writeFileSync(join(OUT, "README.md"), `# battery fixtures

Synthetic files generated by \`npm run battery:media\` (scripts/make-battery-media.mjs).
Regenerate at will — nothing here is checked in. Open the app in dev, hit
Ctrl+Shift+B, and run each file through the battery.

| File | What it tests | Today (\`<video>\`) | Expected with mediabunny |
|---|---|---|---|
| control-h264-aac.mp4 | Baseline sanity + timing reference | plays | reads + decodes |
| control-vp9-opus.webm | WebM baseline | plays | reads + decodes |
| prores-hq-pcm.mov | **ProRes HQ decode via @mediabunny/prores** | black frame (audio via sidecar only) | decodes |
| prores-proxy-aac.mov | ProRes Proxy variant + AAC-in-MOV | black frame | decodes |
| h264-aac.mkv | Matroska container (dropped from app support) | rejected | reads + decodes |
| h264-aac.ts | MPEG-TS container | rejected | reads + decodes |
| aac.m4a | m4a (WebView2 MEDIA_ERR_SRC_NOT_SUPPORTED) | rejected | reads + decodes |
| ac3-h264.mp4 | AC-3 audio via @mediabunny/ac3 | no audio | decodes |
| eac3-h264.ts | E-AC-3 audio via @mediabunny/ac3 | rejected | decodes |
| hevc-aac.mp4 | HEVC — depends on OS decoder; watch canDecode() | plays iff HEVC ext installed | canDecode() reports truthfully |
| av1-aac.mp4 | AV1 (Chromium ships dav1d) | plays | decodes |
| nofaststart-h264-aac.mp4 | moov-at-end (the Infinity-duration bug) | provisional/Infinity duration | exact duration |
| rotated90-h264-aac.mp4 | 90° display-matrix rotation | rotated by element | CanvasSink auto-rotates; getRotation()=90 |
| vfr-h264.mp4 | True VFR, 24→60 fps mid-file (FR7 drift) | fps guess wrong | real per-frame timestamps |
| vfr-clicks-h264-aac.mp4 | **FR7 alignment test**: VFR video + 1 kHz clicks at 0.5+k s; testsrc2 burns a clock into frames | drift suspected | waveform clicks sit on ruler half-second marks at every zoom, both sides of the 3 s rate switch |
| vbr.mp3 | VBR duration overestimate bug | duration runs long | exact duration |
| cbr.mp3 | CBR control | plays | reads + decodes |
| coverart-vbr.mp3 | Attached cover art (probe skips attached_pic) | plays | no phantom video track |
| pcm16.wav / lossless.flac / vorbis.ogg / opus.opus / adts.aac | Remaining audio containers | wav/flac/ogg play; adts varies | all read + decode (PCM built-in) |
| subs-h264-aac.mkv | Embedded SRT subtitle track | rejected (mkv) | track list shows video, audio, subtitle |
| unsupported-mpeg4-mp3.avi | **Expected failure** — AVI unsupported by mediabunny too | rejected | explicit UnsupportedInputFormatError |

Things worth comparing across the two byte sources (UrlSource vs Rust IPC):
recognize-format time, random-seek latency median, and IPC call count on the
moov-at-end file (the demuxer has to hop to the tail — a good read-pattern test).
`);

console.log(`\n${results.length - failed}/${results.length} fixtures OK → ${OUT}`);
process.exit(failed ? 1 : 0);
