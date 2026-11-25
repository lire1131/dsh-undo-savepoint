# dsh-undo-savepoint Security caretaker for DSH (undo / rollback / crash rescue)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml/badge.svg)](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml)

> English | [中文](README.md) | [Changelog](CHANGELOG.en.md)

**A security caretaker for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): every settings change is auto-snapshotted, with one-click undo / redo / restore to any version; and when DSH won't boot, the offline WebUI / GUI / CLI still work.**

It checks proactively and speaks only when something is wrong. A DSH version change takes an upgrade-insurance snapshot first, and a crash names the last-known-good snapshot.

## Preview

| Offline WebUI: port → Profile → snapshot store, snapshots grouped by date, with per-row Compare / Restore / Note / Delete |
|---|
| ![webui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-main-0.5.2.en.png) |

| Snapshot diff: file navigation with add/remove counts, red/green lines | Settings: instances, snapshot policy, auto-cleanup and retention |
|---|---|
| ![diff](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-diff-0.5.2.en.png) | ![settings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-settings-0.5.2.en.png) |

| Batch actions: select several snapshots and delete them after a confirm | SAFE MODE: two risk warnings before other plugins are disabled |
|---|---|
| ![batch](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-batch-0.5.2.en.png) | ![safemode](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/shots/webui-safemode-0.5.2.en.png) |

## Core capabilities

| Capability | What it does |
|---|---|
| **Config + plugin-code rollback** | Snapshots cover config files and user-plugin code trees; undo / redo / restore any version from the WebUI, chat or CLI. |
| **File rollback** | Rolls back workspace file changes per AI message or 60s batch, without git, keeping the chat history. |
| **One-click SAFE MODE** | When DSH cannot boot, only this plugin stays enabled; a snapshot is taken before any change. |
| **Crash attribution and self-repair** | Names the last-known-good snapshot from the log signature; `undo_doctor` fixes hard boot failures and `undo_scan` repairs session files, always after a snapshot. |
| **Timeline and full-page management** | Date grouping, notes and tags, scheduled snapshots, ZIP export/import; the sidebar entry opens the list as a full page without covering the chat. |
| **Pick your header buttons** | Six independent switches; by default only undo, redo, snapshot and the single menu entry show. |
| **Offline rescue without Node** | WebUI, GUI, CLI and desktop shortcut all work, reusing the Node shipped with DSH when no system Node exists. |

## Platform support

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Config/plugin snapshots, undo/redo | ✅ | ✅ | ✅ |
| Offline Web UI (undo-server) | ✅ | ✅ | ✅ |
| Offline CLI / GUI | ✅ (.bat/.ps1) | ✅ (.command) | ✅ (.sh) |
| File/dir selection dialog | PowerShell native | osascript | zenity → kdialog (fallback: manual path) |

## Installation

Prerequisites: DSH (`@deepseek-ai/dsh`). The offline tools reuse the Node shipped with DSH and fall back to a system Node (≥20), so they work on a machine without Node installed. Node requirements for the host itself are up to DSH; 0.2.2 and newer need ≥24.9.

### Desktop installation (recommended)

The desktop build is the main path and runs the `desktop profile`. Launch the desktop client once so the profile initialises, then quit it **completely** before installing.

GitHub direct. This installs the latest commit on the default branch; append `#vX.Y.Z` to pin a version.

```bat
dsh plugin --profile desktop add github:lire1131/dsh-undo-savepoint
```

npm registry. This installs npm's latest; append `@X.Y.Z` to pin a version.

```bat
dsh plugin --profile desktop add dsh-undo-savepoint
```

Restart DSH after installing. When DSH from 0.2.0-rc.2 on the desktop hits a fatal error, the official recovery dialog's third button drops third-party bundle entries and backs the patch up to `cordis.patch.yml.bak-<timestamp>`, keeping the package. No reinstall is needed after that, only restoring the mount declaration. Safe mode is refused by default on the desktop build; a request carrying `confirmDesktop` takes a pre-safe-mode snapshot before writing, and the third button of the official dialog remains the preferred escape path.

### Web profile installation

Swap the profile to `web`. Append a tag or version as above to pin a version.

```bat
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint
dsh plugin --profile web add dsh-undo-savepoint
```

### Environment check

On the first mount the plugin checks the external Node.js, PowerShell, the platform and whether the DSH home is writable, writes the result to the log, and never blocks startup. The offline launchers (`launch-undo.bat`, `launch-undo.sh`, `launch-undo.command`) call the same entry before starting the WebUI. Set `DSH_UNDO_SKIP_ENV_CHECK=1` to skip the check.

## Usage

- **Undo**: header **Undo** button / `Ctrl+Alt+Z` / tell the AI "undo the last step".
- **Redo**: **Redo** button / `Ctrl+Alt+Y` (only when nothing changed since the undo).
- **Manual save**: "Save" in the panel / tell the AI "save a snapshot".
- **Restore to a fixed version**: "Restore to this" on a snapshot row.
- **Delete a snapshot**: "Delete" in the panel.
- **File rollback**: the header "File rollback" entry lists message batches; rolling one back touches only its file changes and keeps the chat history.
- **Full-page management**: the sidebar "Snapshots" entry opens the list as a scrollable page in the centre area.
- **Choose your header buttons**: Settings → Snapshots → Advanced decides which header entries show; turning all six off still leaves the single menu entry.
- **Settings**: auto-save, debounce, retention, snapshot directories and tracked workspace directories.

## When DSH won't boot

Run the offline WebUI, which does not depend on DSH.

```bash
node tools/undo-server.mjs
```

The local page carries the timeline, rollback, diff, diagnostics and SAFE MODE. A desktop shortcut is created on plugin load, and it uses the Node shipped with DSH when no system Node is installed. To disable every user plugin except this one, use SAFE MODE, restart DSH, then re-enable plugins one by one.

## Support range

`engines.dsh` in `package.json` covers the successive 0.1.x and 0.2.x declarations, ending with `>=0.2.2-0`. Verified on the desktop build against DSH 0.2.0-rc.2, 0.2.1-rc.3, 0.2.1-rc.5 and 0.2.2-rc.5.

DSH 0.2.2 and newer require Node.js 24.9 on the host; the plugin's offline tools still need only 20, and the two are judged separately. If your DSH version falls outside the declared range, do not edit `package.json`; use the official version exemption.

```bat
dsh plugin --profile web allow-version dsh-undo-savepoint@<plugin-version> --dsh-version <runtime> --accept-risk
```

## Uninstall

```bat
dsh plugin remove dsh-undo-savepoint
node tools/uninstall.mjs
```

`uninstall.mjs` removes the mount declaration, junction and desktop shortcut, keeping the snapshot library and settings. When the history is no longer needed, add `--purge`.

```bat
node tools/uninstall.mjs --purge
```

## Snapshot storage and safety

Snapshots live under `$DSH_HOME\undo-snapshots`, split into manual and auto stores per profile; the manual store is never auto-pruned. Snapshots copy `.env` and similar config which may contain secrets; the plugin redacts sensitive files on write and keeps real values only in the local vault. The snapshot store is still a sensitive local directory, so do not share it.

## More

- Version changes: [CHANGELOG.en.md](CHANGELOG.en.md).
- Chinese README: [README.md](README.md).
- License: MIT
