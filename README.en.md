# dsh-undo-savepoint — Undo/rollback system for DSH

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml/badge.svg)](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml)

> English | [中文](README.md) | [Changelog](CHANGELOG.en.md)

**An undo/rollback system for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): every plugin install, skin switch or settings change is auto-snapshotted; manual saves whenever you want; one-click undo / redo / restore to any version. And when DSH won't even boot, the offline WebUI / GUI / CLI still have your back.**

Dreading DSH crashes? Afraid a tiny edit becomes a disaster? One-click rollback of configs and plugin code, secret-redacted snapshots, one-click SAFE MODE — you can always rescue yourself.

## Preview

| Conversation header: iconized Undo / Redo / Snapshot / Message-undo buttons + auto-snapshot badge (24 snapshots · 3h ago) |
|---|
| ![header](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-header.png) |

| Offline WebUI: crash banner + Undo / Redo / Safe mode / Diagnose / Message undo / Settings — works even when DSH won't boot (snapshot diff & settings: see [Offline tools](#offline-tools-work-even-when-dsh-wont-boot)) |
|---|
| ![gui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-main.en.png) |

## Core capabilities

| Capability | What it does |
|---|---|
| **Config + plugin-code rollback** | Snapshots cover config files AND user-plugin code trees — any broken edit is undoable (incl. pure code incidents like the whale-kit `yield*` crash); undo / redo / restore-to-any-version from the WebUI, chat or offline CLI |
| **Secret redaction + local vault** | `.env` / credentials enter snapshots auto-redacted (structure preserved) — exported ZIPs are safe to share; real values live in a local vault, and local rollbacks restore them fully |
| **Time Machine timeline** | Snapshot timeline visualization + file-level diff (added/removed line highlighting, per-file navigation, prev/next) + one-click rollback |
| **Message-level undo** | Records workspace file changes per AI message; say "undo what the last message did" and exactly that is rolled back (before-content restored, new files deleted). Tracked dirs configurable in Settings |
| **One-click SAFE MODE** | When DSH cannot boot at all, temporarily disables every user plugin except the undo system so it always boots; auto-snapshots + config backup on entry, one-click exit (profile/home dual-level patches backed up & restored; bundle entries that would fail the loader's hard checks are neutralized with the original `package.json` backed up separately and fully restored on exit) |
| **Crash attribution** | After an abnormal exit, classifies the crash by log signature (`session-corrupt` / `bundle-check` / `patch-tree`), names the concrete last-known-good snapshot and offers a one-click rollback — no guessing |
| **Session-file scan & repair** | `undo_scan` scans `<home>/sessions/**/session.jsonl.zstd`: single-frame layout violations (the 8/18 crash root cause) and synthetic-closer seq overlap (interrupted-turn seq overlap after undo/snapshot restores) are repaired in place (original kept as `.bak` + quarantine copy) with triple verification; undecodable files are only isolated, never touched. Offline via `dsh-undo.ps1 scan [--fix]` (requires Node ≥22.15; degrades to a notice on Node 20) |
| **One-click diagnostic** | `undo_doctor` checks store writability, blob integrity (missing/orphan), settings health, snapshot scale — structured ok/warn/error report with fix hints |
| **Safe cross-machine migration** | Restore preflights missing plugins and warns clearly; snapshots export/import as one-click ZIP, optional AES-256-GCM encryption (see [docs/migration.en.md](docs/migration.en.md)) |
| **Offline emergency kit** | WebUI + GUI window + CLI + auto-created desktop shortcut: undo / restore / SAFE MODE / crash banner / rollback log — everything works when DSH is down |
| **Auto slimming** | Orphan-blob GC (`undo_compact`) frees disk; size gates keep the plugin tiny (~0.6 MB) with zero runtime dependencies |

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
| Plugin code broken | Same — snapshots include plugin code trees, one-click restore |
| Last run crashed, unsure what to roll back to | WebUI / GUI banner shows the last-known-good snapshot, one-click rollback |
| **DSH will not boot at all** | Desktop "dsh-undo-savepoint" → offline WebUI **SAFE MODE** button (or CLI `safe-mode -Label on`) → restart DSH, it always boots |
| Crash banner says session damage | Chat / CLI: `undo_scan quarantine=true` (or offline `dsh-undo.ps1 scan --fix`) |
| Missing plugins after restore (cross-machine) | Preflight warning in the restore report; install first or use safe mode |
| "My config suddenly changed" | CLI `recent` / chat `undo_recent` check the rollback log |
| Rollback touched plugins/mounts | Report says "restart DSH for it to take effect" |

| SAFE MODE confirmation: disables every user plugin except this one, so DSH always boots — then re-enable them one by one |
|---|
| ![safemode](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/safe-mode-confirm.en.png) |

## Installation

Prerequisites: DSH (`@deepseek-ai/dsh`) and Node.js (≥20).

**Option A (GitHub direct)** — install the latest master commit:

```bat
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master
```

Restart DSH after installing. Snapshot directories and options are configurable in Settings.

**Option B (local source / pre-release)** — clone and mount manually:

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

> Dependency note: the host plugin loads `@deepseek-ai/dsh-tools` via `createRequire('<dsh-install-root>/package.json')`. If DSH lives elsewhere, set the environment variable `DSH_ROOT=<dsh-install-root>` — no extra package installation needed.

## Usage (inside DSH)

- **Undo**: header **Undo** button / `Ctrl+Alt+Z` / tell the AI "undo the last step"
- **Redo**: **Redo** button / `Ctrl+Alt+Y` (only when nothing changed since the undo)
- **Manual save**: "Save" in the panel / tell the AI "save a snapshot" / CLI `snapshot`
- **Restore to a fixed version**: "Restore to this" on a panel row; or tell the AI "restore to <id>"; or CLI `restore -Id <id>`
- **Message-level undo**: the header "conversation undo" entry opens the message list; "undo this message" rolls back exactly what that message changed
- **Delete a snapshot**: "Delete" in the panel; or CLI `remove -Id <id>`
- **Custom shortcuts**: Settings → General → Undo/Redo shortcut (click the box then press a combo; Backspace clears)
- **Save options**: Settings → General → Snapshot Settings (auto-save toggle, debounce, keep count, snapshot dirs, tracked workspace dirs; the 📁 button opens the native folder picker). "Tracked workspace dirs" accepts comma/semicolon-separated paths — non-empty replaces the default working-dir scope

| Message-level undo: pick a message batch, roll back exactly the files it changed |
|---|
| ![msgundo](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/message-undo.en.png) |

## Offline tools (work even when DSH won't boot)

**WebUI (recommended)** — run `node tools\undo-server.mjs` (or double-click `tools\launch-undo.bat` / `.command` / `.sh` / `.desktop`); it serves a local `127.0.0.1` page with the timeline / rollback / diff / diagnostics / SAFE MODE. A desktop shortcut is auto-created on plugin load.

| Desktop shortcut: auto-created on plugin load, double-click to open the offline WebUI |
|---|
| ![shortcut](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/shortcut-icon.png) |

| Snapshot diff: file list + change stats (+8 / -2) + line-level highlighting — see every change before rolling back | Offline settings: debounce / retention / redaction mode / dirs / desktop shortcut |
|---|---|
| ![guidiff](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-diff.en.png) | ![guisettings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/gui-settings.en.png) |

> UI language follows your system locale — English UI shown here; Chinese-UI screenshots in [README.md](README.md).

<details markdown="1">
<summary>GUI window, CLI and the 30-line desktop-shortcut script</summary>

```powershell
# GUI window (WinForms): double-click tools\dsh-undo-savepoint-gui.bat, or:
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint-gui.ps1"

# CLI
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" list
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" snapshot -Label "reason"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" undo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" undo -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" redo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" restore -Id <id> -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" restore -Id <id> -Force -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" remove -Id <id>
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" prune -KeepAuto 20

# Safe plugin install (auto snapshots before/after; auto-rollback on failure)
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-plugin.ps1" add <package>
```

```powershell
# 30-line version: open a PowerShell window, paste the whole block, press Enter —
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
} else { Write-Host 'Plugin directory not found — install it first: dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master' }
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
| Legacy store | `<snapshot root>\` root | Old flat layout — still read, auto-migrated on startup |

> ⚠️ Snapshots contain copies of `.env` etc. which may include secrets — do not share or push them.

### Multi-profile & custom home

- **Profile detection**: the plugin reads the active profile from the launch arguments (`dsh --profile mine` / `--profile=mine`; `dsh web` falls back to `web`); config dir defaults to `$DSH_HOME/profiles/<current profile>`, and snapshot stores default to `<snapshot root>/<current profile>/{auto,manual}` (per-profile isolation; the old flat store is still honored so legacy snapshots are never hidden). Offline CLI/GUI cannot see the launch arguments — set `DSH_UNDO_PROFILE` or `profileName` in settings (default `web`).
- **Custom DSH home**: the home resolution matches the official launcher (`@deepseek-ai/dsh-home-paths`) exactly — `$DSH_HOME` wins (blank = unset; `~` prefixes supported), otherwise `<user home>\.dsh`; settings file, snapshot root, profile dir and plugin-discovery paths are all derived from it, so third-party clients with a custom `DSH_HOME` no longer suffer the "two homes" split.
- **Explicit overrides always win**: env vars `DSH_UNDO_SETTINGS` / `DSH_UNDO_ROOT` / `DSH_UNDO_EXPORT` / `DSH_UNDO_PROFILE`, config keys `homeDir` / `profileDir` / `manualDir` / `autoDir` / `profileName`.

## REST API (backend of the WebUI)

| Endpoint | Description |
|---|---|
| `GET /api/undo/status` | `{canUndo, canRedo, total, bootAlert, safeModeActive, ...}` |
| `GET /api/undo/list` | Snapshot list (with location: manual/auto/legacy) |
| `GET /api/undo/diff` | `?id=<id>` file-level structured diff of a snapshot vs current |
| `GET /api/undo/tree` | Directory-tree grouped diff of a snapshot vs current |
| `GET /api/undo/doctor` | One-click diagnostic (store writability / blob integrity / settings / scale) |
| `GET/POST /api/undo/settings` | Read/write save options; POST applies immediately |
| `GET /api/undo/messages` | Message-level undo: per-message change list |
| `POST /api/undo/undo` | Undo the last change; optional body `{syncDeps: true}` rebuilds `node_modules` from the restored lockfile |
| `POST /api/undo/redo` | Redo the last undo; optional body `{syncDeps: true}` |
| `POST /api/undo/restore` | body `{id, syncDeps?}` — restore to a fixed version |
| `POST /api/undo/message` | body `{id}` — roll back one message's changes |
| `POST /api/undo/remove` | body `{id}` — delete a snapshot |
| `POST /api/undo/snapshot` | body `{reason}` — manual save (`note`/`tags` supported) |
| `POST /api/undo/note` | Edit a snapshot's note/tags |
| `POST /api/undo/prune` | Run expired-snapshot cleanup immediately |
| `POST /api/undo/compact` | Orphan-blob GC (supports `dry_run`) |
| `POST /api/undo/export` / `POST /api/undo/import` | Export/import all snapshots as ZIP (pure Node, PowerShell-compatible, optional AES-256-GCM password) |
| `POST /api/undo/safe-mode` | body `{on}` — enter/exit safe mode |
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
