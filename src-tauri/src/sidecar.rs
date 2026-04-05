use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use tauri::{AppHandle, Emitter, Manager, Window};
use futures_util::StreamExt;
use std::collections::HashMap;

// ── Constants ────────────────────────────────────────────────────────────────

const SIDECAR_RELEASES_API: &str =
    "https://api.github.com/repos/jbohlken/codfish/releases";

const SIDECAR_BIN_NAME: &str = if cfg!(windows) {
    "transcribe.exe"
} else {
    "transcribe"
};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarMeta {
    pub version: String,
    pub variant: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum SidecarStatus {
    NotInstalled,
    Ready { version: String, variant: String },
    UpdateAvailable { current: String, latest: String, variant: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub has_cuda: bool,
    pub gpu_name: Option<String>,
    pub vram_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
}

#[derive(Debug, Deserialize)]
struct SidecarManifest {
    version: String,
    variants: HashMap<String, VariantInfo>,
}

#[derive(Debug, Deserialize)]
struct VariantInfo {
    /// Direct download URL (single-file variants)
    url: Option<String>,
    /// SHA-256 of the full binary (single or reassembled)
    sha256: String,
    /// Total size in bytes
    size_bytes: u64,
    /// For multi-part downloads (when the binary exceeds hosting limits)
    parts: Option<Vec<PartInfo>>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PartInfo {
    url: String,
    sha256: String,
    size_bytes: u64,
}

// ── Manifest fetching ────────────────────────────────────────────────────────

async fn fetch_sidecar_manifest(client: &reqwest::Client) -> Result<SidecarManifest, String> {
    // Find the latest sidecar-v* release via the GitHub API
    let releases: Vec<serde_json::Value> = client
        .get(SIDECAR_RELEASES_API)
        .header("User-Agent", "codfish")
        .send()
        .await
        .map_err(|e| format!("fetch releases: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse releases: {e}"))?;

    for release in &releases {
        let tag = release.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
        if !tag.starts_with("sidecar-v") {
            continue;
        }
        // Find the sidecar-manifest.json asset in this release
        let assets = release.get("assets").and_then(|a| a.as_array());
        if let Some(assets) = assets {
            for asset in assets {
                let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name == "sidecar-manifest.json" {
                    let url = asset
                        .get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .ok_or("missing manifest download URL")?;
                    let manifest: SidecarManifest = client
                        .get(url)
                        .header("User-Agent", "codfish")
                        .send()
                        .await
                        .map_err(|e| format!("fetch manifest: {e}"))?
                        .json()
                        .await
                        .map_err(|e| format!("parse manifest: {e}"))?;
                    return Ok(manifest);
                }
            }
        }
    }

    Err("no sidecar release found".into())
}

// ── Path helpers ─────────────────────────────────────────────────────────────

fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("bin"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

pub fn sidecar_bin_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_dir(app).map(|d| d.join(SIDECAR_BIN_NAME))
}

fn sidecar_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_dir(app).map(|d| d.join("sidecar.json"))
}

fn read_meta(app: &AppHandle) -> Result<Option<SidecarMeta>, String> {
    let path = sidecar_meta_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("read sidecar meta: {e}"))?;
    let meta: SidecarMeta = serde_json::from_str(&data)
        .map_err(|e| format!("parse sidecar meta: {e}"))?;
    Ok(Some(meta))
}

fn write_meta(app: &AppHandle, meta: &SidecarMeta) -> Result<(), String> {
    let path = sidecar_meta_path(app)?;
    let data = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("serialize sidecar meta: {e}"))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("write sidecar meta: {e}"))?;
    Ok(())
}

// ── Target triple ────────────────────────────────────────────────────────────

fn target_triple() -> &'static str {
    if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_sidecar_status(app: AppHandle) -> Result<SidecarStatus, String> {
    let bin = sidecar_bin_path(&app)?;
    if !bin.exists() {
        return Ok(SidecarStatus::NotInstalled);
    }
    match read_meta(&app)? {
        Some(meta) => Ok(SidecarStatus::Ready {
            version: meta.version,
            variant: meta.variant,
        }),
        None => {
            // Binary exists but no metadata — treat as ready with unknown version
            Ok(SidecarStatus::Ready {
                version: "unknown".to_string(),
                variant: "unknown".to_string(),
            })
        }
    }
}

#[tauri::command]
pub fn detect_gpu() -> GpuInfo {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let line = text.trim();
            let parts: Vec<&str> = line.splitn(2, ',').collect();
            GpuInfo {
                has_cuda: true,
                gpu_name: Some(parts[0].trim().to_string()),
                vram_mb: parts.get(1).and_then(|s| s.trim().parse().ok()),
            }
        }
        _ => GpuInfo {
            has_cuda: false,
            gpu_name: None,
            vram_mb: None,
        },
    }
}

#[tauri::command]
pub async fn check_sidecar_update(app: AppHandle) -> Result<SidecarStatus, String> {
    let meta = match read_meta(&app)? {
        Some(m) => m,
        None => return Ok(SidecarStatus::NotInstalled),
    };

    let bin = sidecar_bin_path(&app)?;
    if !bin.exists() {
        return Ok(SidecarStatus::NotInstalled);
    }

    let client = reqwest::Client::new();
    let manifest = fetch_sidecar_manifest(&client).await?;

    if manifest.version != meta.version {
        Ok(SidecarStatus::UpdateAvailable {
            current: meta.version,
            latest: manifest.version,
            variant: meta.variant,
        })
    } else {
        Ok(SidecarStatus::Ready {
            version: meta.version,
            variant: meta.variant,
        })
    }
}

#[tauri::command]
pub async fn download_sidecar(
    app: AppHandle,
    window: Window,
    variant: String,
) -> Result<(), String> {
    // 1. Fetch manifest
    let client = reqwest::Client::new();
    let manifest = fetch_sidecar_manifest(&client).await?;

    // 2. Look up the variant
    let triple = target_triple();
    let variant_key = format!("{variant}-{triple}");
    let info = manifest
        .variants
        .get(&variant_key)
        .ok_or_else(|| format!("variant '{variant_key}' not found in manifest"))?;

    // 3. Ensure target directory exists
    let dir = sidecar_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    let bin_path = sidecar_bin_path(&app)?;
    let tmp_path = dir.join("transcribe.tmp");

    // 4. Build list of URLs to download
    let total_bytes = info.size_bytes;
    let downloads: Vec<(&str, u64)> = if let Some(parts) = &info.parts {
        parts.iter().map(|p| (p.url.as_str(), p.size_bytes)).collect()
    } else if let Some(url) = &info.url {
        vec![(url.as_str(), info.size_bytes)]
    } else {
        return Err("variant has no url or parts".into());
    };

    // 5. Stream download (multiple parts concatenated into one file)
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("create temp file: {e}"))?;
    let mut last_percent: u8 = 0;

    for (url, _part_size) in &downloads {
        let response = client
            .get(*url)
            .send()
            .await
            .map_err(|e| format!("download: {e}"))?;

        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk)
                .map_err(|e| format!("write chunk: {e}"))?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;

            let percent = if total_bytes > 0 {
                ((downloaded as f64 / total_bytes as f64) * 100.0) as u8
            } else {
                0
            };

            if percent != last_percent {
                last_percent = percent;
                let _ = window.emit(
                    "sidecar://download-progress",
                    DownloadProgress {
                        downloaded_bytes: downloaded,
                        total_bytes,
                        percent,
                    },
                );
            }
        }
    }

    drop(file);

    // 6. Verify SHA-256 of the full reassembled binary
    let hash = format!("{:x}", hasher.finalize());
    if hash != info.sha256 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "SHA-256 mismatch: expected {}, got {hash}",
            info.sha256
        ));
    }

    // 7. Atomic rename into place
    if bin_path.exists() {
        std::fs::remove_file(&bin_path)
            .map_err(|e| format!("remove old binary: {e}"))?;
    }
    std::fs::rename(&tmp_path, &bin_path)
        .map_err(|e| format!("rename: {e}"))?;

    // 8. Write metadata
    write_meta(
        &app,
        &SidecarMeta {
            version: manifest.version,
            variant,
            sha256: hash,
        },
    )?;

    Ok(())
}
