#!/usr/bin/env python3
"""
Codfish WhisperX transcription sidecar.

Usage:
    transcribe --file <path> --model <id> [--language <code>]

Streams JSON lines to stdout:
    {"type": "progress", "percent": 0-100, "message": "..."}
    {"type": "result", "words": [{"text": "...", "start": 0.0, "end": 0.5, "confidence": 0.95}]}
    {"type": "error", "message": "..."}
"""

import sys
import json
import argparse
import traceback
from pathlib import Path


def emit(obj: dict):
    print(json.dumps(obj), flush=True)


def progress(percent: int, message: str):
    emit({"type": "progress", "percent": percent, "message": message})


def hf_cache_root() -> Path:
    """Mirror the HuggingFace cache path logic used by huggingface_hub."""
    import os
    if hf_home := os.environ.get("HF_HOME"):
        return Path(hf_home) / "hub"
    if xdg := os.environ.get("XDG_CACHE_HOME"):
        base = Path(xdg)
    else:
        base = Path.home() / ".cache"
    return base / "huggingface" / "hub"


def is_model_cached(model_id: str) -> bool:
    """Check whether the faster-whisper model is fully cached (model.bin present)."""
    snapshots = hf_cache_root() / f"models--Systran--faster-whisper-{model_id}" / "snapshots"
    try:
        for snapshot_dir in snapshots.iterdir():
            if (snapshot_dir / "model.bin").exists():
                return True
        return False
    except (FileNotFoundError, PermissionError):
        return False


def download_model_with_progress(model_id: str, percent_start: int, percent_end: int):
    """
    Download the faster-whisper model from HuggingFace with progress reporting.
    Uses huggingface_hub directly so we can emit meaningful progress events.
    """
    from huggingface_hub import snapshot_download
    from huggingface_hub import constants as hf_constants
    import threading

    repo_id = f"Systran/faster-whisper-{model_id}"
    progress(percent_start, f"Downloading {model_id} model from HuggingFace…")

    # Run download in a thread so we can emit heartbeat progress while waiting
    result = {"done": False, "error": None}

    def do_download():
        try:
            # local_dir_use_symlinks=False avoids WinError 1314 (symlink privilege)
            # on Windows machines without Developer Mode enabled.
            snapshot_download(repo_id, local_files_only=False, local_dir_use_symlinks=False)
        except Exception as e:
            result["error"] = e
        finally:
            result["done"] = True

    thread = threading.Thread(target=do_download, daemon=True)
    thread.start()

    # Emit a slow-moving progress bar while download runs (we don't have byte-level hooks)
    import time
    steps = 10
    for i in range(steps):
        thread.join(timeout=3.0)
        if result["done"]:
            break
        pct = percent_start + int((i + 1) / steps * (percent_end - percent_start - 2))
        progress(pct, f"Downloading {model_id} model… (this may take a few minutes)")

    thread.join()

    if result["error"]:
        raise result["error"]

    progress(percent_end, f"Model downloaded.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="Path to audio/video file")
    parser.add_argument("--model", required=True, help="Whisper model id (tiny, base, small, medium, large-v3)")
    parser.add_argument("--language", default=None, help="ISO language code (e.g. en). Auto-detect if omitted.")
    args = parser.parse_args()

    try:
        import torch
        import whisperx

        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"

        # ── 1. Download model if not cached ───────────────────────────────
        if not is_model_cached(args.model):
            download_model_with_progress(args.model, percent_start=2, percent_end=18)

        # ── 2. Load model ──────────────────────────────────────────────────
        progress(20, f"Loading {args.model} model…")
        model = whisperx.load_model(
            args.model,
            device=device,
            compute_type=compute_type,
            language=args.language,
        )

        # ── 3. Load audio ──────────────────────────────────────────────────
        progress(30, "Loading audio…")
        audio = whisperx.load_audio(args.file)

        # ── 4. Transcribe ──────────────────────────────────────────────────
        progress(40, "Transcribing…")
        result = model.transcribe(audio, batch_size=16, language=args.language)
        detected_language = result.get("language", args.language or "en")

        # Free GPU memory before alignment
        del model
        if device == "cuda":
            import gc
            gc.collect()
            torch.cuda.empty_cache()

        # ── 5. Align (word-level timestamps) ──────────────────────────────
        words = []
        try:
            progress(65, "Aligning word timestamps…")
            align_model, metadata = whisperx.load_align_model(
                language_code=detected_language,
                device=device,
            )
            aligned = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                device,
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
            # Alignment failed (unsupported language, etc.) — fall back to segment-level
            progress(70, "Alignment unavailable, using segment timestamps…")
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

        progress(95, "Finalising…")

        # Filter out empty words
        words = [w for w in words if w["text"]]

        progress(100, "Done")
        emit({"type": "result", "words": words})

    except Exception as e:
        emit({"type": "error", "message": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
