mod transcription;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Window};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use transcription::{ModelInfo, ProgressPayload, TranscribedWord, TranscriptionResult};

// ── Default export format scripts (embedded at compile time) ─────────────────

const SRT_JS:  &str = include_str!("../resources/srt.js");
const VTT_JS:  &str = include_str!("../resources/vtt.js");
const JSON_JS: &str = include_str!("../resources/json.js");
const TXT_JS:  &str = include_str!("../resources/txt.js");

fn export_formats_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("export_formats"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// Write the default format scripts into export_formats/ if they aren't there yet.
fn seed_format_files(app: &AppHandle) -> Result<(), String> {
    let dir = export_formats_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    for (name, content) in [("srt.js", SRT_JS), ("vtt.js", VTT_JS), ("json.js", JSON_JS), ("txt.js", TXT_JS)] {
        let dest = dir.join(name);
        if !dest.exists() {
            std::fs::write(&dest, content).map_err(|e| format!("write {name}: {e}"))?;
        }
    }
    Ok(())
}

// ── Export format commands ───────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct UserFormatMeta {
    name: String,
    extension: String,
    path: String,
}

#[tauri::command]
fn get_export_formats_dir(app: AppHandle) -> Result<String, String> {
    let dir = export_formats_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir error: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_user_formats(app: AppHandle) -> Result<Vec<UserFormatMeta>, String> {
    let dir = export_formats_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut formats: Vec<UserFormatMeta> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir error: {e}"))?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("js"))
        .map(|entry| {
            let path = entry.path();
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let mut name = stem.clone();
            let mut extension = "txt".to_string();

            for line in content.lines().take(10) {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("// @name ") {
                    name = val.trim().to_string();
                } else if let Some(val) = line.strip_prefix("// @ext ") {
                    extension = val.trim().to_string();
                }
            }

            UserFormatMeta { name, extension, path: path.to_string_lossy().into_owned() }
        })
        .collect();

    formats.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(formats)
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open error: {e}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open error: {e}"))?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open error: {e}"))?;
    Ok(())
}

// ── Project file commands ────────────────────────────────────────────────────

#[tauri::command]
fn save_project(path: String, json: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir error: {e}"))?;
    }
    std::fs::write(p, json).map_err(|e| format!("failed to save project: {e}"))
}

#[tauri::command]
fn load_project(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to load project: {e}"))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

// ── Model commands ───────────────────────────────────────────────────────────

/// Probe a media file for its frame rate using ffprobe.
/// Returns the FPS as a float, or null if ffprobe is unavailable or the file
/// has no video stream (e.g. audio-only).
/// Snaps common NTSC rates (23.976, 29.97, 59.94) to their exact rational values.
#[tauri::command]
fn probe_fps(path: String) -> Option<f64> {
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-select_streams", "v:0",
            &path,
        ])
        .output()
        .ok()?;

    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let streams = json["streams"].as_array()?;
    if streams.is_empty() {
        return None; // audio-only
    }

    // Prefer avg_frame_rate; fall back to r_frame_rate
    let fps_str = streams[0]["avg_frame_rate"]
        .as_str()
        .or_else(|| streams[0]["r_frame_rate"].as_str())?;

    let fps = parse_rational_fps(fps_str)?;

    // Snap common NTSC rates to their canonical values
    Some(snap_fps(fps))
}

fn parse_rational_fps(s: &str) -> Option<f64> {
    let mut parts = s.splitn(2, '/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = parts.next().unwrap_or("1").parse().ok()?;
    if den == 0.0 || num == 0.0 { return None; }
    Some(num / den)
}

fn snap_fps(fps: f64) -> f64 {
    // NTSC drop-frame rates stored as exact rational numbers
    const SNAPS: &[(f64, f64)] = &[
        (23.976, 24000.0 / 1001.0),
        (29.97,  30000.0 / 1001.0),
        (59.94,  60000.0 / 1001.0),
    ];
    for &(label, exact) in SNAPS {
        if (fps - exact).abs() < 0.01 {
            return label;
        }
    }
    // Round everything else to 3 decimal places
    (fps * 1000.0).round() / 1000.0
}

/// Return the static list of known Whisper models.
/// WhisperX downloads models itself at runtime; `cached` is always false here
/// (we don't track the whisperx model cache).
#[tauri::command]
fn list_models() -> Vec<ModelInfo> {
    transcription::model_list()
}

// ── Transcription command ────────────────────────────────────────────────────

/// Transcribe a media file using the WhisperX Python sidecar.
/// Streams `transcription://progress` events to the window during the run.
/// Returns a flat list of words with timestamps on success.
#[tauri::command]
async fn transcribe_media(
    app: AppHandle,
    window: Window,
    media_path: String,
    model_id: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let mut args = vec!["--file".to_string(), media_path, "--model".to_string(), model_id];
    if let Some(lang) = language {
        args.push("--language".to_string());
        args.push(lang);
    }

    let (mut rx, _child) = app
        .shell()
        .sidecar("transcribe")
        .map_err(|e| format!("sidecar error: {e}"))?
        .args(&args)
        .spawn()
        .map_err(|e| format!("spawn error: {e}"))?;

    let mut stdout_buf = String::new();
    let mut result_words: Option<(Vec<TranscribedWord>, String)> = None;
    let mut error_msg: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                // Process all complete lines
                while let Some(pos) = stdout_buf.find('\n') {
                    let line = stdout_buf[..pos].trim().to_string();
                    stdout_buf = stdout_buf[pos + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }

                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        match value.get("type").and_then(|t| t.as_str()) {
                            Some("progress") => {
                                let percent = value.get("percent")
                                    .and_then(|p| p.as_u64())
                                    .unwrap_or(0) as u8;
                                let message = value.get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let _ = window.emit(
                                    "transcription://progress",
                                    ProgressPayload { stage: "transcribing".to_string(), percent, message },
                                );
                            }
                            Some("result") => {
                                if let Some(words_val) = value.get("words") {
                                    if let Ok(words) = serde_json::from_value::<Vec<TranscribedWord>>(words_val.clone()) {
                                        let language = value.get("language")
                                            .and_then(|l| l.as_str())
                                            .unwrap_or("en")
                                            .to_string();
                                        result_words = Some((words, language));
                                    }
                                }
                            }
                            Some("error") => {
                                error_msg = Some(
                                    value.get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("unknown sidecar error")
                                        .to_string(),
                                );
                            }
                            _ => {}
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                // Forward non-empty stderr lines as progress events so the UI
                // can show download/tqdm output that whisperx writes to stderr.
                // Skip Python warning boilerplate (UserWarning, warn() calls, etc.)
                let text = String::from_utf8_lossy(&bytes);
                let line = text.trim();
                if !line.is_empty() {
                    eprintln!("[sidecar stderr] {line}");
                    let is_py_warning = line.contains("Warning")
                        || line.contains("warn(")
                        || line.starts_with("  File \"")
                        || line.starts_with("  ");
                    if !is_py_warning {
                        let _ = window.emit(
                            "transcription://progress",
                            ProgressPayload { stage: "downloading".to_string(), percent: 0, message: line.to_string() },
                        );
                    }
                }
            }
            CommandEvent::Error(e) => {
                return Err(format!("sidecar error: {e}"));
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) && result_words.is_none() {
                    return Err(error_msg.unwrap_or_else(|| {
                        format!("sidecar exited with code {:?}", payload.code)
                    }));
                }
                break;
            }
            _ => {}
        }
    }

    if let Some(msg) = error_msg {
        return Err(msg);
    }

    let (words, language) = result_words.ok_or_else(|| "sidecar did not return a result".to_string())?;
    Ok(TranscriptionResult { words, language })
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Err(e) = seed_format_files(app.handle()) {
                eprintln!("warning: could not seed export format files: {e}");
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(tauri::include_image!("icons/icon.png"));
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_export_formats_dir,
            list_user_formats,
            open_in_explorer,
            save_project,
            load_project,
            file_exists,
            probe_fps,
            list_models,
            transcribe_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
