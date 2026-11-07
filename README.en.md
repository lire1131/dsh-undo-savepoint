# dsh-undo-savepoint Security caretaker for DSH (undo / rollback / crash rescue)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml/badge.svg)](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml)

> English | [中文](README.md) | [Changelog](CHANGELOG.en.md)

**A security caretaker for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): every settings change is auto-snapshotted, with one-click undo / redo / restore to any version; and when DSH won't boot, the offline WebUI / GUI / CLI still work.**

It checks proactively and speaks only when something is wrong. A DSH version change takes an upgrade-insurance snapshot first, and a crash names the last-known-good snapshot.

## Preview

| Offline WebUI: port → Profile → snapshot store, with per-row Compare / Restore / Note / Delete |
|---|
| ![webui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@v0.5.1/docs/shots/webui-main.en.png) |

| Snapshot diff: file navigation with add/remove counts, red/green lines | Settings: instances, snapshot policy, auto-cleanup and retention |
|---|---|
| ![diff](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@v0.5.1/docs/shots/webui-diff.en.png) | ![settings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@v0.5.1/docs/shots/webui-settings.en.png) |

## Core capabilities

| Capability | What it does |
|---|---|
| **Config + plugin-code rollback** | Snapshots cover config files and user-plugin code trees; undo / redo / restore any version from the WebUI, chat or offline CLI. |
| **Message-level undo** | Rolls back workspace file changes per AI message or 60s batch, without git or session storage. |
| **One-click SAFE MODE** | When DSH cannot boot, only this plugin stays enabled so boot is guaranteed; snapshots and profile/home patches are backed up first. |
| **Crash attribution** | Classifies the crash by log signature and names the last-known-good snapshot for one-click rollback. |
| **Session-file repair** | `undo_scan` repairs single-frame layout violations and seq overlaps; what it cannot repair is quarantined, originals untouched. |
| **Timeline and snapshot management** | Date grouping, notes and tags, scheduled snapshots, ZIP export/import. |
| **Boot preflight and diagnostics** | `undo_doctor` checks hard boot failures plus patch and manifest structure; repairable findings are fixed in one step after a snapshot. |
| **Offline emergency kit** | WebUI, GUI window, CLI and desktop shortcut: undo, diff, SAFE MODE and diagnostics while DSH is down. |

## Platform support

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Config/plugin snapshots, undo/redo | ✅ | ✅ | ✅ |
| Offline Web UI (undo-server) | ✅ | ✅ | ✅ |
| Offline CLI / GUI | ✅ (.bat/.ps1) | ✅ (.command) | ✅ (.sh) |
| File/dir selection dialog | PowerShell native | osascript | zenity → kdialog (fallback: manual path) |

## Installation

Prerequisites: DSH (`@deepseek-ai/dsh`) and Node.js. DSH 0.2.2 and newer require Node.js ≥24.9 on the host; the plugin's offline CLI / GUI needs only ≥20.

### Option A (GitHub direct)

```bat
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#v0.5.1
```

### Option B (npm registry)

```bat
dsh plugin --profile web add dsh-undo-savepoint@0.5.1
```

Without a version it installs npm's latest. Restart DSH after installing.

### Install-time environment check

The install hooks check the external Node.js, PowerShell, the platform and whether the DSH home is writable. Set `DSH_UNDO_SKIP_ENV_CHECK=1` to skip the check.

### Desktop

The desktop build runs the `desktop profile`; swap `web` for `desktop`. Launch the desktop client once so the profile initialises, then quit it **completely** before installing.

```bat
dsh plugin --profile desktop add github:lire1131/dsh-undo-savepoint#v0.5.1
```

When DSH from 0.2.0-rc.2 on the desktop hits a fatal error, the official recovery dialog's third button drops third-party bundle entries and backs the patch up to `cordis.patch.yml.bak-<timestamp>`, keeping the package. No reinstall is needed after that, only restoring the mount declaration. Safe mode is refused by default on the desktop build; a request carrying `confirmDesktop` takes a pre-safe-mode snapshot before writing, and the third button of the official dialog remains the preferred escape path.

## Usage

- **Undo**: header **Undo** button / `Ctrl+Alt+Z` / tell the AI "undo the last step".
- **Redo**: **Redo** button / `Ctrl+Alt+Y` (only when nothing changed since the undo).
- **Manual save**: "Save" in the panel / tell the AI "save a snapshot".
- **Restore to a fixed version**: "Restore to this" on a snapshot row.
- **Delete a snapshot**: "Delete" in the panel.
- **Message-level undo**: the header "conversation undo" entry opens the message list.
- **Settings**: auto-save, debounce, retention, snapshot directories and tracked workspace directories.

## When DSH won't boot

Run the offline WebUI, which does not depend on DSH.

```bash
node tools/undo-server.mjs
```

The local page carries the timeline, rollback, diff, diagnostics and SAFE MODE. A desktop shortcut is created on plugin load. To disable every user plugin except this one, use SAFE MODE, restart DSH, then re-enable plugins one by one.

## Support range

`engines.dsh` in `package.json` covers the successive 0.1.x and 0.2.x declarations, ending with `>=0.2.2-0`. Verified: DSH 0.2.0-rc.2 desktop, 0.2.1-rc.3 and 0.2.1-rc.5; DSH 0.2.2-rc.1 was verified in an isolated instance for host activation and client assembly, while the desktop build still needs a check on the maintainer's machine.

DSH 0.2.2 and newer require Node.js 24.9 on the host; the plugin's offline tools still need only 20, and the two are judged separately. If your DSH version falls outside the declared range, do not edit `package.json`; use the official version exemption.

```bat
dsh plugin --profile web allow-version dsh-undo-savepoint@0.5.1 --dsh-version <runtime> --accept-risk
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
