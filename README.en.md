# dsh-undo-savepoint Security caretaker for DSH (undo / rollback / crash rescue)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml/badge.svg)](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml)

> English | [中文](README.md) | [Changelog](CHANGELOG.en.md)

**A security caretaker for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): every settings change is auto-snapshotted, with one-click undo / redo / restore to any version; proactive health checks, upgrade guarding, and crash rescue; and when DSH won't even boot, the offline WebUI / GUI / CLI still work.**

It checks proactively and speaks only when something is wrong: the first health check completes 30 seconds after startup, a crash names the last-known-good snapshot, and a DSH version change takes an upgrade-insurance snapshot first.

## Preview

| Offline WebUI: port → Profile → snapshot store flow bar, shared store split by owner profile, per-row Compare / Restore to here / Edit note / Delete |
|---|
| ![webui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-main.en.png) |

| Snapshot diff: file navigation with add/remove counts, red/green lines, sensitive values redacted | Settings: instances and snapshot policy |
|---|---|
| ![diff](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-diff.en.png) | ![settings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-settings.en.png) |

## Core capabilities

| Capability | What it does |
|---|---|
| **Config + plugin-code rollback** | Snapshots cover config files and user-plugin code trees; undo / redo / restore any version from the WebUI, chat or offline CLI. |
| **Message-level undo** | Rolls back workspace file changes per AI message or 60s batch, without git or session storage. |
| **Secret redaction** | `.env` and credentials are redacted in snapshots, real values live only in the local vault, exported ZIPs leak nothing. |
| **One-click SAFE MODE** | When DSH cannot boot, only this plugin stays enabled so boot is guaranteed; snapshots and profile/home patches are backed up first. |
| **Crash attribution** | Classifies the crash by log signature and names the last-known-good snapshot for one-click rollback. |
| **Session-file repair** | `undo_scan` repairs single-frame layout violations and seq overlaps; what it cannot repair is quarantined, originals untouched. |
| **Timeline and snapshot management** | Date grouping, notes and tags, scheduled snapshots, orphan-blob GC, ZIP export/import with optional AES-256-GCM. |
| **Boot preflight and diagnostics** | `undo_doctor` checks store health and the hard boot failures; repairable findings are fixed in one step after a snapshot. |
| **DSH 0.2.2 line support** | The 0.2.2 host needs Node.js 24.9 while offline tools need only 20; client assembly state is written to `dataset.undoClient`; the host-internal package check covers link text and the shared tree. |
| **Offline emergency kit** | WebUI, GUI window, CLI and desktop shortcut: undo, diff, SAFE MODE and diagnostics while DSH is down. |

> Details (tool arguments, REST contract, snapshot contents, redaction rules) live in the sections below and in the [changelog](CHANGELOG.en.md).

## Platform support

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Config/plugin snapshots, undo/redo | ✅ | ✅ | ✅ |
| Offline Web UI (undo-server) | ✅ | ✅ | ✅ |
| Offline CLI / GUI | ✅ (.bat/.ps1) | ✅ (.command) | ✅ (.sh/.desktop) |
| File/dir selection dialog | PowerShell native | osascript | zenity→kdialog (fallback: manual path) |
| CI regression | windows-latest | macos-latest | ubuntu-latest |

## Crash rescue quick reference (pick by scenario)

| Scenario | Action |
|---|---|
| Config/plugin mount broken | Chat / WebUI / CLI: `undo` or `restore -Id <id>` |
| Plugin code broken | Same, snapshots include plugin code trees, one-click restore |
| Last run crashed, unsure what to roll back to | WebUI / GUI banner shows the last-known-good snapshot, one-click rollback |
| **DSH will not boot at all** | Desktop "dsh-undo-savepoint" → offline WebUI **SAFE MODE** button (or CLI `safe-mode -Label on`) → restart DSH, it always boots |
| Crash banner says session damage | Chat / CLI: `undo_scan quarantine=true` (or offline `dsh-undo.ps1 scan --fix`) |
| Missing plugins after restore (cross-machine) | Preflight warning in the restore report; install first or use safe mode |
| "My config suddenly changed" | CLI `recent` / chat `undo_recent` check the rollback log |
| Rollback touched plugins/mounts | Report says "restart DSH for it to take effect" |

| SAFE MODE confirmation: disables every user plugin except this one, so DSH always boots, then re-enable them one by one |
|---|
| ![safemode](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/safe-mode-confirm.en.png) |

## Installation

Prerequisites: DSH (`@deepseek-ai/dsh`) and Node.js. DSH 0.2.2 and newer require Node.js ≥24.9 on the host; the plugin's offline CLI / GUI needs only ≥20. The host-mode plugin runs in profiles
that provide the tools / systemPrompt / webServer services (any Web profile qualifies); when DSH
cannot boot at all, use the offline CLI / GUI instead, which does not depend on the host.

### Install-time environment check

The install hooks triggered by `dsh plugin add` check the external Node.js, PowerShell, the platform and whether the DSH home is writable. A missing external node or one older than 20, and an unwritable DSH home, are blocking; a missing PowerShell, a non-Windows platform and node below 24.9 are advisory.

When something blocks, an interactive terminal asks whether to continue and defaults to continue after 30 seconds; non-interactive environments print the conclusion and continue. Set `DSH_UNDO_SKIP_ENV_CHECK=1` to skip the check. Installs through `tools/dsh-plugin.ps1` run the same check with `--strict`, so a blocking issue aborts the install.

**Option A (GitHub direct)**. Install the latest master commit:

```bat
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master
```

Restart DSH after installing. Snapshot directories and options are configurable in Settings.

**Option C (npm registry)**. Install from npm:

```bat
dsh plugin --profile web add dsh-undo-savepoint
```

`dsh plugin add` forwards to pnpm in the profile directory; this package declares
`dsh.bundle.patch` in its `package.json`, so it is registered into the profile's bundle list
automatically. Restart DSH to activate.

**Option B (local source / pre-release)**. Clone and mount manually:

1. **Clone the repository** into a local plugins directory (an ASCII path is safer), e.g. `D:\dsh\plugins\dsh-undo-savepoint`:

```bat
git clone https://github.com/lire1131/dsh-undo-savepoint.git D:\dsh\plugins\dsh-undo-savepoint
```

2. **Create a junction** so DSH's module resolver can find the local package by name `dsh-undo-savepoint` (used by both the host plugin and the WebUI client plugin):

```bat
mklink /J "<your-dsh-install>\node_modules\dsh-undo-savepoint" "D:\dsh\plugins\dsh-undo-savepoint"
```

> DSH resolves package names by walking up from its own `node_modules`. The default location is `C:\Users\<username>\node_modules` when npm installed into the user directory; if you run DSH from an npx cache, junction into that cache's `node_modules` instead. Check the path in DSH's startup error output or run `npm root -g`.

3. **Mount it in the profile patch layer**: edit `<DSH_HOME>\profiles\web\cordis.patch.yml` and append:

```yaml
- insert:
    - id: dsh-undo-savepoint
      name: dsh-undo-savepoint
```

4. **Activate**: saving hot-reloads the host part; refresh the page to see the header buttons and settings rows; restart DSH for full steady state (legacy flat snapshots migrate automatically).

> Dependency note: the host plugin loads `@deepseek-ai/dsh-tools` via `createRequire('<dsh-install-root>/package.json')`. If DSH lives elsewhere, set the environment variable `DSH_ROOT=<dsh-install-root>`, no extra package installation needed.

## Support range (DSH versions)

At install time and at profile startup the plugin compares the runtime version reported by `dsh --version` against the range this package declares, and refuses to load on a mismatch. `engines.dsh` in `package.json` is a chain of parallel ranges covering the successive `0.1.x` and `0.2.x` declarations, ending with `>=0.2.2-0`.

Verified: the DSH 0.2.0-rc.2 desktop build (full peer tree with cordis 4.0.4), 0.2.1-rc.3 and 0.2.1-rc.5, covering the `web` profile together with the command line, the offline WebUI and the offline CLI. DSH 0.2.2-rc.1 was verified in an isolated instance for host activation and client assembly; the desktop build still needs a check on the maintainer's machine.

DSH 0.2.2 and newer require Node.js 24.9 on the host; the plugin's offline tools still need only 20, and the two are judged separately.

If your DSH version falls outside the declared range, startup reports it as incompatible. Do not edit `package.json`; use the official exact-version exemption instead, which lives in the profile's own `compatibility.json` and touches neither the dependency manifest nor the patch layer:

```bat
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version dsh-undo-savepoint@0.5.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile web revoke-version dsh-undo-savepoint@0.5.1 --dsh-version <runtime>
```

The first lists existing grants, the second submits one, the third revokes it. An exemption only authorises loading, never dependency scripts, and neither a plugin upgrade nor a DSH upgrade inherits a grant, so each of them needs a fresh confirmation. The declared range is not pinned to the newest release because DSH can still ship breaking changes; the range expands once a new version has been tested here.

### Desktop

The DSH desktop build starts from its own installation directory and runs the desktop profile; swap `web` for `desktop` and `add` / `remove` / the three version-exemption commands all work the same way.

```bat
dsh plugin --profile desktop add github:lire1131/dsh-undo-savepoint#master
```

Prerequisite: launch the desktop client once so the profile initialises, then quit it **completely** before running the command above. While the desktop build is running its profile directory is held, so a write either fails or lands half applied.

**The official recovery dialog and this plugin.** When DSH 0.2.0 on the desktop hits a fatal error it shows a native dialog with three buttons: quit, restart, and disable third-party plugins and restart. The third button drops third-party entries from the bundle mount list and backs the profile patch up to `cordis.patch.yml.bak-<timestamp>`, keeping the package itself. Two things to remember:

1. Being disabled by that button does **not** require a reinstall. The package stays in the profile directory with its dependencies untouched, so restoring the mount declaration brings it back.
2. **When the profile patch is moved aside, the tolerance patches (tolerate / isolate / selfheal) stop applying with it.** If you restore the bundles by hand and leave the patch out, older sessions can hit known pitfalls. Two recovery paths, either one works: rename `cordis.patch.yml.bak-<timestamp>` back to `cordis.patch.yml` and restart, or re-run the plugin's post-install step and let it rebuild the bundles and the patch.

**The safe-mode limitation.** On the desktop build safe mode is refused, and the escape hatch is the third button of the official recovery dialog.

## Uninstall

### Standard uninstall

Two commands; the second cleans up the leftovers:

```bat
dsh plugin remove dsh-undo-savepoint
node tools\uninstall.mjs
```

`uninstall.mjs` is **gentle by default**: it removes mount declarations, junctions and the desktop shortcut, and **keeps the snapshot library and settings** (reinstalling restores your history). When the history is no longer needed, add `--purge`:

```bat
node tools\uninstall.mjs --purge
```

Common options:

| Option | Effect |
|---|---|
| `--purge` | Also removes `undo\` (settings/state) and `undo-snapshots\` (snapshot library) |
| `--yes` | Skip confirmation (required in non-interactive contexts, prevents scripted deletion) |
| `--home <dir>` | Override the DSH home directory |
| `--profile <n>` | Process only the named profile (default: all) |
| `--json` | Print the cleanup plan as machine-readable JSON |

Without `--yes` the command first lists **every path it will delete** and then asks. In a non-interactive context (CI, pipes) it refuses to run unless `--yes` is given explicitly.

### Manual uninstall map

If you really want to clean up by hand, these are the six locations and how to delete each correctly:

| # | Location | Correct removal |
|---|---|---|
| 1 | `<dsh-install-root>\node_modules\dsh-undo-savepoint` (or under a profile's `node_modules`) | **Delete the link itself, do not follow it.** This is a junction; deleting it is safe. Browsing into it in Explorer and deleting the contents deletes your plugin source |
| 2 | The `id: dsh-undo-savepoint` entry in `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` | Remove that `insert` entry (or the whole item); an emptied file can be deleted |
| 3 | `dsh-undo-savepoint` inside `dsh.profile.bundles` of `<DSH_HOME>\profiles\<profile>\package.json` | Remove the entry from the array |
| 4 | `<DSH_HOME>\undo\` | Settings and state (including `settings.json`). Delete only if you want settings reset |
| 5 | `<DSH_HOME>\undo-snapshots\` | The snapshot library. **Confirm you no longer need rollback** before deleting |
| 6 | Desktop `dsh-undo-savepoint.lnk` (macOS `.command` / Linux `.desktop`) | Delete the file |

### Windows long-path note

With a deep or non-ASCII Windows user directory, snapshot paths can exceed Explorer's MAX_PATH limit of 260 characters, and a manual delete fails with "file name too long" or leaves a half-deleted mess. **Prefer `uninstall.mjs`**: it deletes the fixed set of paths directly without walking into snapshot internals, so the limit does not apply.

## Usage (inside DSH)

| Conversation header: iconized Undo / Redo / Snapshot / Message-undo buttons, with the auto-snapshot badge on the right |
|---|
| ![header](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-header.png) |

- **Undo**: header **Undo** button / `Ctrl+Alt+Z` / tell the AI "undo the last step"
- **Redo**: **Redo** button / `Ctrl+Alt+Y` (only when nothing changed since the undo)
- **Manual save**: "Save" in the panel / tell the AI "save a snapshot" / CLI `snapshot`
- **Restore to a fixed version**: "Restore to this" on a panel row; or tell the AI "restore to <id>"; or CLI `restore -Id <id>`
- **Message-level undo**: the header "conversation undo" entry opens the message list; "undo this message" rolls back exactly what that message changed
- **Delete a snapshot**: "Delete" in the panel; or CLI `remove -Id <id>`
- **Custom shortcuts**: Settings → General → Undo/Redo shortcut (click the box then press a combo; Backspace clears)
- **Save options**: Settings → General → Snapshot Settings (auto-save toggle, debounce, keep count, snapshot dirs, tracked workspace dirs; the 📁 button opens the native folder picker). "Tracked workspace dirs" accepts comma/semicolon-separated paths, non-empty replaces the default working-dir scope

| Message-level undo: pick a message batch, roll back exactly the files it changed |
|---|
| ![msgundo](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/message-undo.en.png) |

## Offline tools (work even when DSH won't boot)

**WebUI (recommended)**. Run `node tools\undo-server.mjs` (or double-click `tools\launch-undo.bat` / `.command` / `.sh` / `.desktop`); it serves a local `127.0.0.1` page with the timeline / rollback / diff / diagnostics / SAFE MODE. A desktop shortcut is auto-created on plugin load. The diagnostic panel does not only show problems, it repairs them: repairable checks are badged "fixable" and one click on "Repair fixable" fixes them in place, after taking a manual snapshot and with an immediate re-check.

| Desktop GUI window: no browser needed, same timeline and diagnostics |
|---|
| ![gui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-main.en.png) |

| Desktop shortcut: auto-created on plugin load, double-click to open the offline WebUI |
|---|
| ![shortcut](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/shortcut-icon.png) |

| Snapshot diff: file list + change stats (+8 / -2) + line-level highlighting, see every change before rolling back | Offline settings: debounce / retention / redaction mode / dirs / desktop shortcut |
|---|---|
| ![guidiff](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-diff.en.png) | ![guisettings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-settings.en.png) |

> UI language follows your system locale, English UI shown here; Chinese-UI screenshots in [README.md](README.md).

<details markdown="1">
<summary>GUI window, CLI and the 30-line desktop-shortcut script</summary>

```powershell
# GUI window (WinForms): double-click tools\dsh-undo-savepoint-gui.bat, or:
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint-gui.ps1"

# CLI
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" list
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" snapshot -Label "reason"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" undo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" undo -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" redo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" restore -Id <id> -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" restore -Id <id> -Force -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" remove -Id <id>
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" prune -KeepAuto 20

# Boot preflight (works even when DSH cannot start); -Fix repairs what it can
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" doctor
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo.ps1" doctor -Fix

# Safe plugin install (auto snapshots before/after; auto-rollback on failure)
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-plugin.ps1" add <package>
```

```powershell
# 30-line version: open a PowerShell window, paste the whole block, press Enter, then
# a "DSH Undo Manager" shortcut appears on the desktop without locating any file
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
$d = @("$dshHome\profiles\web\node_modules\dsh-undo-savepoint", "$dshHome\profiles\node_modules\dsh-undo-savepoint", "$env:USERPROFILE\node_modules\dsh-undo-savepoint") | Where-Object { Test-Path (Join-Path $_ 'tools\dsh-undo-savepoint-gui.bat') } | Select-Object -First 1
if ($d) {
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Undo Manager.lnk'))
  $s.TargetPath = Join-Path $d 'tools\dsh-undo-savepoint-gui.bat'
  $s.WorkingDirectory = Join-Path $d 'tools'
  $s.Save()
  Write-Host "Desktop shortcut created: $($s.FullName)"
} else { Write-Host 'Plugin directory not found. Install it first: dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master' }
```
</details>

Typical rescue: **DSH fails to boot with something like `duplicate loader entry id`** → open "DSH Undo Manager", pick the snapshot from before the change → Restore → restart DSH. No reinstall, no lost sessions.

> UI language: force it with `DSH_UNDO_LANG=zh|en`; otherwise Chinese on Chinese hosts, English elsewhere. Applies to the host command output, the offline CLI/GUI, and the WebUI. The single dictionary source is `lib/i18n/{zh,en}.json` (shared by host and WebUI so they cannot drift).

## Snapshots & storage

The snapshot captures DSH's boot-critical config: `cordis.patch.yml`, `package.json`, `cordis.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (under the profile) + `cordis.patch.yml`, `settings.yaml`, `.env`, `.credentials.yaml` (under `$DSH_HOME`, default `~/.dsh`).

When a restore touches `package.json` / `pnpm-lock.yaml`, the default behavior only reports that `node_modules` may be out of sync. To rebuild dependencies, pass `-SyncDeps` (offline CLI), `sync_deps: true` (chat tool), or `syncDeps: true` (REST); the plugin runs `pnpm install --frozen-lockfile` (plain `pnpm install` when there is no lockfile). A failed install leaves the restored config files in place.

| Store | Default path (configurable in settings) | Contents |
|---|---|---|
| Manual store | `<snapshot root>\manual\` | Manual snapshots (never auto-pruned) |
| Auto store | `<snapshot root>\auto\` | Auto snapshots, boot baselines, undo pre-restore snapshots (auto keeps latest 20) |
| Legacy store | `<snapshot root>\` root | Old flat layout, still read, auto-migrated on startup |

> ⚠️ Snapshots contain copies of `.env` etc. which may include secrets, do not share or push them.

### Multi-profile & custom home

- **Profile detection**: the plugin reads the active profile from the launch arguments (`dsh --profile mine` / `--profile=mine`; `dsh web` falls back to `web`); config dir defaults to `$DSH_HOME/profiles/<current profile>`, and snapshot stores default to `<snapshot root>/<current profile>/{auto,manual}` (per-profile isolation; the old flat store is still honored so legacy snapshots are never hidden). Offline CLI/GUI cannot see the launch arguments, set `DSH_UNDO_PROFILE` or `profileName` in settings (default `web`).
- **Custom DSH home**: the home resolution matches the official launcher (`@deepseek-ai/dsh-home-paths`) exactly, `$DSH_HOME` wins (blank = unset; `~` prefixes supported), otherwise `<user home>\.dsh`; settings file, snapshot root, profile dir and plugin-discovery paths are all derived from it, so third-party clients with a custom `DSH_HOME` no longer suffer the "two homes" split.
- **Explicit overrides always win**: env vars `DSH_UNDO_SETTINGS` / `DSH_UNDO_ROOT` / `DSH_UNDO_EXPORT` / `DSH_UNDO_PROFILE`, config keys `homeDir` / `profileDir` / `manualDir` / `autoDir` / `profileName`.

## REST API (backend of the WebUI)

| Endpoint | Description |
|---|---|
| `GET /api/undo/status` | `{canUndo, canRedo, total, bootAlert, safeModeActive, ...}` |
| `GET /api/undo/list` | Snapshot list (with location: manual/auto/legacy) |
| `GET /api/undo/diff` | `?id=<id>` file-level structured diff of a snapshot vs current |
| `GET /api/undo/tree` | Directory-tree grouped diff of a snapshot vs current |
| `GET /api/undo/doctor` | One-click diagnostic (store writability / blob integrity / settings / scale) plus boot preflight (manifest BOM / bundles / junctions / duplicate loader ids / unfinished previous boot) |
| `POST /api/undo/doctor/fix` | Repair the fixable boot-preflight findings (strip manifest and patch BOMs, dedupe loader entries by id, recreate missing or dangling plugin junctions); takes a manual snapshot first and returns the repair list plus a re-check report |
| `GET/POST /api/undo/settings` | Read/write save options; POST applies immediately |
| `GET /api/undo/messages` | Message-level undo: per-message change list |
| `POST /api/undo/undo` | Undo the last change; optional body `{syncDeps: true}` rebuilds `node_modules` from the restored lockfile |
| `POST /api/undo/redo` | Redo the last undo; optional body `{syncDeps: true}` |
| `POST /api/undo/restore` | body `{id, syncDeps?}`, restore to a fixed version |
| `POST /api/undo/message` | body `{id}`, roll back one message's changes |
| `POST /api/undo/remove` | body `{id}`, delete a snapshot |
| `POST /api/undo/snapshot` | body `{reason}`, manual save (`note`/`tags` supported) |
| `POST /api/undo/note` | Edit a snapshot's note/tags |
| `POST /api/undo/prune` | Run expired-snapshot cleanup immediately |
| `POST /api/undo/compact` | Orphan-blob GC (supports `dry_run`) |
| `POST /api/undo/export` / `POST /api/undo/import` | Export/import all snapshots as ZIP (pure Node, PowerShell-compatible, optional AES-256-GCM password) |
| `POST /api/undo/safe-mode` | body `{on}`, enter/exit safe mode |
| `POST /api/undo/pick-dir` / `pick-file` | Open the native folder/file picker (per-platform), return the chosen path |
| `GET /api/undo/locale` | Return the current language (`DSH_UNDO_LANG` or auto) |

## Design notes

- **Undo semantics**: auto snapshots are taken *after* a change, so "restoring the newest snapshot" would be a no-op; real undo restores the newest snapshot whose state **differs** from the current one. When everything matches, a clear "nothing to undo" message is shown instead of pretending.
- **Undo can never undo itself**: after restoring `cordis.patch.yml`, the plugin re-ensures its own mount entry automatically.
- **Auto-archiving never sabotages undo**: the watcher records content hashes of what a restore wrote, so the restore's own file changes are not auto-snapshotted (which would block redo); real changes are snapshotted as usual.
- **Format parity**: the Node plugin and the PowerShell tools share the same snapshot stores and manifest format; compatible with both Windows PowerShell 5.1 and PowerShell 7.

## Development

- Dependency resolution: the host plugin loads `@deepseek-ai/dsh-tools` via `createRequire(<dsh-install-root>/package.json)` (override with `DSH_ROOT`), no in-repo dependencies required.
- Tests (no DSH needed; run in the repository directory):

```bat
node tools\smoke-test.mjs     :: 189 logic tests (snapshot/undo/redo/store split/no-change hint/message-undo/orphan-GC/zip-interop)
node tools\e2e-watch.mjs      :: 10 real-timing regressions (auto-save/undo-no-harm/redo)
node tools\check-size.mjs     :: size gate (<5MB)
node tools\check-version.mjs  :: semver validation
```

## License

MIT
