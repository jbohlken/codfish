mod bug_report;
mod daemon;
mod sidecar;
mod transcription;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::Mutex as AsyncMutex;
use transcription::{ModelInfo, ProgressPayload, TranscribedWord, TranscriptionResult};

use crate::daemon::{DaemonStatus, SidecarDaemon};

type DaemonState = AsyncMutex<Option<Arc<SidecarDaemon>>>;

// ── Logging ─────────────────────────────────────────────────────────────────

pub(crate) fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("codfish.log"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

pub(crate) fn log(app: &AppHandle, message: &str) {
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

#[tauri::command]
fn frontend_log(app: AppHandle, message: String) {
    log(&app, &message);
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

// ── Recovery commands ────────────────────────────────────────────────────────
// Autosave hook for update safety: before we tear down the app or sidecar for
// an update, the frontend drops an in-memory snapshot here so nothing is lost
// if the relaunch/extraction goes sideways.

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir recovery: {e}"))?;
    Ok(dir.join("active.json"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RecoveryBlob {
    original_path: Option<String>,
    saved_at: String,
    json: String,
}

#[tauri::command]
fn save_recovery(app: AppHandle, json: String, original_path: Option<String>) -> Result<(), String> {
    let blob = RecoveryBlob {
        original_path,
        saved_at: chrono::Local::now().to_rfc3339(),
        json,
    };
    let serialized = serde_json::to_string(&blob).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(recovery_path(&app)?, serialized).map_err(|e| format!("write recovery: {e}"))
}

#[tauri::command]
fn load_recovery(app: AppHandle) -> Result<Option<RecoveryBlob>, String> {
    let path = recovery_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read recovery: {e}"))?;
    serde_json::from_str::<RecoveryBlob>(&raw).map(Some).map_err(|e| format!("parse recovery: {e}"))
}

#[tauri::command]
fn clear_recovery(app: AppHandle) -> Result<(), String> {
    let path = recovery_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove recovery: {e}"))?;
    }
    Ok(())
}

// ── Model commands ───────────────────────────────────────────────────────────

/// Probe a media file for its frame rate via the running daemon.
/// Returns null for audio-only files.
#[tauri::command]
async fn probe_fps(
    app: AppHandle,
    path: String,
    state: State<'_, DaemonState>,
) -> Result<Option<f64>, String> {
    let daemon = {
        let guard = state.lock().await;
        guard.clone().ok_or_else(|| "transcription engine not running".to_string())?
    };

    #[derive(serde::Deserialize)]
    struct R { fps: Option<f64> }

    let r: R = daemon
        .request("probe_fps", serde_json::json!({ "path": path }))
        .await?;
    log(&app, &format!("probe_fps: {:?}", r.fps));
    Ok(r.fps)
}

// ── Daemon commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn start_daemon(
    app: AppHandle,
    state: State<'_, DaemonState>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    // If a daemon already exists but has crashed, drop it so we can respawn.
    if let Some(existing) = guard.as_ref() {
        match existing.current_status() {
            DaemonStatus::Crashed { .. } | DaemonStatus::NotInstalled => {
                *guard = None;
            }
            _ => return Ok(()),
        }
    }

    // Refuse to spawn an incompatible sidecar (pre-daemon protocol).
    if let Ok(Some(meta)) = sidecar::read_meta_public(&app) {
        if !sidecar::version_at_least(&meta.version, sidecar::MIN_SIDECAR_VERSION) {
            return Err(format!(
                "Transcription engine version {} is too old. Please update to {} or newer from the setup screen.",
                meta.version,
                sidecar::MIN_SIDECAR_VERSION
            ));
        }
    }

    log(&app, "daemon: spawning sidecar");
    let daemon = SidecarDaemon::spawn(&app)?;
    *guard = Some(daemon.clone());
    drop(guard);

    // Forward status changes to the frontend
    let app_clone = app.clone();
    let mut rx = daemon.subscribe_status();
    tokio::spawn(async move {
        loop {
            let status = rx.borrow().clone();
            let _ = app_clone.emit("daemon://status", &status);
            if rx.changed().await.is_err() {
                break;
            }
        }
    });
    Ok(())
}

/// Drop the running daemon (if any). The Arc dies, kill_on_drop kills the
/// child, and the executable becomes unlocked on Windows so we can replace
/// it during a sidecar update.
#[tauri::command]
async fn stop_daemon(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    let daemon = {
        let mut guard = state.lock().await;
        guard.take()
    };
    if let Some(d) = daemon {
        log(&app, "daemon: stop requested, killing child");
        // Synchronously kill+wait so Windows releases the executable lock
        // before we try to overwrite it during a sidecar update.
        d.shutdown().await;
        log(&app, "daemon: child exited");
    } else {
        log(&app, "daemon: stop requested but no daemon running");
    }
    // Brief pause for the Windows kernel to actually release the file handle
    // after the process has exited.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    Ok(())
}

#[tauri::command]
async fn get_daemon_status(state: State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    let guard = state.lock().await;
    Ok(match guard.as_ref() {
        Some(d) => d.current_status(),
        None => DaemonStatus::NotInstalled,
    })
}

/// Return the static list of known Whisper models.
/// WhisperX downloads models itself at runtime; `cached` is always false here
/// (we don't track the whisperx model cache).
#[tauri::command]
fn list_models() -> Vec<ModelInfo> {
    transcription::model_list()
}

// ── Transcription command ────────────────────────────────────────────────────

/// Transcribe a media file via the long-lived sidecar daemon.
/// Streams `transcription://progress` events to the window during the run.
#[tauri::command]
async fn transcribe_media(
    app: AppHandle,
    window: Window,
    media_path: String,
    model_id: String,
    language: Option<String>,
    state: State<'_, DaemonState>,
) -> Result<TranscriptionResult, String> {
    log(&app, &format!(
        "transcribe: file={media_path} model={model_id} lang={}",
        language.as_deref().unwrap_or("auto")
    ));

    let daemon = {
        let guard = state.lock().await;
        guard.clone().ok_or_else(|| {
            "Transcription engine not running. Restart the app to retry.".to_string()
        })?
    };

    let params = serde_json::json!({
        "path": media_path,
        "model": model_id,
        "language": language.unwrap_or_default(),
    });

    let on_event = move |ev: serde_json::Value| {
        let percent = ev.get("percent").and_then(|p| p.as_u64()).unwrap_or(0) as u8;
        let message = ev
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let _ = window.emit(
            "transcription://progress",
            ProgressPayload {
                stage: "transcribing".to_string(),
                percent,
                message,
            },
        );
    };

    #[derive(serde::Deserialize)]
    struct R {
        words: Vec<TranscribedWord>,
        language: String,
    }

    let r: R = daemon
        .request_streaming("transcribe", params, on_event)
        .await?;
    Ok(TranscriptionResult {
        words: r.words,
        language: r.language,
    })
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage::<DaemonState>(AsyncMutex::new(None))
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
            save_recovery,
            load_recovery,
            clear_recovery,
            probe_fps,
            get_log_path,
            frontend_log,
            list_models,
            transcribe_media,
            start_daemon,
            stop_daemon,
            get_daemon_status,
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
            force_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Intercept Cmd+Q / app menu Quit so it routes through the same
            // unsaved-changes + update gate as the window close button.
            // Once the frontend has cleared the gate it calls `force_quit`,
            // which sets ALLOW_EXIT and exits cleanly.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !ALLOW_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("app://quit-requested", ());
                    }
                }
            }
        });
}

static ALLOW_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn force_quit(app: AppHandle) {
    ALLOW_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}
