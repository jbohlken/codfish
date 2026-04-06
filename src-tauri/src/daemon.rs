//! Long-lived sidecar daemon manager.
//!
//! Owns a single child process for the lifetime of the app, multiplexes
//! request/response over its stdin/stdout, and exposes a small async API
//! to the rest of the Rust code.
//!
//! Wire protocol (JSON Lines, see sidecar/transcribe.py):
//!   → {"id":"<rid>","op":"...","params":{...}}
//!   ← {"event":"booting"} | {"event":"ready","device":"..."}
//!   ← {"id":"<rid>","event":"progress",...}
//!   ← {"id":"<rid>","ok":true,"result":{...}}
//!   ← {"id":"<rid>","ok":false,"error":"..."}

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::sidecar;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DaemonStatus {
    NotInstalled,
    Booting,
    Ready { device: String },
    Crashed { reason: String },
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;
type Streaming = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>;

pub struct SidecarDaemon {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    streaming: Streaming,
    status_rx: watch::Receiver<DaemonStatus>,
    child: Mutex<Child>,
}

impl SidecarDaemon {
    /// Spawn the sidecar binary and wire up the reader tasks.
    /// Returns immediately — readiness is observed via [`Self::subscribe_status`].
    pub fn spawn(app: &AppHandle) -> Result<Arc<Self>, String> {
        let bin = sidecar::sidecar_bin_path(app).map_err(|e| e.to_string())?;
        if !bin.exists() {
            return Err("Transcription engine not installed.".into());
        }

        // Run from the bin directory so PyInstaller's `--runtime-tmpdir "."`
        // resolves to a stable, writable location next to the binary.
        let bin_dir = bin
            .parent()
            .ok_or("sidecar binary has no parent dir")?
            .to_path_buf();

        let mut cmd = Command::new(&bin);
        cmd.current_dir(&bin_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Suppress the console window flash on Windows when launching the sidecar.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

        let stdin = child.stdin.take().ok_or("missing child stdin")?;
        let stdout = child.stdout.take().ok_or("missing child stdout")?;
        let stderr = child.stderr.take().ok_or("missing child stderr")?;

        let (status_tx, status_rx) = watch::channel(DaemonStatus::Booting);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let streaming: Streaming = Arc::new(Mutex::new(HashMap::new()));

        // stdout reader — protocol channel. EOF on this stream is the
        // authoritative "child is gone" signal. We deliberately do NOT poll
        // try_wait() on the child handle: on macOS that races with SIGCHLD
        // reaping when the child spawns subprocesses (ffmpeg, model download,
        // torch workers) and can return a bogus exit status for a still-living
        // parent, which would falsely flip the UI to crashed mid-transcription.
        {
            let pending = pending.clone();
            let streaming = streaming.clone();
            let status_tx = status_tx.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let reason: String = loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            handle_line(&line, &pending, &streaming, &status_tx).await;
                        }
                        Ok(None) => break "sidecar stdout closed".to_string(),
                        Err(e) => break format!("sidecar stdout read error: {e}"),
                    }
                };
                eprintln!("[daemon] {reason}");
                crate::log(&app, &format!("daemon: CRASHED — {reason}"));
                let _ = status_tx.send(DaemonStatus::Crashed { reason: reason.clone() });
                // Drain pending callers so they don't hang forever.
                let mut p = pending.lock().await;
                for (_, tx) in p.drain() {
                    let _ = tx.send(Err(reason.clone()));
                }
                drop(p);
                streaming.lock().await.clear();
            });
        }

        // stderr reader — log channel. Mirror every line to codfish.log so
        // we have a real audit trail when the sidecar dies mid-transcription.
        {
            let app = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[sidecar] {line}");
                    crate::log(&app, &format!("[sidecar] {line}"));
                }
            });
        }

        let daemon = Arc::new(SidecarDaemon {
            stdin: Mutex::new(stdin),
            pending,
            streaming,
            status_rx,
            child: Mutex::new(child),
        });

        Ok(daemon)
    }

    /// Synchronously kill the child and wait for it to fully exit. Used
    /// before sidecar updates so Windows releases its lock on the executable.
    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    pub fn current_status(&self) -> DaemonStatus {
        self.status_rx.borrow().clone()
    }

    pub fn subscribe_status(&self) -> watch::Receiver<DaemonStatus> {
        self.status_rx.clone()
    }

/// Send a one-shot request and await the typed response.
    pub async fn request<T: DeserializeOwned>(
        &self,
        op: &str,
        params: Value,
    ) -> Result<T, String> {
        let rid = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(rid.clone(), tx);

        let req = serde_json::json!({ "id": rid, "op": op, "params": params });
        let line = format!("{}\n", req);
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write to sidecar failed: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("flush sidecar failed: {e}"))?;
        }

        let result = rx
            .await
            .map_err(|_| "sidecar dropped response (likely crashed)".to_string())??;
        serde_json::from_value::<T>(result).map_err(|e| format!("decode response: {e}"))
    }

    /// Send a request and pump streaming events to `on_event` until the
    /// final response arrives.
    pub async fn request_streaming<T, F>(
        &self,
        op: &str,
        params: Value,
        on_event: F,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
        F: Fn(Value) + Send + 'static,
    {
        let rid = uuid::Uuid::new_v4().to_string();
        let (resp_tx, resp_rx) = oneshot::channel();
        self.pending.lock().await.insert(rid.clone(), resp_tx);

        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Value>();
        self.streaming.lock().await.insert(rid.clone(), ev_tx);

        // Forward events
        let rid_for_cleanup = rid.clone();
        let streaming = self.streaming.clone();
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                on_event(ev);
            }
            // Channel closed — clean up our slot just in case
            streaming.lock().await.remove(&rid_for_cleanup);
        });

        let req = serde_json::json!({ "id": rid, "op": op, "params": params });
        let line = format!("{}\n", req);
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write to sidecar failed: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("flush sidecar failed: {e}"))?;
        }

        let result = resp_rx
            .await
            .map_err(|_| "sidecar dropped response (likely crashed)".to_string())??;
        // Drop the streaming sender so the forwarder task exits
        self.streaming.lock().await.remove(&rid);
        serde_json::from_value::<T>(result).map_err(|e| format!("decode response: {e}"))
    }
}

async fn handle_line(
    line: &str,
    pending: &Pending,
    streaming: &Streaming,
    status_tx: &watch::Sender<DaemonStatus>,
) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        eprintln!("[daemon] non-JSON stdout line: {line}");
        return;
    };

    // Lifecycle events have no `id`.
    if msg.get("id").is_none() {
        if let Some(event) = msg.get("event").and_then(|v| v.as_str()) {
            match event {
                "booting" => {
                    let _ = status_tx.send(DaemonStatus::Booting);
                }
                "ready" => {
                    let device = msg
                        .get("device")
                        .and_then(|v| v.as_str())
                        .unwrap_or("cpu")
                        .to_string();
                    let _ = status_tx.send(DaemonStatus::Ready { device });
                }
                _ => {}
            }
        }
        return;
    }

    let rid = msg
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Streaming progress event
    if msg.get("event").is_some() {
        if let Some(tx) = streaming.lock().await.get(&rid) {
            let _ = tx.send(msg);
        }
        return;
    }

    // Final response: pop the pending oneshot
    let sender = pending.lock().await.remove(&rid);
    let Some(sender) = sender else {
        eprintln!("[daemon] response for unknown rid: {rid}");
        return;
    };

    let ok = msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        let result = msg.get("result").cloned().unwrap_or(Value::Null);
        let _ = sender.send(Ok(result));
    } else {
        let err = msg
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown sidecar error")
            .to_string();
        let _ = sender.send(Err(err));
    }
}
