import { project, isDirty, activeProfile, profiles, pushHistory, canUndo, canRedo, undo, redo, undoDescription, redoDescription } from "../../store/app";
import { saveCurrentProject, saveCurrentProjectAs, newProjectGuarded, openProjectGuarded, savedFlash } from "../../lib/project";
import { profileEditorOpen } from "../ProfileEditor";
import { helpOpen } from "../HelpModal";
import { theme, toggleTheme } from "../../store/theme";

export function TitleBar() {
  const proj = project.value;
  const dirty = isDirty.value;
  const profile = activeProfile.value;

  return (
    <div class="titlebar">
      <div class="titlebar-left">
        <span class="titlebar-app-name">Codfish</span>
        {proj && (
          <>
            <span class="titlebar-divider">/</span>
            <span class="titlebar-project-name">
              {proj.name}
              {dirty && <span class="titlebar-dirty" title="Unsaved changes">•</span>}
            </span>
          </>
        )}
      </div>

      <div class="titlebar-center" />

      <div class="titlebar-right">
        {/* New / Open — always visible */}
        <button
          class="btn btn-ghost btn-sm"
          onClick={newProjectGuarded}
          title="New Project"
        >
          New
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick={openProjectGuarded}
          title="Open Project"
        >
          Open…
        </button>

        {/* Theme toggle — always visible */}
        <button
          class="btn btn-ghost btn-icon"
          title={theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          {theme.value === "dark" ? "☀" : "☾"}
        </button>

        {/* Help — always visible */}
        <button
          class="btn btn-ghost btn-icon"
          title="Help"
          onClick={() => { helpOpen.value = true; }}
        >
          ?
        </button>

        {proj && (
          <>
            <div class="titlebar-divider" />

            {/* Undo / Redo */}
            <button
              class="btn btn-ghost btn-icon"
              onClick={undo}
              disabled={!canUndo.value}
              title={undoDescription.value ? `Undo: ${undoDescription.value} (Ctrl+Z)` : "Nothing to undo"}
            >
              ↩
            </button>
            <button
              class="btn btn-ghost btn-icon"
              onClick={redo}
              disabled={!canRedo.value}
              title={redoDescription.value ? `Redo: ${redoDescription.value} (Ctrl+Y)` : "Nothing to redo"}
            >
              ↪
            </button>

            <div class="titlebar-divider" />

            {/* Profile selector */}
            <select
              class="titlebar-profile-select"
              value={profile.id}
              onChange={(e) => {
                if (project.value) {
                  pushHistory({ ...project.value, profileId: e.currentTarget.value }, "Change profile");
                }
              }}
            >
              {profiles.value.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              class="btn btn-ghost btn-icon"
              title="Edit profile"
              onClick={() => { profileEditorOpen.value = true; }}
            >
              ✎
            </button>

            <div class="titlebar-divider" />

            {/* Save */}
            <button
              class="btn btn-secondary btn-sm"
              onClick={saveCurrentProjectAs}
              title="Save As…"
            >
              Save As…
            </button>
            <button
              class={`btn btn-sm${savedFlash.value ? " btn-success" : " btn-primary"}`}
              disabled={!dirty && !savedFlash.value}
              onClick={saveCurrentProject}
              title="Save (Ctrl+S)"
            >
              {savedFlash.value ? "Saved!" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
