# Codfish release engineering — the OS-version gate & update channels (0.6.10)

0.6.10 is a maintenance release cut off the 0.6.9 line (NOT off the 0.7.0
styling branch — it must ship, and reach users, BEFORE 0.7.0). It carries
no features; it exists to make future updates safe and stageable.

## The problem it solves

0.7.0 raises the macOS floor to 13.4 (its caption-preview CSS needs WebKit
16.5, which on macOS comes only with the OS). 0.6.9's updater has NO
OS-version awareness — Tauri's updater never checks the target's OS
against a release's requirement. So once 0.7.0 becomes the GitHub "latest"
release, a 0.6.9 user on macOS < 13.4 who clicks Update installs a bundle
whose LSMinimumSystemVersion blocks launch: a bricked install, recoverable
only by hand-downloading an old build.

The fix has two halves that reinforce each other:
1. An OS-version GATE so a client refuses an update its OS can't run.
2. Update CHANNELS so 0.7.0 can roll out to opted-in beta users first and
   only become "latest" once 0.6.10 adoption is high.

## Half 1 — the OS-version gate

**Producer (CI).** The updater manifest (`latest.json`, assembled in
release-app.yml) gains an optional custom field per platform:
`minimumSystemVersion`. 0.6.10's own manifest sets the historical baseline
(effectively no floor); 0.7.0's manifest (built from the 0.7.0 branch) sets
darwin = "13.4". Tauri ignores unknown manifest fields, so this is additive
and safe for every existing client.

**Consumer (client).** Before OFFERING an update, the client:
1. detects the running OS version (Rust `get_os_version`, via the `os_info`
   crate — no new JS plugin/permission);
2. reads the offered release's `minimumSystemVersion` for this platform
   from the manifest;
3. compares. If the running OS is below the floor, the update is NOT
   offered — instead a one-line "Update available, requires macOS 13.4+"
   note. The Tauri install path is never reached.

Absent field ⇒ no floor (0.6.9's fieldless manifest, and Windows, behave
exactly as today). The gate is pure, testable TS
(`isOsSupported(current, required)` + a numeric-segment `compareVersions`);
OS strings come from Rust. This is a UX gate, not a security boundary —
the signature-verified install is unchanged.

**Reach limitation (honest):** the gate only protects users who are ON
0.6.10. 0.6.9 stragglers have no gate. The channel rollout below is what
protects them — 0.7.0 simply won't be "latest" until we say so.

## Half 2 — update channels (stable / beta)

**Why Rust owns the update flow now.** Verified against the Tauri v2 docs:
the JS `check()` cannot override the endpoint or select a channel — runtime
endpoint switching is Rust-only (`app.updater_builder().endpoints(...)`).
So the check+install move behind Rust commands that pick the endpoint from
a persisted channel preference. The JS UpdateNotice becomes a thin UI over
those commands (progress still arrives as events).

- `check_app_update(beta) -> Option<AppUpdateInfo>` — builds the updater
  with the channel endpoint, checks, and returns { version, notes,
  minimumSystemVersion } for the JS gate. The floor is read from
  `Update::raw_json` (the full manifest the updater already fetched and
  verified) — NOT a second HTTP GET, which could fail transiently and drop
  the floor, failing the gate OPEN. It surfaces the floor but does not gate.
- `install_app_update(beta)` — re-checks, then RE-APPLIES the OS gate
  natively (`os_info` vs the manifest floor) and refuses a below-floor
  install. This native check is the authoritative safety boundary: the
  frontend note is UX, but the brick-prevention lives here, so a stale UI
  gate or a beta whose floor rose between check and click can't install a
  build the OS can't launch. Downloads + installs, emitting
  `app-update://progress`; JS relaunches (existing process plugin).

**Endpoints.**
- stable: `releases/latest/download/latest.json` (unchanged). GitHub's
  "latest" excludes prereleases, so betas are invisible here for free.
- beta: a dedicated `beta.json` asset at a FIXED location (a standing
  `beta` release/tag), because GitHub has no "latest-including-prereleases"
  URL. beta is a SUPERSET of stable — a beta user receives prereleases AND
  promoted stable releases (otherwise they'd stall on the last prerelease
  after it's superseded by a stable of the same line). So promote-beta.yml
  fires on BOTH `release: prereleased` and `released`, pointing beta.json at
  the HIGHEST-VERSIONED release of either kind — it only advances beta.json
  when the just-published version is a greater semver (prerelease-aware), so a
  lower stable hotfix published during a beta window can't regress the beta
  channel below the in-flight beta. Routing happens ON PUBLISH (not build) so
  beta.json never points at draft assets that 404.
  Stable users are unaffected — they read the release's own latest.json via
  GitHub's "latest" pointer, which excludes prereleases.

A stable user therefore can never be offered a beta (structural: the stable
endpoint only ever serves a promoted release). A beta user is offered the
newest of {latest prerelease, latest stable}. There is no "wrong-track"
window: flipping the toggle clears any current offer SYNCHRONOUSLY, then
re-checks on a short debounce that resets on each flip — so a just-abandoned
channel's offer is never left clickable. Install also uses the channel the
offer was made on and re-applies the native OS gate, so the install path
can't cross tracks or brick either.

**Preference + UI.** A persisted `updateChannel` ("stable" | "beta"),
app-level like theme (localStorage). Toggle in the About modal using the
existing Square/CheckSquare checkbox idiom ("Receive beta updates").

**Opt-out semantics (decided).** Turning beta OFF means "leave the beta
channel and rejoin stable's flow" — it does NOT roll back the beta build
already installed. Concretely, for a user running 0.7.0-beta.N who
un-checks the box:
- the client checks the stable channel again;
- it keeps running its current version and is offered nothing until stable
  reaches it (Tauri only offers version-greater updates — no auto-downgrade);
- when 0.7.0 is promoted to stable, semver ranks the release above its own
  prereleases (`0.7.0` > `0.7.0-beta.N`), so the opted-out user is offered
  0.7.0 final and converges back onto stable automatically and cleanly.
This matches Chrome / VS Code Insiders / every mainstream channel. We do
NOT build auto-rollback: downgrading 0.7.0→0.6.10 is a true downgrade
(needs the Rust-only `allowDowngrades`) AND lossy — a 0.7.0 project file
can carry styling data an older build ignores on load and would drop on
save. A user who truly needs to go back reinstalls the older build by hand
(rare, documented). Requires: betas MUST be versioned as proper
prereleases (`0.7.0-beta.1`, `-beta.2`, …) so they order below `0.7.0` and
each stable supersedes its own betas. The toggle shows a one-line note on
opt-out: "You'll stay on your current version until a stable release
reaches it."

**CI.** Prerelease builds (tag like `v0.7.0-beta.1`) set
`prerelease: true` (hardcoded `false` today) and upload `beta.json` to the
standing beta release. Stable builds keep uploading `latest.json`. The
manifest assembler emits `minimumSystemVersion` in both.

## The 0.7.0 rollout (why this ordering)

1. Ship 0.6.10 to stable (all current users). It runs everywhere 0.6.9
   does; it just teaches clients the gate + channels.
2. Let 0.6.10 adoption climb.
3. Publish 0.7.0 as a GitHub PRERELEASE → reaches only beta-channel users
   (0.6.10+, engaged, self-selected). They're gated: a beta user on an old
   Mac still won't be offered it.
4. When comfortable, promote 0.7.0 to "latest." Stable users on capable
   Macs get it; those below 13.4 are gated out with the note.

During step 3 the website's download buttons (auto-populated from GitHub's
"latest release" API, which also excludes prereleases) keep serving 0.6.10
to new visitors — consistent.

## Windows

Asymmetric with macOS, deliberately. WebView2 is evergreen and decoupled
from the OS, so 0.7.0 does NOT raise the Windows floor — there is no brick
scenario to gate against. We DOCUMENT the effective floor (Windows 10
version 1803, WebView2's baseline and thus already the real minimum) in
README/site, and keep the manifest field per-platform so a Windows floor
is a one-line add if a future release ever needs a specific build — but we
build NO runtime Windows enforcement now (Win10/11 both report 10.0.x and
differ only by build number; gating on that is a footgun guarding nothing).
A future WebView2-runtime requirement, if it ever arises, is a different
axis (runtime version, not OS) and rare because WebView2 self-updates.

## Docs changes (independent, low-risk)

- README gains a System Requirements section: Windows 10 (1803+); macOS
  13.4+ for 0.7.0 and later (0.6.x runs on older macOS).
- docs/index.html gains a requirements line near the download buttons.

## Verifiability

- Pure gate functions (compareVersions / isOsSupported): unit-tested.
- `get_os_version`, channel commands, install path: compile-checked
  (cargo check) and build-checked (vite build); behavior confirmed on the
  running OS.
- End-to-end (a real signed prerelease, a real old Mac, the promote step):
  a release-candidate manual checklist — cannot be exercised from a dev
  tree without signing secrets and GitHub releases. Documented as such.

## Version bump

tauri.conf.json + package.json → 0.6.10.
