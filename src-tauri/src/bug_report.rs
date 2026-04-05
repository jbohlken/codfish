use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const GITHUB_REPO: &str = "jbohlken/codfish";

/// Decode the XOR-encoded PAT embedded at compile time.
fn github_token() -> Result<String, String> {
    let encoded = env!("GH_PAT_XOR");
    if encoded.is_empty() {
        return Err("Bug reporting is not configured in this build.".to_string());
    }
    let key = 0xA5u8;
    let bytes: Vec<u8> = encoded
        .split(',')
        .filter_map(|s| u8::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .map(|b| b ^ key)
        .collect();
    String::from_utf8(bytes).map_err(|e| format!("token decode error: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    title: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReportResult {
    pub url: String,
    pub number: u64,
}

fn collect_system_info(app: &AppHandle) -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let app_version = app.package_info().version.to_string();

    // Read sidecar meta if available
    let sidecar_info = match crate::sidecar::sidecar_bin_path(app) {
        Ok(bin) if bin.exists() => {
            let meta_path = bin.parent().unwrap().join("sidecar.json");
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
                    format!(
                        "v{} ({})",
                        meta.get("version").and_then(|v| v.as_str()).unwrap_or("?"),
                        meta.get("variant").and_then(|v| v.as_str()).unwrap_or("?"),
                    )
                } else {
                    "installed (meta unreadable)".to_string()
                }
            } else {
                "installed (no meta)".to_string()
            }
        }
        _ => "not installed".to_string(),
    };

    format!(
        "| Field | Value |\n|---|---|\n| OS | {} {} |\n| App version | {} |\n| Sidecar | {} |",
        os, arch, app_version, sidecar_info
    )
}

#[tauri::command]
pub async fn submit_bug_report(
    app: AppHandle,
    report: BugReport,
) -> Result<BugReportResult, String> {
    let system_info = collect_system_info(&app);

    let body = format!(
        "{}\n\n---\n\n### System Info\n{}",
        report.description, system_info
    );

    let payload = serde_json::json!({
        "title": report.title,
        "body": body,
        "labels": ["bug", "user-report"],
    });

    let token = github_token()?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://api.github.com/repos/{GITHUB_REPO}/issues"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Codfish")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {status}: {text}"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse error: {e}"))?;

    Ok(BugReportResult {
        url: json["html_url"].as_str().unwrap_or("").to_string(),
        number: json["number"].as_u64().unwrap_or(0),
    })
}
