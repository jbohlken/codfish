use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A single transcribed word with timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
    pub speaker: Option<String>,
}

/// Payload emitted on the `transcription://progress` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub stage: String,
    pub percent: u8,
    pub message: String,
}

/// Metadata about a Whisper model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub size_mb: u32,
    pub cached: bool,
}

/// Return the HuggingFace hub cache root.
/// Respects HF_HOME and XDG_CACHE_HOME env vars the same way the Python client does.
fn hf_hub_root() -> PathBuf {
    if let Ok(hf_home) = std::env::var("HF_HOME") {
        return PathBuf::from(hf_home).join("hub");
    }
    let base = if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
        PathBuf::from(xdg)
    } else {
        dirs_next_home().join(".cache")
    };
    base.join("huggingface").join("hub")
}

/// Cross-platform home directory fallback.
fn dirs_next_home() -> PathBuf {
    // USERPROFILE on Windows, HOME on Unix
    if let Ok(p) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        PathBuf::from(p)
    } else {
        PathBuf::from(".")
    }
}

/// Check whether the faster-whisper model for `id` is fully cached.
/// Requires `model.bin` to be present in at least one snapshot directory —
/// a partial download (e.g. interrupted by a symlink error) won't satisfy this.
fn is_cached(id: &str) -> bool {
    let snapshots = hf_hub_root()
        .join(format!("models--Systran--faster-whisper-{id}"))
        .join("snapshots");

    std::fs::read_dir(&snapshots)
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry.path().join("model.bin").exists()
            })
        })
        .unwrap_or(false)
}

/// Return the list of supported Whisper models with live cache status.
pub fn model_list() -> Vec<ModelInfo> {
    [
        ("tiny",     "Tiny (39 MB)",       39u32),
        ("base",     "Base (74 MB)",       74),
        ("small",    "Small (244 MB)",     244),
        ("medium",   "Medium (769 MB)",    769),
        ("large-v3", "Large v3 (1.5 GB)", 1550),
    ]
    .iter()
    .map(|&(id, name, size_mb)| ModelInfo {
        id: id.to_string(),
        name: name.to_string(),
        size_mb,
        cached: is_cached(id),
    })
    .collect()
}
