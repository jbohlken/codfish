import { useEffect } from "preact/hooks";
import { FilmSlateIcon as FilmSlate, MusicNoteIcon as MusicNote, WarningCircleIcon as WarningCircle, PlusIcon as Plus, FilePlusIcon as FilePlus, FolderOpenIcon as FolderOpen } from "@phosphor-icons/react";
import { signal } from "@preact/signals";
import { project, selectedMediaId, pushHistory } from "../../store/app";
import {
  newProjectGuarded,
  openProjectGuarded,
  openRecent,
  importMedia,
  relinkMediaItem,
  fileExists,
  VIDEO_EXTS,
} from "../../lib/project";
import { recentProjects } from "../../lib/recent";
import { showContextMenu } from "../ContextMenu";
import { hideTooltip } from "../Tooltip";
import { mediaSettingsId } from "../MediaSettings";
import type { MediaItem } from "../../types/project";

const missingIds = signal<ReadonlySet<string>>(new Set());

async function checkMissingMedia(items: MediaItem[]) {
  if (items.length === 0) {
    missingIds.value = new Set();
    return;
  }
  const results = await Promise.all(
    items.map(async (m) => ({ id: m.id, missing: !(await fileExists(m.path)) }))
  );
  missingIds.value = new Set(results.filter((r) => r.missing).map((r) => r.id));
}

function removeMedia(mediaId: string) {
  const proj = project.value;
  if (!proj) return;
  const updated = proj.media.filter((m) => m.id !== mediaId);
  pushHistory({ ...proj, media: updated }, "Remove media");
  if (selectedMediaId.value === mediaId) {
    selectedMediaId.value = updated[0]?.id ?? null;
  }
}

export function ProjectPanel() {
  const proj = project.value;
  const selectedId = selectedMediaId.value;

  useEffect(() => {
    checkMissingMedia(proj?.media ?? []);
  }, [proj?.media]);

  return (
    <div class="panel project-panel">
      <div class="panel-header">
        <span class="panel-header-title">Project</span>
        {proj && (
          <button
            class="btn btn-ghost btn-icon"
            data-tooltip="Import media"
            onClick={importMedia}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      <div class="panel-body scrollable">
        {!proj ? (
          <div class="empty-state">
            <span class="empty-state-title">No project open</span>
            <span class="empty-state-body">Create or open a project to get started.</span>
            <div class="project-panel-actions">
              <button class="btn btn-primary btn-sm" onClick={newProjectGuarded}><FilePlus size={13} /> New Project</button>
              <button class="btn btn-secondary btn-sm" onClick={openProjectGuarded}><FolderOpen size={13} /> Open…</button>
            </div>
            {recentProjects.value.length > 0 && (
              <div class="project-panel-recent">
                <span class="project-panel-recent-title">Recent</span>
                {recentProjects.value.slice(0, 5).map((r) => (
                  <button
                    key={r.path}
                    class="project-panel-recent-item"
                    data-tooltip={r.path}
                    onClick={() => {
                      hideTooltip();
                      openRecent(r.path);
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : proj.media.length === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No media</span>
            <span class="empty-state-body">Import a video or audio file to begin.</span>
          </div>
        ) : (
          <div class="media-list">
            {proj.media.map((item) => (
              <MediaRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                missing={missingIds.value.has(item.id)}
                onClick={() => { selectedMediaId.value = item.id; }}
                onContextMenu={(e) => {
                  showContextMenu(e, [
                    {
                      label: "Settings…",
                      onClick: () => { mediaSettingsId.value = item.id; },
                    },
                    {
                      label: "Re-link file…",
                      onClick: () => relinkMediaItem(item.id),
                    },
                    {
                      label: "Remove from project",
                      danger: true,
                      onClick: () => removeMedia(item.id),
                    },
                  ]);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaRow({ item, selected, missing, onClick, onContextMenu }: {
  item: MediaItem;
  selected: boolean;
  missing: boolean;
  onClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const meta = missing
    ? "File not found"
    : item.captions.length > 0
      ? `${item.captions.length} captions`
      : "No captions";

  const fpsLabel = item.fps != null
    ? `${item.fps} fps${item.dropFrame != null ? (item.dropFrame ? " DF" : " NDF") : ""}`
    : null;

  return (
    <button
      class={`media-row ${selected ? "media-row--selected" : ""} ${missing ? "media-row--missing" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span class="media-row-icon">{getMediaIcon(item.path)}</span>
      <span class="media-row-info">
        <span class="media-row-name">{item.name}</span>
        <span class={`media-row-meta ${missing ? "media-row-meta--warning" : ""}`}>
          {missing && <WarningCircle size={11} />}{meta}
          {fpsLabel && !missing && (
            <span class="media-row-fps">{fpsLabel}</span>
          )}
        </span>
      </span>
    </button>
  );
}

function getMediaIcon(path: string) {
  const ext = path.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.includes(ext)
    ? <FilmSlate size={14} />
    : <MusicNote size={14} />;
}
