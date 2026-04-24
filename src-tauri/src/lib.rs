mod bug_report;
mod daemon;
mod sidecar;
mod transcription;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Window, Wry};
use tokio::sync::Mutex as AsyncMutex;
use transcription::{ModelInfo, ProgressPayload, TranscribedWord, TranscriptionResult};

use crate::daemon::{DaemonStatus, SidecarDaemon};

type DaemonState = AsyncMutex<Option<Arc<SidecarDaemon>>>;

/// Menu item handles kept around so the frontend can toggle their enabled
/// state via `set_menu_enabled`. Built once in `Builder::menu()`.
struct MenuItems {
    new_project: MenuItem<Wry>,
    open_project: MenuItem<Wry>,
    save_project: MenuItem<Wry>,
    save_project_as: MenuItem<Wry>,
    revert_project: MenuItem<Wry>,
    close_project: MenuItem<Wry>,
    undo: MenuItem<Wry>,
    redo: MenuItem<Wry>,
    dark_mode: CheckMenuItem<Wry>,
    export_formats: MenuItem<Wry>,
    profiles: MenuItem<Wry>,
    about: MenuItem<Wry>,
    feedback: MenuItem<Wry>,
    /// "Open Recent" submenu — its items are rebuilt whenever the recent
    /// list changes via `set_recent_menu`.
    recent_submenu: Submenu<Wry>,
}

/// Maps the index baked into a recent menu item id (`menu_recent_<i>`) back
/// to its filesystem path. Replaced wholesale on every `set_recent_menu`.
struct RecentPaths(StdMutex<Vec<String>>);

/// Paths the OS handed us at launch via file association — argv[1] on
/// Windows/Linux, `RunEvent::Opened` on macOS. The frontend drains this
/// once on startup (after sidecar + daemon are ready) via
/// `take_launch_paths`.
struct LaunchPaths(StdMutex<Vec<String>>);

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

#[tauri::command]
fn set_menu_enabled(items: State<MenuItems>, id: String, enabled: bool) -> Result<(), String> {
    // open_recent (Submenu) and dark_mode (CheckMenuItem) are different types
    // from the regular MenuItems, so they can't go through the match arm.
    if id == "open_recent" {
        return items.recent_submenu.set_enabled(enabled).map_err(|e| e.to_string());
    }
    if id == "dark_mode" {
        return items.dark_mode.set_enabled(enabled).map_err(|e| e.to_string());
    }
    let item = match id.as_str() {
        "new_project" => &items.new_project,
        "open_project" => &items.open_project,
        "save_project" => &items.save_project,
        "save_project_as" => &items.save_project_as,
        "revert_project" => &items.revert_project,
        "close_project" => &items.close_project,
        "undo" => &items.undo,
        "redo" => &items.redo,
        "export_formats" => &items.export_formats,
        "profiles" => &items.profiles,
        "about" => &items.about,
        "feedback" => &items.feedback,
        other => return Err(format!("unknown menu id: {other}")),
    };
    item.set_enabled(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_menu_text(items: State<MenuItems>, id: String, text: String) -> Result<(), String> {
    let item = match id.as_str() {
        "undo" => &items.undo,
        "redo" => &items.redo,
        other => return Err(format!("unknown menu id: {other}")),
    };
    item.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_menu_checked(items: State<MenuItems>, id: String, checked: bool) -> Result<(), String> {
    let item = match id.as_str() {
        "dark_mode" => &items.dark_mode,
        other => return Err(format!("unknown menu id: {other}")),
    };
    item.set_checked(checked).map_err(|e| e.to_string())
}

// ── Default resources (embedded at compile time) ────────────────────────────

const SRT_CFF:  &str = include_str!("../resources/export_formats/srt.cff");
const VTT_CFF:  &str = include_str!("../resources/export_formats/vtt.cff");
const JSON_CFF: &str = include_str!("../resources/export_formats/json.cff");
const TXT_CFF:  &str = include_str!("../resources/export_formats/txt.cff");

const PROFILE_DEFAULT: &str = include_str!("../resources/profiles/default.cfp");
const PROFILE_NETFLIX: &str = include_str!("../resources/profiles/netflix.cfp");
const PROFILE_BBC:     &str = include_str!("../resources/profiles/bbc.cfp");

fn export_formats_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("export_formats"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// Seed .cff format files and clean up legacy .js formats.
fn seed_format_files(app: &AppHandle) -> Result<(), String> {
    let dir = export_formats_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    // 1. Write .cff seeds — always overwrite builtins so updates (renames etc.) take effect
    for (name, content) in [("srt.cff", SRT_CFF), ("vtt.cff", VTT_CFF), ("json.cff", JSON_CFF), ("txt.cff", TXT_CFF)] {
        let dest = dir.join(name);
        std::fs::write(&dest, content).map_err(|e| format!("write {name}: {e}"))?;
    }

    // 2. Delete all .js files — JS execution is no longer supported
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|x| x.to_str()) == Some("js") {
                let _ = std::fs::remove_file(entry.path());
            }
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
    /// "builtin" for seeded formats, "custom" for user-created .cff.
    source: String,
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
        .filter(|e| {
            e.path().extension().and_then(|x| x.to_str()) == Some("cff")
        })
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
            let mut source = "custom".to_string();

            // Parse .cff metadata (key: value lines before first blank line)
            for line in content.lines() {
                if line.trim().is_empty() { break; }
                if let Some(val) = line.strip_prefix("name: ") {
                    name = val.trim().to_string();
                } else if let Some(val) = line.strip_prefix("ext: ") {
                    extension = val.trim().to_string();
                } else if line.trim() == "source: builtin" {
                    source = "builtin".to_string();
                }
            }

            UserFormatMeta { name, extension, path: path.to_string_lossy().into_owned(), source }
        })
        .collect();

    formats.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(formats)
}

/// Save a .cff format file. `filename` is the bare name (e.g. "my-format.cff").
/// Refuses to overwrite builtin formats.
#[tauri::command]
fn save_user_format(app: AppHandle, filename: String, content: String) -> Result<String, String> {
    let dir = export_formats_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let dest = dir.join(&filename);

    // Safety: refuse to overwrite a builtin format.
    if dest.exists() {
        let existing = std::fs::read_to_string(&dest).unwrap_or_default();
        let is_builtin = existing.lines()
            .take_while(|l| !l.trim().is_empty())
            .any(|l| l.trim() == "source: builtin");
        if is_builtin {
            return Err(format!("Cannot overwrite built-in format \"{filename}\". Duplicate it instead."));
        }
    }

    std::fs::write(&dest, &content).map_err(|e| format!("write error: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete a user-created .cff format. Refuses to delete builtin formats.
#[tauri::command]
fn delete_user_format(app: AppHandle, filename: String) -> Result<(), String> {
    let dir = export_formats_dir(&app)?;
    let dest = dir.join(&filename);
    if !dest.exists() {
        return Ok(());
    }
    let existing = std::fs::read_to_string(&dest).unwrap_or_default();
    let is_builtin = existing.lines()
        .take_while(|l| !l.trim().is_empty())
        .any(|l| l.trim() == "source: builtin");
    if is_builtin {
        return Err(format!("Cannot delete built-in format \"{filename}\"."));
    }
    std::fs::remove_file(&dest).map_err(|e| format!("delete error: {e}"))?;
    Ok(())
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
    // Always overwrite builtins so updates take effect. Built-in profiles are
    // readonly in the UI, so any on-disk divergence is either stale or manual.
    for (name, content) in [
        ("default.cfp", PROFILE_DEFAULT),
        ("netflix.cfp", PROFILE_NETFLIX),
        ("bbc.cfp", PROFILE_BBC),
    ] {
        let dest = dir.join(name);
        std::fs::write(&dest, content).map_err(|e| format!("write {name}: {e}"))?;
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
fn load_profile_source(app: AppHandle, id: String) -> Result<String, String> {
    let dir = profiles_dir(&app)?;
    let path = dir.join(format!("{id}.cfp"));
    std::fs::read_to_string(&path).map_err(|e| format!("read error: {e}"))
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

/// Modification time in unix seconds. Used by the peaks cache to invalidate
/// entries when a file is edited or replaced (rename alone changes the path
/// key, but an in-place edit keeps the path and needs the mtime to differ).
#[tauri::command]
fn file_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    let mtime = meta.modified().map_err(|e| format!("modified: {e}"))?;
    mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("epoch: {e}"))
}

/// Windows filesystems are case-insensitive (and case-preserving), so
/// `C:\Users\...` and `c:\users\...` name the same ancestor. Compare with
/// case folded on Windows only; keep byte-exact on Unix where filesystems
/// are case-sensitive. Output paths use the *target*'s original casing
/// either way — we only relax comparison, not preservation.
#[cfg(target_os = "windows")]
fn path_component_eq(a: &std::path::Component, b: &std::path::Component) -> bool {
    a.as_os_str().to_string_lossy().to_lowercase()
        == b.as_os_str().to_string_lossy().to_lowercase()
}
#[cfg(not(target_os = "windows"))]
fn path_component_eq(a: &std::path::Component, b: &std::path::Component) -> bool {
    a.as_os_str() == b.as_os_str()
}

/// Compute a path relative to the directory containing `base_file` that
/// resolves to `target`. Returns None when no useful relative path exists
/// (e.g. different Windows drive letters) so the caller can fall back to
/// the absolute path. Output always uses forward slashes so the .cod is
/// portable across platforms.
#[tauri::command]
fn compute_relative_path(base_file: String, target: String) -> Option<String> {
    use std::path::{Component, Path};
    let base_dir = Path::new(&base_file).parent()?;
    let target_path = Path::new(&target);
    if !base_dir.is_absolute() || !target_path.is_absolute() {
        return None;
    }

    let base_comps: Vec<Component> = base_dir.components().collect();
    let targ_comps: Vec<Component> = target_path.components().collect();

    // Require matching prefix + root (drive letter on Windows must match).
    let is_root = |c: &Component| matches!(c, Component::Prefix(_) | Component::RootDir);
    let base_root = base_comps.iter().take_while(|c| is_root(c)).count();
    let targ_root = targ_comps.iter().take_while(|c| is_root(c)).count();
    if base_root != targ_root {
        return None;
    }
    for i in 0..base_root {
        if !path_component_eq(&base_comps[i], &targ_comps[i]) {
            return None;
        }
    }

    // Walk past the shared ancestor directories.
    let mut common = base_root;
    while common < base_comps.len().min(targ_comps.len())
        && path_component_eq(&base_comps[common], &targ_comps[common])
    {
        common += 1;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in common..base_comps.len() {
        parts.push("..".into());
    }
    for c in &targ_comps[common..] {
        parts.push(c.as_os_str().to_string_lossy().into_owned());
    }
    Some(if parts.is_empty() { ".".into() } else { parts.join("/") })
}

/// Resolve `relative` against the directory containing `base_file`.
/// Accepts either forward or backward slashes in `relative` so a .cod saved
/// on one OS loads correctly on the other. Does not require the resulting
/// file to exist — the caller decides how to handle a missing target.
#[tauri::command]
fn resolve_relative_path(base_file: String, relative: String) -> Option<String> {
    use std::path::PathBuf;
    let base_dir = std::path::Path::new(&base_file).parent()?;
    let mut p = PathBuf::from(base_dir);
    for part in relative.replace('\\', "/").split('/') {
        if part == ".." {
            p.pop();
        } else if part.is_empty() || part == "." {
            continue;
        } else {
            p.push(part);
        }
    }
    Some(p.to_string_lossy().into_owned())
}

// ── Recent projects ──────────────────────────────────────────────────────────

const RECENT_LIMIT: usize = 10;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    path: String,
    name: String,
    opened_at: String,
}

fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("recent.json"))
        .map_err(|e| format!("app data dir: {e}"))
}

fn read_recent(app: &AppHandle) -> Vec<RecentProject> {
    let Ok(path) = recent_path(app) else { return vec![] };
    if !path.exists() { return vec![] }
    let Ok(raw) = std::fs::read_to_string(&path) else { return vec![] };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_recent(app: &AppHandle, entries: &[RecentProject]) -> Result<(), String> {
    let path = recent_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let serialized = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, serialized).map_err(|e| format!("write recent: {e}"))
}

/// Read the recent list, drop entries whose files no longer exist on disk,
/// and persist the cleaned list back. Returns the cleaned list.
#[tauri::command]
fn get_recent_projects(app: AppHandle) -> Result<Vec<RecentProject>, String> {
    let all = read_recent(&app);
    let cleaned: Vec<RecentProject> = all
        .into_iter()
        .filter(|e| std::path::Path::new(&e.path).is_file())
        .collect();
    // Only rewrite if pruning actually changed the list, to avoid touching
    // the file on every boot.
    let original = read_recent(&app);
    if cleaned.len() != original.len() {
        let _ = write_recent(&app, &cleaned);
    }
    Ok(cleaned)
}

#[tauri::command]
fn add_recent_project(app: AppHandle, path: String, name: String) -> Result<Vec<RecentProject>, String> {
    let mut entries = read_recent(&app);
    // Dedupe by path — moving an existing entry to the front instead of
    // duplicating it.
    entries.retain(|e| e.path != path);
    entries.insert(0, RecentProject {
        path,
        name,
        opened_at: chrono::Local::now().to_rfc3339(),
    });
    entries.truncate(RECENT_LIMIT);
    write_recent(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
fn clear_recent_projects(app: AppHandle) -> Result<(), String> {
    write_recent(&app, &[])
}

/// Drain any paths the OS handed us at launch via file association.
/// Called once from the frontend after sidecar + daemon are ready, so
/// the project load routes through the normal unsaved-changes and
/// fileExists gates. Returns an empty vec if nothing was queued.
#[tauri::command]
fn take_launch_paths(paths: State<LaunchPaths>) -> Vec<String> {
    paths.0.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}

/// Rebuild the "Open Recent" submenu's items from the given list. Called
/// from the frontend whenever the recent signal changes. Also updates the
/// path-mapping state used by `on_menu_event` to dispatch clicks.
#[tauri::command]
fn set_recent_menu(
    app: AppHandle,
    items: State<MenuItems>,
    paths: State<RecentPaths>,
    entries: Vec<RecentProject>,
) -> Result<(), String> {
    let submenu = &items.recent_submenu;

    // Clear existing children.
    let existing = submenu.items().map_err(|e| e.to_string())?;
    for child in existing {
        if let Some(item) = child.as_menuitem() {
            submenu.remove(item).map_err(|e| e.to_string())?;
        } else if let Some(sep) = child.as_predefined_menuitem() {
            submenu.remove(sep).map_err(|e| e.to_string())?;
        }
    }

    if entries.is_empty() {
        let empty = MenuItemBuilder::new("No recent projects")
            .id("menu_recent_empty")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&empty).map_err(|e| e.to_string())?;
    } else {
        for (i, entry) in entries.iter().enumerate() {
            let item = MenuItemBuilder::new(&entry.name)
                .id(format!("menu_recent_{i}"))
                .build(&app)
                .map_err(|e| e.to_string())?;
            submenu.append(&item).map_err(|e| e.to_string())?;
        }
        let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
        submenu.append(&sep).map_err(|e| e.to_string())?;
        let clear = MenuItemBuilder::new("Clear Recent")
            .id("menu_clear_recent")
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&clear).map_err(|e| e.to_string())?;
    }

    // Replace the path mapping atomically with the new ordering.
    let new_paths: Vec<String> = entries.into_iter().map(|e| e.path).collect();
    *paths.0.lock().map_err(|e| e.to_string())? = new_paths;

    Ok(())
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
/// Returns null fps for audio-only files, and vfr=true if variable frame rate detected.
#[tauri::command]
async fn probe_fps(
    app: AppHandle,
    path: String,
    state: State<'_, DaemonState>,
) -> Result<ProbeResult, String> {
    let daemon = {
        let guard = state.lock().await;
        guard.clone().ok_or_else(|| "transcription engine not running".to_string())?
    };

    let r: ProbeResult = daemon
        .request("probe_fps", serde_json::json!({ "path": path }))
        .await?;
    log(&app, &format!("probe_fps: {:?} vfr: {} hasAudio: {}", r.fps, r.vfr, r.has_audio));
    Ok(r)
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
struct ProbeResult {
    fps: Option<f64>,
    #[serde(default)]
    vfr: bool,
    #[serde(default, rename = "hasAudio")]
    has_audio: bool,
}

/// Generate downsampled waveform peaks via the sidecar's bundled ffmpeg.
/// Replaces WaveSurfer's browser-side fetch+decode, which is unreliable
/// for the Tauri asset-protocol path on Windows and chokes on any codec
/// WebAudio can't handle.
#[tauri::command]
async fn generate_peaks(
    app: AppHandle,
    path: String,
    state: State<'_, DaemonState>,
) -> Result<PeaksResult, String> {
    let daemon = {
        let guard = state.lock().await;
        guard.clone().ok_or_else(|| "transcription engine not running".to_string())?
    };

    let r: PeaksResult = daemon
        .request("generate_peaks", serde_json::json!({ "path": path }))
        .await?;
    log(&app, &format!("generate_peaks: bins={} duration={:.2}s", r.peaks.len(), r.duration));
    Ok(r)
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
struct PeaksResult {
    peaks: Vec<f32>,
    duration: f64,
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
    #[serde(rename_all = "camelCase")]
    struct R {
        words: Vec<TranscribedWord>,
        language: String,
        #[serde(default)]
        alignment_degraded: bool,
    }

    let r: R = daemon
        .request_streaming("transcribe", params, on_event)
        .await?;
    Ok(TranscriptionResult {
        words: r.words,
        language: r.language,
        alignment_degraded: r.alignment_degraded,
    })
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance guard: if another Codfish is already running, the OS
    // hands the second process's argv to the first one through this
    // callback (instead of letting it boot a duplicate). We forward any
    // .cod paths into LaunchPaths and raise the existing window, which
    // matches how native apps behave when you double-click a document.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv
                .iter()
                .skip(1)
                .filter(|p| p.ends_with(".cod"))
                .cloned()
                .collect();
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<LaunchPaths>() {
                    if let Ok(mut guard) = state.0.lock() {
                        for p in &paths {
                            guard.push(p.clone());
                        }
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
                if !paths.is_empty() {
                    let _ = window.emit("launch-paths-added", ());
                }
            }
        }));
    }

    builder
        .manage::<DaemonState>(AsyncMutex::new(None))
        .menu(|handle| {
            // ── Native app menu ─────────────────────────────────────────────
            // Built before window creation so accelerators bind to the
            // window's accelerator table on Windows. File menu actions are
            // dispatched to the frontend via "menu://action" so they route
            // through the same guarded handlers as the panel buttons.
            let new_proj = MenuItemBuilder::new("New Project")
                .id("menu_new_project")
                .accelerator("CmdOrCtrl+N")
                .enabled(false)
                .build(handle)?;
            let open_proj = MenuItemBuilder::new("Open Project…")
                .id("menu_open_project")
                .accelerator("CmdOrCtrl+O")
                .enabled(false)
                .build(handle)?;
            let save_proj = MenuItemBuilder::new("Save")
                .id("menu_save_project")
                .accelerator("CmdOrCtrl+S")
                .enabled(false)
                .build(handle)?;
            let save_as = MenuItemBuilder::new("Save As…")
                .id("menu_save_project_as")
                .accelerator("CmdOrCtrl+Shift+S")
                .enabled(false)
                .build(handle)?;
            let revert_proj = MenuItemBuilder::new("Revert")
                .id("menu_revert_project")
                .enabled(false)
                .build(handle)?;
            let close_proj = MenuItemBuilder::new("Close Project")
                .id("menu_close_project")
                .accelerator("CmdOrCtrl+W")
                .enabled(false)
                .build(handle)?;

            // Exit lives in the File menu on Windows/Linux per platform
            // convention. On macOS, Quit lives in the application menu
            // (Codfish ▸ Quit Codfish, Cmd+Q) so a File ▸ Exit is
            // redundant and non-idiomatic — omit it there.
            #[cfg(not(target_os = "macos"))]
            let exit_item = MenuItemBuilder::new("Exit")
                .id("menu_exit")
                .build(handle)?;

            // Open Recent starts with a single disabled placeholder. The
            // frontend repopulates it via set_recent_menu once it's loaded
            // the recent.json list.
            let recent_placeholder = MenuItemBuilder::new("No recent projects")
                .id("menu_recent_empty")
                .enabled(false)
                .build(handle)?;
            let recent_submenu = SubmenuBuilder::new(handle, "Open Recent")
                .item(&recent_placeholder)
                .enabled(false)
                .build()?;

            let file_menu_builder = SubmenuBuilder::new(handle, "File")
                .item(&new_proj)
                .item(&open_proj)
                .item(&recent_submenu)
                .separator()
                .item(&save_proj)
                .item(&save_as)
                .item(&revert_proj)
                .separator()
                .item(&close_proj);

            #[cfg(not(target_os = "macos"))]
            let file_menu_builder = file_menu_builder.separator().item(&exit_item);

            let file_menu = file_menu_builder.build()?;

            let about_item = MenuItemBuilder::new("About Codfish")
                .id("menu_about")
                .enabled(false)
                .build(handle)?;
            let feedback_item = MenuItemBuilder::new("Submit Feedback…")
                .id("menu_feedback")
                .enabled(false)
                .build(handle)?;

            let mut menu_builder = MenuBuilder::new(handle);

            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::new("Quit Codfish")
                    .id("menu_quit")
                    .accelerator("Cmd+Q")
                    .build(handle)?;
                let app_menu = SubmenuBuilder::new(handle, "Codfish")
                    .item(&about_item)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit_item)
                    .build()?;
                menu_builder = menu_builder.item(&app_menu);
            }

            let undo_item = MenuItemBuilder::new("Undo")
                .id("menu_undo")
                .accelerator("CmdOrCtrl+Z")
                .enabled(false)
                .build(handle)?;
            let redo_accel = if cfg!(target_os = "macos") { "Cmd+Shift+Z" } else { "Ctrl+Y" };
            let redo_item = MenuItemBuilder::new("Redo")
                .id("menu_redo")
                .accelerator(redo_accel)
                .enabled(false)
                .build(handle)?;

            // Non-project items also start disabled: pre-splash and splash
            // should have a uniformly inert menu (Exit is the only escape
            // hatch). The frontend flips them on once sidecar + daemon are
            // ready.
            let export_formats = MenuItemBuilder::new("Export Formats…")
                .id("menu_export_formats")
                .enabled(false)
                .build(handle)?;
            let profiles_item = MenuItemBuilder::new("Caption Profiles…")
                .id("menu_profiles")
                .enabled(false)
                .build(handle)?;

            let dark_mode_item = CheckMenuItemBuilder::new("Dark Mode")
                .id("menu_dark_mode")
                .checked(true)
                .enabled(false)
                .build(handle)?;

            menu_builder = menu_builder.item(&file_menu);

            #[cfg(target_os = "macos")]
            {
                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .item(&undo_item)
                    .item(&redo_item)
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .separator()
                    .item(&profiles_item)
                    .item(&export_formats)
                    .build()?;
                let view_menu = SubmenuBuilder::new(handle, "View")
                    .item(&dark_mode_item)
                    .build()?;
                // Note: deliberately omitting .close_window() so Close Project
                // (File menu, Cmd+W) owns the Cmd+W binding — matches Adobe and
                // other document-centric Mac apps. Codfish is single-window so
                // losing the explicit Close Window item costs nothing; the red
                // traffic light and Cmd+Q still cover window/app teardown.
                let window_menu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .build()?;
                let help_menu = SubmenuBuilder::new(handle, "Help")
                    .item(&feedback_item)
                    .build()?;
                menu_builder = menu_builder
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .item(&help_menu);
            }

            #[cfg(not(target_os = "macos"))]
            {
                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .item(&undo_item)
                    .item(&redo_item)
                    .separator()
                    .item(&profiles_item)
                    .item(&export_formats)
                    .build()?;
                let view_menu = SubmenuBuilder::new(handle, "View")
                    .item(&dark_mode_item)
                    .build()?;
                let help_menu = SubmenuBuilder::new(handle, "Help")
                    .item(&feedback_item)
                    .separator()
                    .item(&about_item)
                    .build()?;
                menu_builder = menu_builder
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&help_menu);
            }

            handle.manage(MenuItems {
                new_project: new_proj.clone(),
                open_project: open_proj.clone(),
                save_project: save_proj.clone(),
                save_project_as: save_as.clone(),
                revert_project: revert_proj.clone(),
                close_project: close_proj.clone(),
                undo: undo_item.clone(),
                redo: redo_item.clone(),
                dark_mode: dark_mode_item.clone(),
                export_formats: export_formats.clone(),
                profiles: profiles_item.clone(),
                about: about_item.clone(),
                feedback: feedback_item.clone(),
                recent_submenu: recent_submenu.clone(),
            });
            handle.manage(RecentPaths(StdMutex::new(Vec::new())));
            handle.manage(LaunchPaths(StdMutex::new(Vec::new())));

            menu_builder.build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "menu_exit" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
                return;
            }
            if id == "menu_quit" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("app://quit-requested", ());
                }
                return;
            }
            // Recent project click → look up the path by index and emit a
            // dedicated event so the frontend can route through the unsaved
            // changes gate before loading.
            if let Some(idx_str) = id.strip_prefix("menu_recent_") {
                if idx_str == "empty" { return; }
                if let Ok(idx) = idx_str.parse::<usize>() {
                    let paths = app.state::<RecentPaths>();
                    let path = paths.0.lock().ok().and_then(|p| p.get(idx).cloned());
                    if let (Some(path), Some(window)) = (path, app.get_webview_window("main")) {
                        let _ = window.emit("menu://open-recent", path);
                    }
                }
                return;
            }
            if let Some(action) = id.strip_prefix("menu_") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu://action", action.to_string());
                }
            }
        })
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

            // File association launch (Windows/Linux): stash any .cod path
            // handed to us via argv into LaunchPaths so the frontend can
            // drain it once it's actually ready to load a project. Emitting
            // straight to a webview event here would race the frontend's
            // listener, which doesn't attach until App.tsx mounts.
            // (macOS delivers this via RunEvent::Opened in the run loop
            // below, not via argv.)
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = args.get(1) {
                if path.ends_with(".cod") {
                    if let Ok(mut guard) = app.state::<LaunchPaths>().0.lock() {
                        guard.push(path.clone());
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
            save_user_format,
            delete_user_format,
            open_in_explorer,
            save_project,
            load_project,
            file_exists,
            file_mtime,
            compute_relative_path,
            resolve_relative_path,
            generate_peaks,
            save_recovery,
            load_recovery,
            clear_recovery,
            probe_fps,
            get_log_path,
            frontend_log,
            set_menu_enabled,
            set_menu_text,
            set_menu_checked,
            get_recent_projects,
            add_recent_project,
            clear_recent_projects,
            take_launch_paths,
            set_recent_menu,
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
            load_profile_source,
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
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !ALLOW_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("app://quit-requested", ());
                    }
                }
            }

            // macOS file association: Finder delivers .cod double-clicks as
            // an Apple event which Tauri surfaces here, NOT via argv. Stash
            // the paths into LaunchPaths; if the frontend has already
            // drained an earlier batch, also emit a live event so an
            // already-running app reacts to the second file.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("cod"))
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<LaunchPaths>() {
                        if let Ok(mut guard) = state.0.lock() {
                            for p in &paths {
                                guard.push(p.clone());
                            }
                        }
                    }
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("launch-paths-added", ());
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
