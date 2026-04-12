import { invoke } from "@tauri-apps/api/core";
import { daemonStatus, daemonError } from "../store/app";
import iconUrl from "../assets/codfish-alpha.svg";

export async function startDaemon() {
  daemonStatus.value = "booting";
  daemonError.value = null;
  try {
    await invoke("start_daemon");
    // If the daemon was already running, start_daemon returns immediately
    // without re-emitting a status event. Poll the actual status so the
    // frontend catches up (fixes F5 reload getting stuck on splash).
    const status = await invoke<{ state: string; reason?: string }>("get_daemon_status");
    if (status.state === "ready") {
      daemonStatus.value = "ready";
      daemonError.value = null;
    }
  } catch (e: any) {
    daemonStatus.value = "crashed";
    daemonError.value = typeof e === "string" ? e : e?.message ?? "Failed to start engine";
  }
}

export function Splash() {
  const crashed = daemonStatus.value === "crashed";

  return (
    <div class="splash">
      <div class="splash-inner">
        <img src={iconUrl} class="splash-icon" alt="Codfish" />
        {crashed ? (
          <>
            <div class="splash-error">{daemonError.value ?? "Engine failed to start"}</div>
            <button class="splash-retry" onClick={startDaemon}>Retry</button>
          </>
        ) : (
          <div class="splash-message">Starting transcription engine…</div>
        )}
      </div>
    </div>
  );
}
