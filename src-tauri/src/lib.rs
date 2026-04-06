mod bug_report;
mod sidecar;
mod transcription;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Window};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use transcription::{ModelInfo, ProgressPayload, TranscribedWord, TranscriptionResult};

// ── Logging ─────────────────────────────────────────────────────────────────

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("codfish.log"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

fn log(app: &AppHandle, message: &str) {
    use std::io::Write;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{now}] {message}\n");
    eprintln!("{}", line.trim());
    if let Ok(path) = log_path(app) {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[tauri::command]
fn get_log_path(app: AppHandle) -> Result<String, String> {
    log_path(&app).map(|p| p.to_string_lossy().into_owned())
}

// ── Default resources (embedded at compile time) ────────────────────────────

const SRT_JS:  &str = include_str!("../resources/export_formats/srt.js");
const VTT_JS:  &str = include_str!("../resources/export_formats/vtt.js");
const JSON_JS: &str = include_str!("../resources/export_formats/json.js");
const TXT_JS:  &str = include_str!("../resources/export_formats/txt.js");

const PROFILE_DEFAULT: &str = include_str!("../resources/profiles/default.cfp");
const PROFILE_NETFLIX: &str = include_str!("../resources/profiles/netflix.cfp");
const PROFILE_BBC:     &str = include_str!("../resources/profiles/bbc.cfp");

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

// ── Profile commands ────────────────────────────────────────────────────────

fn profiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("profiles"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

fn seed_profile_files(app: &AppHandle) -> Result<(), String> {
    let dir = profiles_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    for (name, content) in [
        ("default.cfp", PROFILE_DEFAULT),
        ("netflix.cfp", PROFILE_NETFLIX),
        ("bbc.cfp", PROFILE_BBC),
    ] {
        let dest = dir.join(name);
        if !dest.exists() {
            std::fs::write(&dest, content).map_err(|e| format!("write {name}: {e}"))?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ProfileRule {
    value: f64,
    strict: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct TimedRule {
    value: f64,
    strict: bool,
    unit: String,   // "s" or "fr"
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimingConfig {
    min_duration: TimedRule,
    max_duration: TimedRule,
    max_cps: ProfileRule,
    extend_to_fill: bool,
    extend_to_fill_max: f64,
    gap_close_threshold: f64,
    min_gap_enabled: bool,
    min_gap_seconds: TimedRule,
    default_fps: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FormattingConfig {
    max_chars_per_line: ProfileRule,
    max_lines: ProfileRule,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MergeConfig {
    enabled: bool,
    phrase_break_gap: f64,
    min_segment_words: f64,
    merge_gap_threshold: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaptionProfile {
    id: String,
    name: String,
    description: String,
    built_in: bool,
    timing: TimingConfig,
    formatting: FormattingConfig,
    merge: MergeConfig,
}

/// Parse a simple INI profile file.
fn parse_profile(id: &str, content: &str) -> Result<CaptionProfile, String> {
    use std::collections::HashMap;

    let mut name = id.to_string();
    let mut description = String::new();
    let mut built_in = false;
    let mut section = String::new();
    let mut values: HashMap<String, String> = HashMap::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        // Header comments with metadata
        if let Some(val) = line.strip_prefix("# @name ") {
            name = val.trim().to_string();
            continue;
        }
        if let Some(val) = line.strip_prefix("# @description ") {
            description = val.trim().to_string();
            continue;
        }
        if let Some(val) = line.strip_prefix("# @builtIn ") {
            built_in = val.trim() == "true";
            continue;
        }
        if line.starts_with('#') { continue; }

        // Section header
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len()-1].to_string();
            continue;
        }

        // Key = value
        if let Some(eq) = line.find('=') {
            let key = format!("{}.{}", section, line[..eq].trim());
            let val = line[eq+1..].trim().to_string();
            values.insert(key, val);
        }
    }

    let get_f = |k: &str| -> f64 {
        values.get(k).and_then(|v| v.parse().ok()).unwrap_or(0.0)
    };
    let get_b = |k: &str| -> bool {
        values.get(k).map(|v| v == "true").unwrap_or(false)
    };
    let get_s = |k: &str| -> String {
        values.get(k).cloned().unwrap_or_default()
    };

    Ok(CaptionProfile {
        id: id.to_string(),
        name,
        description,
        built_in,
        timing: TimingConfig {
            min_duration: TimedRule {
                value: get_f("timing.minDuration"),
                strict: get_b("timing.minDuration.strict"),
                unit: { let u = get_s("timing.minDuration.unit"); if u.is_empty() { "s".into() } else { u } },
            },
            max_duration: TimedRule {
                value: get_f("timing.maxDuration"),
                strict: get_b("timing.maxDuration.strict"),
                unit: { let u = get_s("timing.maxDuration.unit"); if u.is_empty() { "s".into() } else { u } },
            },
            max_cps: ProfileRule {
                value: get_f("timing.maxCps"),
                strict: get_b("timing.maxCps.strict"),
            },
            extend_to_fill: get_b("timing.extendToFill"),
            extend_to_fill_max: get_f("timing.extendToFillMax"),
            gap_close_threshold: get_f("timing.gapCloseThreshold"),
            min_gap_enabled: get_b("timing.minGapEnabled"),
            min_gap_seconds: TimedRule {
                value: get_f("timing.minGapSeconds"),
                strict: get_b("timing.minGapSeconds.strict"),
                unit: { let u = get_s("timing.minGapSeconds.unit"); if u.is_empty() { "s".into() } else { u } },
            },
            default_fps: { let v = get_f("timing.defaultFps"); if v == 0.0 { 30.0 } else { v } },
        },
        formatting: FormattingConfig {
            max_chars_per_line: ProfileRule {
                value: get_f("formatting.maxCharsPerLine"),
                strict: get_b("formatting.maxCharsPerLine.strict"),
            },
            max_lines: ProfileRule {
                value: get_f("formatting.maxLines"),
                strict: get_b("formatting.maxLines.strict"),
            },
        },
        merge: MergeConfig {
            enabled: get_b("merge.enabled"),
            phrase_break_gap: get_f("merge.phraseBreakGap"),
            min_segment_words: get_f("merge.minSegmentWords"),
            merge_gap_threshold: get_f("merge.mergeGapThreshold"),
        },
    })
}

/// Serialize a profile back to INI format.
fn serialize_profile(p: &CaptionProfile) -> String {
    let b = |v: bool| if v { "true" } else { "false" };
    format!(
        "# @name {name}\n# @description {desc}\n\n\
        [formatting]\n\
        maxCharsPerLine = {mcpl}\nmaxCharsPerLine.strict = {mcpls}\n\
        maxLines = {ml}\nmaxLines.strict = {mls}\n\n\
        [timing]\n\
        minDuration = {mind}\nminDuration.strict = {minds}\nminDuration.unit = {mindu}\n\
        maxDuration = {maxd}\nmaxDuration.strict = {maxds}\nmaxDuration.unit = {maxdu}\n\
        maxCps = {cps}\nmaxCps.strict = {cpss}\n\
        extendToFill = {etf}\nextendToFillMax = {etfm}\n\
        gapCloseThreshold = {gct}\n\
        minGapEnabled = {mge}\n\
        minGapSeconds = {mgs}\nminGapSeconds.strict = {mgss}\nminGapSeconds.unit = {mgsu}\n\
        defaultFps = {fps}\n\n\
        [merge]\n\
        enabled = {me}\nphraseBreakGap = {pbg}\nminSegmentWords = {msw}\nmergeGapThreshold = {mgt}\n",
        name = p.name,
        desc = p.description,
        mcpl = p.formatting.max_chars_per_line.value,
        mcpls = b(p.formatting.max_chars_per_line.strict),
        ml = p.formatting.max_lines.value,
        mls = b(p.formatting.max_lines.strict),
        mind = p.timing.min_duration.value,
        minds = b(p.timing.min_duration.strict),
        mindu = p.timing.min_duration.unit,
        maxd = p.timing.max_duration.value,
        maxds = b(p.timing.max_duration.strict),
        maxdu = p.timing.max_duration.unit,
        cps = p.timing.max_cps.value,
        cpss = b(p.timing.max_cps.strict),
        etf = b(p.timing.extend_to_fill),
        etfm = p.timing.extend_to_fill_max,
        gct = p.timing.gap_close_threshold,
        mge = b(p.timing.min_gap_enabled),
        mgs = p.timing.min_gap_seconds.value,
        mgss = b(p.timing.min_gap_seconds.strict),
        mgsu = p.timing.min_gap_seconds.unit,
        fps = p.timing.default_fps,
        me = b(p.merge.enabled),
        pbg = p.merge.phrase_break_gap,
        msw = p.merge.min_segment_words,
        mgt = p.merge.merge_gap_threshold,
    )
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<CaptionProfile>, String> {
    let dir = profiles_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut profiles: Vec<CaptionProfile> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir error: {e}"))?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("cfp"))
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?.to_string();
            let content = std::fs::read_to_string(&path).ok()?;
            parse_profile(&id, &content).ok()
        })
        .collect();

    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: CaptionProfile) -> Result<(), String> {
    let dir = profiles_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let dest = dir.join(format!("{}.cfp", profile.id));
    let content = serialize_profile(&profile);
    std::fs::write(&dest, content).map_err(|e| format!("write error: {e}"))
}

#[tauri::command]
fn delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    let dir = profiles_dir(&app)?;
    let dest = dir.join(format!("{id}.cfp"));
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| format!("delete error: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_profiles_dir(app: AppHandle) -> Result<String, String> {
    let dir = profiles_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir error: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_profile(app: AppHandle, id: String) -> Result<String, String> {
    let dir = profiles_dir(&app)?;
    let src = dir.join(format!("{id}.cfp"));
    if !src.exists() {
        return Err(format!("profile '{id}' not found"));
    }
    let content = std::fs::read_to_string(&src)
        .map_err(|e| format!("read error: {e}"))?;

    // Extract the profile name from the INI header for the default filename
    let name = content.lines()
        .find_map(|l| l.strip_prefix("# @name "))
        .map(|n| n.trim().to_string())
        .unwrap_or_else(|| id.clone());

    Ok(serde_json::json!({ "content": content, "defaultName": name }).to_string())
}

#[tauri::command]
fn import_profile(app: AppHandle, content: String) -> Result<CaptionProfile, String> {
    let id = format!("user_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));

    // Validate that the content parses as a profile
    let mut profile = parse_profile(&id, &content)?;
    profile.built_in = false;

    // Check for name collisions with existing profiles
    let dir = profiles_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let existing_names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir: {e}"))?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("cfp"))
        .filter_map(|entry| {
            let content = std::fs::read_to_string(entry.path()).ok()?;
            content.lines()
                .find_map(|l| l.strip_prefix("# @name "))
                .map(|n| n.trim().to_string())
        })
        .collect();

    if existing_names.contains(&profile.name) {
        profile.name = format!("{} (imported)", profile.name);
    }

    // Write to disk
    let dest = dir.join(format!("{id}.cfp"));
    let serialized = serialize_profile(&profile);
    std::fs::write(&dest, serialized).map_err(|e| format!("write error: {e}"))?;

    Ok(profile)
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

/// Probe a media file for its frame rate.
/// Tries standalone ffprobe first (instant), then the sidecar (slow PyInstaller
/// startup), then system ffprobe as last resort. Returns null for audio-only
/// files, or an error if probing fails entirely.
#[tauri::command]
fn probe_fps(app: AppHandle, path: String) -> Result<Option<f64>, String> {
    // Try standalone ffprobe first — downloaded alongside the sidecar, instant
    if let Ok(fp) = sidecar::ffprobe_bin_path(&app) {
        if fp.exists() {
            log(&app, &format!("probe_fps: trying standalone ffprobe at {}", fp.display()));
            if let Some(result) = run_ffprobe(&app, fp.to_string_lossy().as_ref(), &path) {
                return result;
            }
        }
    }

    // Fall back to sidecar (slow — PyInstaller unpacks Python + imports torch)
    if let Ok(bin) = sidecar::sidecar_bin_path(&app) {
        if bin.exists() {
            log(&app, &format!("probe_fps: trying sidecar at {}", bin.display()));
            match std::process::Command::new(&bin)
                .args(["--file", &path, "--probe-fps"])
                .output()
            {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    log(&app, &format!("probe_fps: sidecar stdout: {}", stdout.trim()));
                    for line in stdout.lines() {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                            if val.get("type").and_then(|t| t.as_str()) == Some("result") {
                                let fps = val.get("fps").and_then(|f| f.as_f64());
                                if let Some(f) = fps {
                                    log(&app, &format!("probe_fps: detected {f}"));
                                } else {
                                    log(&app, "probe_fps: no video stream (audio-only)");
                                }
                                return Ok(fps);
                            }
                        }
                    }
                    log(&app, "probe_fps: sidecar returned no fps result");
                }
                Err(e) => {
                    log(&app, &format!("probe_fps: sidecar failed to run: {e}"));
                }
            }
        }
    }

    // Last resort: system ffprobe
    log(&app, "probe_fps: falling back to system ffprobe");
    if let Some(result) = run_ffprobe(&app, "ffprobe", &path) {
        return result;
    }

    let msg = "Could not detect frame rate: no ffprobe available. The default frame rate from your profile will be used.".to_string();
    log(&app, &format!("probe_fps: {msg}"));
    Err(msg)
}

/// Run ffprobe at the given path and parse the result. Returns None if ffprobe
/// couldn't be executed (so the caller can try the next fallback).
fn run_ffprobe(app: &AppHandle, ffprobe_path: &str, media_path: &str) -> Option<Result<Option<f64>, String>> {
    let output = match std::process::Command::new(ffprobe_path)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-select_streams", "v:0",
            media_path,
        ])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            log(app, &format!("probe_fps: {ffprobe_path} failed to run: {e}"));
            return None; // couldn't run — try next fallback
        }
    };

    if !output.status.success() && output.stdout.is_empty() {
        log(app, &format!("probe_fps: {ffprobe_path} returned no data"));
        return None;
    }

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => {
            log(app, &format!("probe_fps: failed to parse ffprobe output: {e}"));
            return None;
        }
    };

    let streams = json["streams"].as_array();
    if streams.map_or(true, |s| s.is_empty()) {
        log(app, "probe_fps: no video streams (audio-only)");
        return Some(Ok(None));
    }

    let streams = streams.unwrap();
    let fps_str = streams[0]["avg_frame_rate"]
        .as_str()
        .or_else(|| streams[0]["r_frame_rate"].as_str());

    match fps_str.and_then(parse_rational_fps) {
        Some(fps) => {
            let snapped = snap_fps(fps);
            log(app, &format!("probe_fps: detected {snapped}"));
            Some(Ok(Some(snapped)))
        }
        None => {
            log(app, "probe_fps: no valid frame rate in video stream");
            None
        }
    }
}

fn parse_rational_fps(s: &str) -> Option<f64> {
    let mut parts = s.splitn(2, '/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = parts.next().unwrap_or("1").parse().ok()?;
    if den == 0.0 || num == 0.0 { return None; }
    Some(num / den)
}

fn snap_fps(fps: f64) -> f64 {
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
    let mut args = vec!["--file".to_string(), media_path.clone(), "--model".to_string(), model_id.clone()];
    if let Some(lang) = language.clone() {
        args.push("--language".to_string());
        args.push(lang);
    }

    log(&app, &format!("transcribe: file={media_path} model={model_id} lang={}", language.as_deref().unwrap_or("auto")));

    let bin = sidecar::sidecar_bin_path(&app)?;
    if !bin.exists() {
        log(&app, "transcribe: sidecar binary not found");
        return Err("Transcription engine not installed. Download it from the setup screen.".into());
    }

    let (mut rx, _child) = app
        .shell()
        .command(bin)
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
                        || line.contains("Lightning automatically upgraded")
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
                log(&app, &format!("transcribe: sidecar error: {e}"));
                return Err(format!("sidecar error: {e}"));
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) && result_words.is_none() {
                    let msg = error_msg.unwrap_or_else(|| {
                        format!("sidecar exited with code {:?}", payload.code)
                    });
                    log(&app, &format!("transcribe: {msg}"));
                    return Err(msg);
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
            if let Err(e) = seed_profile_files(app.handle()) {
                eprintln!("warning: could not seed profile files: {e}");
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(tauri::include_image!("icons/icon.png"));
            }
            // If launched via file association, emit the path to the frontend
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = args.get(1) {
                if path.ends_with(".cod") {
                    if let Some(window) = app.get_webview_window("main") {
                        let path = path.clone();
                        let _ = window.emit("open-file", path);
                    }
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_export_formats_dir,
            list_user_formats,
            open_in_explorer,
            save_project,
            load_project,
            file_exists,
            probe_fps,
            get_log_path,
            list_models,
            transcribe_media,
            list_profiles,
            save_profile,
            delete_profile,
            get_profiles_dir,
            export_profile,
            import_profile,
            sidecar::get_sidecar_status,
            sidecar::detect_gpu,
            sidecar::check_sidecar_update,
            sidecar::download_sidecar,
            bug_report::submit_bug_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
