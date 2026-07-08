//! App self-update: OS-version detection, channel-aware check, and install.
//!
//! Why this lives in Rust rather than the JS `@tauri-apps/plugin-updater`:
//! the JS `check()` cannot switch endpoints at runtime, and update CHANNELS
//! (stable vs beta) require exactly that. Runtime endpoint selection is only
//! available through the Rust `updater_builder().endpoints(...)` API, so the
//! check and install move here and the frontend drives them via commands.
//!
//! The OS-version GATE is deliberately NOT enforced here — this layer just
//! surfaces the release's declared floor (`minimumSystemVersion` for the
//! running platform, read from the manifest) so the frontend can decide
//! whether to offer the update or show a "needs a newer OS" note. The
//! signature-verified install is unchanged.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

// Fixed manifest locations. Stable rides GitHub's "latest release" pointer,
// which excludes prereleases — so betas are invisible to stable for free.
// Beta is a dedicated asset on a standing `beta` release, re-uploaded by CI
// on every prerelease build (GitHub has no "latest-including-prerelease" URL).
const STABLE_URL: &str =
    "https://github.com/jbohlken/codfish/releases/latest/download/latest.json";
const BETA_URL: &str =
    "https://github.com/jbohlken/codfish/releases/download/beta/beta.json";

fn endpoint(beta: bool) -> &'static str {
    if beta { BETA_URL } else { STABLE_URL }
}

/// The manifest key for the running platform's OS floor. Mirrors Rust's
/// `std::env::consts::OS` → the `minimumSystemVersion` object's keys.
fn manifest_os_key() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

#[derive(Serialize)]
pub struct OsInfo {
    /// "macos" | "windows" | "linux" — `std::env::consts::OS`.
    pub os: String,
    /// e.g. "13.4.1" on macOS, "10.0.22631" on Windows. "Unknown" if the
    /// platform can't report it (the frontend treats that as "no gate").
    pub version: String,
}

#[tauri::command]
pub fn get_os_version() -> OsInfo {
    let info = os_info::get();
    OsInfo {
        os: std::env::consts::OS.to_string(),
        version: info.version().to_string(),
    }
}

#[derive(Serialize)]
pub struct AppUpdateMeta {
    pub version: String,
    pub notes: Option<String>,
    /// The release's declared minimum OS version for THIS platform, if the
    /// manifest carries one. None for fieldless (pre-0.6.10) manifests and
    /// for platforms with no declared floor — the frontend then imposes no
    /// gate, exactly as before this feature.
    pub minimum_system_version: Option<String>,
}

/// Read `minimumSystemVersion.<os>` for the running platform out of the FULL
/// manifest the updater already fetched and parsed (`Update::raw_json`). No
/// second network request — a separate GET could fail (rate-limit / CDN
/// blip) and silently drop the floor, which would fail the gate OPEN and
/// let a below-floor OS install a build it can't launch. None only when the
/// manifest genuinely carries no floor for this platform.
fn read_min_os(raw: &serde_json::Value) -> Option<String> {
    raw.get("minimumSystemVersion")?
        .get(manifest_os_key())?
        .as_str()
        // A blank floor means "no requirement" — mirror the JS gate's falsy
        // check so the native and UI gates agree.
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// True if the running OS `current` (dotted numeric) meets the `required`
/// floor. Fail-safe: an OS string with no digits (e.g. "Unknown") never
/// satisfies a real floor. Mirrors the frontend `isOsSupported` so the
/// native install gate and the UI gate agree.
fn os_meets(current: &str, required: &str) -> bool {
    if !current.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    // Leading numeric run per segment (matches JS parseInt: "4a" → 4, "x" → 0)
    // so the native gate and the JS isOsSupported agree on odd inputs.
    let seg = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (seg(current), seg(required));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    true
}

/// Check the channel's endpoint for an available update. Returns None when
/// up to date. Does NOT gate on OS — it surfaces the floor (from the manifest
/// the updater already fetched) so the frontend can show a note; the install
/// command re-applies the gate natively as the real safety boundary.
#[tauri::command]
pub async fn check_app_update(app: AppHandle, beta: bool) -> Result<Option<AppUpdateMeta>, String> {
    let url = endpoint(beta);
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![parsed])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(AppUpdateMeta {
            version: update.version.clone(),
            notes: update.body.clone(),
            minimum_system_version: read_min_os(&update.raw_json),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download + install the channel's available update, emitting
/// `app-update://progress` ({ downloaded, total }) as it goes. Re-checks
/// rather than holding the `Update` handle across commands (a second network
/// round-trip is trivial and avoids cross-command state), then re-applies the
/// OS-version gate NATIVELY against whatever it is about to install. This is
/// the authoritative safety boundary: even if the frontend gate was stale or
/// the channel's manifest raised its floor between check and click, a build
/// this OS cannot launch is never installed. The frontend relaunches once
/// this resolves.
#[tauri::command]
pub async fn install_app_update(app: AppHandle, beta: bool) -> Result<(), String> {
    let url = endpoint(beta);
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![parsed])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available.".to_string())?;

    if let Some(min) = read_min_os(&update.raw_json) {
        let current = os_info::get().version().to_string();
        if !os_meets(&current, &min) {
            return Err(format!(
                "This update requires a newer operating system (minimum {min})."
            ));
        }
    }

    let mut downloaded: u64 = 0;
    let app_for_progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app_for_progress.emit(
                    "app-update://progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
