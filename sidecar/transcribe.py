#!/usr/bin/env python3
"""
Codfish transcription sidecar — daemon mode.

Long-lived process. Reads JSON Lines requests on stdin, writes JSON Lines
responses and events on stdout. stderr is a free-form log channel.

Protocol
--------
Boot:
    {"event": "booting"}
    {"event": "ready"}            # heavy imports done, ready for requests

Request:
    {"id": "<rid>", "op": "probe_fps", "params": {"path": "..."}}
    {"id": "<rid>", "op": "transcribe", "params": {"path": "...", "model": "base", "language": ""}}

Response:
    {"id": "<rid>", "ok": true, "result": {...}}
    {"id": "<rid>", "ok": false, "error": "..."}

Streaming events (transcribe):
    {"id": "<rid>", "event": "progress", "percent": 42, "message": "..."}
"""

import sys
import os
import io
import json
import contextlib
import traceback
from pathlib import Path

# ── stdout protocol setup ─────────────────────────────────────────────────────
# Force UTF-8 so non-ASCII paths don't blow up on Windows.
try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# Save the real stdout — only protocol writes go here. Everything else
# (library prints, tqdm, warnings) gets redirected to stderr so it can't
# corrupt the JSON Lines stream.
_PROTO_STDOUT = sys.stdout


def emit(obj: dict):
    _PROTO_STDOUT.write(json.dumps(obj) + "\n")
    _PROTO_STDOUT.flush()


def log(msg: str):
    print(msg, file=sys.stderr, flush=True)


# ── ffmpeg discovery ──────────────────────────────────────────────────────────
def ensure_ffmpeg_on_path():
    import shutil

    if getattr(sys, "frozen", False):
        bundle_dir = Path(sys._MEIPASS)
        for candidate in [bundle_dir / "ffmpeg.exe", bundle_dir / "ffmpeg"]:
            if candidate.is_file():
                os.environ["PATH"] = str(bundle_dir) + os.pathsep + os.environ.get("PATH", "")
                return

    script_dir = Path(__file__).parent
    ffmpeg_dir = script_dir / "ffmpeg"
    if ffmpeg_dir.is_dir():
        for candidate in [ffmpeg_dir / "ffmpeg.exe", ffmpeg_dir / "ffmpeg"]:
            if candidate.is_file():
                os.environ["PATH"] = str(ffmpeg_dir) + os.pathsep + os.environ.get("PATH", "")
                return

    if not shutil.which("ffmpeg"):
        # Defer the error to the first request — we still need to boot so the
        # parent gets a "ready" event and can show a useful message.
        log("WARNING: ffmpeg not found on PATH or in bundle")


# ── boot: heavy imports ───────────────────────────────────────────────────────
emit({"event": "booting"})
ensure_ffmpeg_on_path()

# Redirect stdout during heavy imports so any stray prints from torch /
# whisperx / numba etc. don't poison the protocol channel.
with contextlib.redirect_stdout(sys.stderr):
    import warnings
    warnings.filterwarnings("ignore")
    import subprocess  # noqa: E402
    import torch  # noqa: E402
    import whisperx  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"

# Lazily-populated model cache: model_id -> loaded whisperx model
_MODEL_CACHE: dict = {}

emit({"event": "ready", "device": DEVICE})


# ── HF cache helpers (unchanged) ──────────────────────────────────────────────
def hf_cache_root() -> Path:
    if hf_home := os.environ.get("HF_HOME"):
        return Path(hf_home) / "hub"
    if xdg := os.environ.get("XDG_CACHE_HOME"):
        base = Path(xdg)
    else:
        base = Path.home() / ".cache"
    return base / "huggingface" / "hub"


def is_model_cached(model_id: str) -> bool:
    snapshots = hf_cache_root() / f"models--Systran--faster-whisper-{model_id}" / "snapshots"
    try:
        for snapshot_dir in snapshots.iterdir():
            if (snapshot_dir / "model.bin").exists():
                return True
        return False
    except (FileNotFoundError, PermissionError):
        return False


def download_model_with_progress(rid: str, model_id: str, percent_start: int, percent_end: int):
    from huggingface_hub import snapshot_download
    import threading
    import time

    repo_id = f"Systran/faster-whisper-{model_id}"
    progress(rid, percent_start, f"Downloading {model_id} model from HuggingFace…")

    result = {"done": False, "error": None}

    def do_download():
        try:
            with contextlib.redirect_stdout(sys.stderr):
                snapshot_download(repo_id, local_files_only=False, local_dir_use_symlinks=False)
        except Exception as e:
            result["error"] = e
        finally:
            result["done"] = True

    thread = threading.Thread(target=do_download, daemon=True)
    thread.start()

    steps = 10
    for i in range(steps):
        thread.join(timeout=3.0)
        if result["done"]:
            break
        pct = percent_start + int((i + 1) / steps * (percent_end - percent_start - 2))
        progress(rid, pct, f"Downloading {model_id} model… (this may take a few minutes)")

    thread.join()
    if result["error"]:
        raise result["error"]
    progress(rid, percent_end, "Model downloaded.")


def progress(rid: str, percent: int, message: str):
    emit({"id": rid, "event": "progress", "percent": percent, "message": message})


# ── handlers ──────────────────────────────────────────────────────────────────
def handle_probe_fps(params: dict) -> dict:
    file_path = params["path"]
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-select_streams", "v:0", file_path],
            stderr=subprocess.DEVNULL,
        ).decode()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return {"fps": None}

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"fps": None}

    streams = data.get("streams", [])
    if not streams:
        return {"fps": None}

    fps_str = streams[0].get("avg_frame_rate") or streams[0].get("r_frame_rate")
    if not fps_str:
        return {"fps": None}

    try:
        parts = fps_str.split("/")
        num = float(parts[0])
        den = float(parts[1]) if len(parts) > 1 else 1.0
    except ValueError:
        return {"fps": None}

    if num == 0 or den == 0:
        return {"fps": None}

    fps = num / den
    snaps = [(23.976, 24000 / 1001), (29.97, 30000 / 1001), (59.94, 60000 / 1001)]
    for label, exact in snaps:
        if abs(fps - exact) < 0.01:
            fps = label
            break
    else:
        fps = round(fps * 1000) / 1000

    return {"fps": fps}


def _check_has_audio(file_path: str):
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", file_path],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        if not out:
            raise RuntimeError(
                f"No audio stream found in \"{Path(file_path).name}\". "
                "This file cannot be transcribed."
            )
    except FileNotFoundError:
        pass
    except subprocess.CalledProcessError:
        pass


def _get_or_load_model(rid: str, model_id: str, language: str | None):
    """Lazy load + cache. Cache key includes language because whisperx bakes it in."""
    cache_key = f"{model_id}|{language or ''}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    if not is_model_cached(model_id):
        download_model_with_progress(rid, model_id, percent_start=2, percent_end=18)

    progress(rid, 20, f"Loading {model_id} model…")
    with contextlib.redirect_stdout(sys.stderr):
        model = whisperx.load_model(
            model_id,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            language=language,
        )
    _MODEL_CACHE[cache_key] = model
    return model


def handle_transcribe(rid: str, params: dict) -> dict:
    file_path = params["path"]
    model_id = params.get("model")
    language = params.get("language") or None
    if not model_id:
        raise ValueError("'model' is required")

    progress(rid, 1, "Preparing…")
    model = _get_or_load_model(rid, model_id, language)

    progress(rid, 30, "Loading audio…")
    _check_has_audio(file_path)
    with contextlib.redirect_stdout(sys.stderr):
        audio = whisperx.load_audio(file_path)

    progress(rid, 40, "Transcribing…")
    with contextlib.redirect_stdout(sys.stderr):
        result = model.transcribe(audio, batch_size=16, language=language)
    detected_language = result.get("language", language or "en")

    words = []
    try:
        progress(rid, 65, "Aligning word timestamps…")
        with contextlib.redirect_stdout(sys.stderr):
            align_model, metadata = whisperx.load_align_model(
                language_code=detected_language,
                device=DEVICE,
            )
            aligned = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                DEVICE,
                return_char_alignments=False,
            )

        for seg in aligned.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "text": w.get("word", "").strip(),
                    "start": round(w.get("start", seg["start"]), 3),
                    "end": round(w.get("end", seg["end"]), 3),
                    "confidence": round(w.get("score", 1.0), 3),
                })
    except Exception:
        progress(rid, 70, "Alignment unavailable, using segment timestamps…")
        for seg in result.get("segments", []):
            text = seg.get("text", "").strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": round(seg["start"], 3),
                "end": round(seg["end"], 3),
                "confidence": 1.0,
            })

    progress(rid, 100, "Done")
    words = [w for w in words if w["text"]]
    return {"words": words, "language": detected_language}


# ── request loop ──────────────────────────────────────────────────────────────
HANDLERS = {
    "probe_fps": handle_probe_fps,
    "transcribe": handle_transcribe,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"bad request (not JSON): {e}")
            continue

        rid = req.get("id", "")
        op = req.get("op", "")
        params = req.get("params", {}) or {}

        handler = HANDLERS.get(op)
        if handler is None:
            emit({"id": rid, "ok": False, "error": f"unknown op: {op}"})
            continue

        try:
            if op == "transcribe":
                result = handler(rid, params)
            else:
                result = handler(params)
            emit({"id": rid, "ok": True, "result": result})
        except Exception as e:
            log(traceback.format_exc())
            emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
