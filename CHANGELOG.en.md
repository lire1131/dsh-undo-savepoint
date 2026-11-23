# Changelog

Notable changes to dsh-undo-savepoint. Dates are in local time (UTC+8). 中文版:[CHANGELOG.md](CHANGELOG.md)

## [0.5.2] - 2026-11-23

### Added

- **Pick your header buttons (#57)**. Undo, redo, snapshot, file rollback, snapshot badge and the single menu entry each have their own switch under Settings, Snapshots, Advanced, with the first four on by default. The density setting stays, and turning all six off still leaves the single menu entry.
- **Full-page snapshot management (#57)**. A new sidebar entry opens the snapshot list as a full page in the centre area, without covering the chat, and the page scrolls.
- **Offline tools reuse the Node shipped with DSH (#57)**. The host records its install root on mount, and the launchers resolve an explicit override, the recorded root, then PATH, so the offline WebUI and guard work on a machine with no system Node.
- **One state component for loading, empty and error**. A skeleton while loading, a primary action when empty, a retry on error, shared by the snapshot panel, the file-rollback panel and the full page; the file-rollback panel gains its missing error state.
- **Desktop overlay clears the native title bar (#54)**. When Electron or the host Windows title-bar marker is present, the overlay starts below the title bar, taking the height from a host variable and falling back to 40px; the web build and the full page stay as they were.

### Changed

- **Icons unified to a stroked style**. 1.5px strokes, with seven new warning, clock, search, folder, connection, more and history icons replacing the emoji that stood in as icons.
- **Settings page regrouped**. Four groups covering current state, saving and retention, storage and sensitivity, directories and shortcuts, with wrappable rows and shrinkable inputs.
- **Visual scale converged**. Spacing 4/8/12/16, radii 8/12, borders 0.5px and 1px, type sizes 11/12/14 plus a 16px panel title, the same set for the in-host panels and the offline WebUI.
- **Motion reduced to three durations**. 120/180/240ms with one easing curve, and everything inside the plugin switches off when the system asks for reduced motion.
- **Conversation undo renamed to file rollback (#56)**. The name and the panel note state that only file changes are rolled back and chat history stays.
- **DSH 0.2.2-rc.5 adaptation re-checked**. On the real 0.2.2-rc.5 desktop build the five host slots, 19 theme tokens and the title-bar marker and height are unchanged; the `engines.dsh` declaration stays as it was.

### Fixed

- **Badge time rendered as `[object Object]` (#56)**. The badge children added a React element to a string, turning the element into an object literal; separate child nodes fix the display.
- **State colours too light for text on the light theme**. Success, warning, business and error text now use darker derived values, 4.93:1 at worst on light and 7.46:1 at worst on dark.
- **Skeleton lines invisible against the panel**. Skeletons use a dedicated background token and are visible on both themes.

### Tests

- **Gates**. 737 smoke checks, 36 host-api, 35 undo-server, 3 home-resolution, 14 e2e; check-routes 22 routes on both sides, 2 in-host only and 3 offline only; check-size 1566848 bytes; 8 GATE_OK entries from check-client-exports.
- **New contrast check**. `tools/check-contrast.mjs` measures 22 in-host plugin pairs and 24 offline WebUI pairs against 4.5:1 for body text and 3:1 for secondary text, wired into `npm test`.
- **New regression coverage**. Four title-bar checks including two execution-level ones, eight visual-scale checks, eight state checks, five motion checks and six contrast checks, each with a negative control.

## [0.5.1] - 2026-11-07

### Added

- **Two-dimensional switching across ports and profiles**. Instance entries gain an optional port and a currentProfile; the offline UI picks a port first and then the web or desktop store of that port, while the in-host UI stays on the current port and switches between the two profiles. Store roots resolve by home and profile, reading sharded stores first and falling back to the historical flat store with a shared-library label.
- **Reworked panel and offline WebUI**. Both sides share an instance (port) to profile to snapshot-store flow bar and a status strip; the diff overlay groups configuration, plugin, and profile-code files, with a left file navigator carrying added and removed line counts and a right side showing line-level red and green, plus collapse, Esc close, and error retry.
- **One settings file shown in three places with hot reload**. The in-host panel, the plugin detail page, and the offline WebUI show the same settingsFile; switching a store loads that instance's own settings, reading and saving both reload it, and writes keep instances and current.
- **Scan local instances**. Both sides gain a scan endpoint that lists local DSH ports, processes, detectable profiles, and snapshot counts; it only suggests and never writes configuration, and returns an empty list on timeout or a missing command.
- **Shared-library filter and three ownership states**. Each snapshot is labelled by the profile recorded in its manifest, with served, other-profile, and unknown states handled separately; the selected profile filters by default, and a show-all-shared toggle shows everything with per-row labels.
- **Desktop-profile safe mode with explicit confirmation**. The default remains refusal; a request carrying confirmation may write, after taking a pre-safe-mode snapshot and backing up the profile manifest.
- **Three-mode conversation header**. A new headerMode setting takes auto, full, or compact and defaults to auto; the wide mode shows labels, the medium mode keeps icons only, and the narrow mode folds into undo plus a single-entry menu containing undo, redo, create snapshot, message undo, and snapshot management.
- **Plugin icon on the Plugins page**. The package manifest gains an icon field, and from DSH 0.2.1 the Plugins page and plugin cards show the same icon as the desktop shortcut.
- **Desktop shortcut validity self-check**. The shortcut's target, arguments, and working directory are read back and compared with the current installation; a match is skipped and keeps the custom icon, a mismatch is rewritten, and diagnostics report a repairable notice.
- **Install-time environment self-check**. The `dsh plugin add` hooks check the external Node.js, PowerShell, the platform, and whether the DSH home is writable; a missing external node or one below 20 and an unwritable DSH home are blocking, while a missing PowerShell, a non-Windows platform, and node below 24.9 are advisory, and `DSH_UNDO_SKIP_ENV_CHECK=1` skips the check.
- **Visible client assembly state**. The five slot registration points record failure labels one by one, `document.documentElement.dataset.undoClient` is set to `ready` or `degraded`, and the console prints one summary line, so a single on-site query separates "apply did not run" from "registration was swallowed" (#54).
- **Host-internal package check**. A host-internal copy under the profile root `node_modules/@deepseek-ai/` is graded by source and version; packages declared in the manifest, links pointing into the host installation tree, and copies matching the host version are let through, while a version mismatch or an unreadable version is reported as an error with the copy version, host version, and version source in the detail; a mismatched copy in the shared tree `profiles/node_modules` is a warning only and is never renamed (#49).
- **DSH 0.2.2 line declared**. The last segment of `engines.dsh` gains `>=0.2.2-0`, and both READMEs plus the offline launch notice state the two requirements: the DSH 0.2.2 host needs Node.js 24.9, while the plugin's offline tools need only 20.

### Changed

- **Instance configuration shape and REST contract**. Each instances entry gains an optional port and a new currentProfile; old configurations still read, and a missing port reads by home only without probing ports. The REST contract becomes 22 routes on both sides, 2 in-host only, and 3 offline only; a scan endpoint is added, instance switching becomes `{switch:{instance, profile}}`, and safe-mode gains profile and confirmDesktop.
- **Shared stores filter by profile by default**. The flat shared store no longer merges web and desktop into one list; manifests from before 0.5.0 carry no schemaVersion and may hold a default profile, so those snapshots are treated as ownership-unknown and no profile view deletes them by mistake.
- **Desktop-profile safe mode changes from refusal to confirmed use**. The third button of the official recovery dialog remains the preferred escape path; a request without confirmation is still refused before any write.
- **Node.js wording in the install notice**. The launch script and both READMEs state the host requirement of 24.9 and the offline requirement of 20 as two separate judgements.

### Optimized

- **Panel rendering and status strip**. Above 200 entries the card view mounts only the current batch, and both table and cards render in batches; the shared store appears once in the status strip with the settings-file entry added, while the table keeps its ownership column.
- **Profile directory detection**. `profiles/node_modules` is no longer treated as a profile; only web, desktop, and directories carrying package.json and `cordis*.yml` count, so the flow bar no longer overlaps the snapshot-store content.
- **Old snapshot ownership display**. Manifests without schemaVersion show as ownership-unknown and can be inspected through the show-all-shared toggle instead of being misjudged against the default profile.

### Fixed

- **Info-level partial-sanitize findings were moved back by the repair (#55)**. `doctor -Fix` used to check only that a finding existed, so info-level findings also entered the merge branch and top-level entries the user had deleted were written back into the patch. The repair now handles warn-level findings only, and info findings are reported without touching files; before merging, each entry's `name:` is checked against dependencies, dsh.profile.bundles, and node_modules, entries for uninstalled packages are skipped with the package names recorded in the repair detail, and the repair summary prints how many entries were appended.
- **YAML trailing comments caused false findings and duplicate move-backs (#53)**. The `entryIdOf` line-end anchor rejected `- id: x # comment`, so the partial-sanitize check treated an entry that was already present as missing and the repair moved a duplicate with the same id back, which the host rejects as a duplicate loader entry id. The pattern now accepts a trailing comment introduced by whitespace plus `#`, while complete scalars such as `foo#bar` are unaffected.
- **Junction false positives in the host-internal package check (#49)**. A failed `realpath` no longer falls straight to shadow; the link text itself is read, and a link whose text lands under a host tree root or the desktop product-tree structure prefix is let through as a host-tree link, with the link state kept in the detail. Real copies with a different version are still reported as errors.
- **On-site diagnosis of the missing client entries on 0.2.2-rc.1 desktop (#54)**. The five slot registration points record failures one by one, the client state is written to `dataset.undoClient`, and the console prints a summary; the isolated instance reported `client ready (5/5 slots)`, while the desktop shape still needs a check on the maintainer's machine.
- **Narrow-window overlay clipping (#52)**. The snapshot panel and message-undo overlay now render under body, the mask covers the whole viewport, and the panel centers on the viewport, no longer affected by the host header container's overflow rules; the panel also becomes a bottom drawer and the table scrolls horizontally when too wide.
- **Offline tools pointed the file-spec table at the wrong root after a profile switch (#51)**. Once settings.profileName takes effect, the snapshot file list is rebuilt against the new root and no longer points profile files at `profiles\web`; when profileName is unset and the machine has exactly one profile containing `cordis.patch.yml`, that profile is selected with a notice.
- **Conversation header buttons overflowed in narrow columns (#50)**. The narrow headerMode folds four buttons into one entry, and container queries switch modes by actual available width.
- **The second patch-entry false positive (#47)**. A top-level entry and an `insert` child sharing an id are no longer judged as a duplicate mount entry, at the known cost that two top-level entries with the same id in one file are no longer reported either.
- **Platform differences exposed by the Node 22 CI matrix**. Host-tree prefix comparison accepts both raw and realpath forms; Windows device prefixes read from readlink are normalized and UNC paths restored; link fixtures use lstat for existence so a dangling link is not followed by fs.access.
- **Instance and profile switching fixes**. Settings files no longer point at the wrong place after a profile switch; when a port is taken by another instance the configured home is kept and the measured home is reported separately; with no instance configured, the offline WebUI still shows the current home and only hides the dropdown.

### Tests

- **Full gate suite**. Smoke grows to 663 checks, host-api to 36, undo-server to 35, home-resolution to 3 branches, and e2e to 14; check-routes reports 22 routes on both sides, 2 in-host only, and 3 offline only; check-size reports 1655430 bytes; check-client-exports reports 8 exports with GATE_OK.
- **New regression coverage**. Trailing YAML comments and the repair no longer moving present entries, host-tree link text fallback and the shared-tree scan, info-level findings not writing the patch, uninstalled entries skipped with the repair summary count, client assembly state, install-time environment self-check, the 300-entry panel threshold, and the three header modes.
- **CI matrix**. The CI matrix covers Windows, Ubuntu, and macOS times Node 20 and 22, and the path and link differences exposed on Node 22 are pinned as regression assertions.

## [0.5.0] - 2026-10-20

### Added

- **Startup health check**. Thirty seconds after startup the plugin inspects session directories, snapshot coverage, tolerance patches, and disk usage, combining the four dimensions into one report; it alerts only on findings and stays silent when healthy.
- **Crash self-healing**. Two consecutive unfinished startups trigger safe mode automatically: a manual snapshot is taken first, the plugin set is backed up three ways, and the offline WebUI banner states the reason. The threshold is configurable and 0 disables it; a single abnormal exit does not trigger it.
- **DSH boot guard**. An optional guard entry runs a full preflight before DSH starts, enters safe mode per configuration when a blocking problem is found, and keeps the complete boot output in a rolling log of 10 files; starting DSH directly is unchanged.
- **DSH upgrade guard**. When the DSH version changes, the plugin takes an upgrade insurance snapshot automatically and produces a compatibility and session census report on the first post-upgrade boot; the guard can be turned off in settings.
- **WebUI health panel**. The offline WebUI gains a health check button showing session health, snapshot coverage, patch status, and disk usage in one panel, lists findings item by item, and offers snapshot store size, cap settings, and one-click prune.
- **Privacy report**. Scans configs and sessions for secret-shaped content and reports whether snapshot and export redaction covers them; output carries counts and file names only, never content. Available offline via `doctor --privacy`.
- **Snapshot audit tool**. A new `audit-snapshots` command checks every historical snapshot's sensitive files for leftover plaintext secrets and reports counts and locations only, never content.
- **Offline health entry**. The `doctor` command gains `--health` to print the four-dimension report, and the `undo_doctor` tool appends the last startup health summary to its output, so results are reachable even when DSH cannot boot.
- **Caretaker settings**. Startup health check and DSH upgrade guard can each be turned off; both default to on.
- **First-mount notice and consent**. The first mount explains what gets written and asks once in interactive environments; non-interactive runs auto-accept. Declining stops snapshots and tool registration, the choice is stored in settings, and later loads do not ask again.
- **One-command uninstall and residue cleanup**. New `tools/uninstall.mjs` removes mount declarations, junctions, the desktop shortcut, and compatibility patches per profile; the snapshot store and settings are kept by default, and `--purge` removes them too. README gains an uninstall section.
- **Doctor environment preflight gains two checks**. Windows long-path risk and Node capability (below 22.15, `undo_scan` repair degrades to a read-only notice) enter startup preflight as warnings that do not change the verdict.
- **Partial recovery move-back on the desktop**. When bundles are restored but patch content is missing, doctor lists the missing entries from the newest backup and supports item-level move-back; it takes a pre-fix snapshot and leaves a `.dsh-undo-bak` copy of the current patch.
- **Official sanitize traces recognized and restored**. The plugin identifies traces left by the desktop recovery dialog by three signals (backup file exists, current patch lacks the plugin, bundle list lacks the plugin), reports the newest backup name, and restores patch and mount declarations via `undo_doctor fix=true` or offline `doctor -Fix`, leaving a `.dsh-undo-bak` copy first.
- **Native config entry on the plugin page**. From DSH 0.2.1 the plugin page can render the same snapshot and restore panel as the plugin's settings page; `dsh.client.inject` gains an activation-order declaration only, loads no new package, and 0.2.0 and earlier are unaffected (PR #48 by @Sheldon-Bacchus).
- **tools resolution gains DSH_HOME anchors**. Local mounts and isolated instances now also try `DSH_HOME/runtime` and `DSH_HOME/profiles/desktop` in order after the plugin's own location and `DSH_ROOT`, stopping at the first hit.
- **Desktop-running reminder**. Startup preflight detects the desktop process and reminds the user to quit it completely; probe failures and a confirmed absence produce no reminder, and isolated runs skip the probe.

### Changed

- **Core module split**. Constants and pure utilities, the session pipeline, the snapshot family, and the doctor/health family move into `base` / `session` / `snapshot` / `health`; `core` keeps the facade and re-exports, so the public interface is unchanged.
- **Snapshot manifest format anchors**. New snapshots write `schemaVersion` and `compression` into the manifest, anchoring future format evolution; older plugin versions still read new snapshots, so this is not a breaking change.
- **Automated npm publishing**. Stable tags trigger the publish workflow, which runs the full gate suite first and publishes via OIDC; canary tags are excluded by a job-level guard and never reach npm.
- **Canary staged releases**. From 0.5.0 experimental builds ship via the canary channel as git tag plus GitHub Release only; stable versions are the ones that reach npm.
- **Support range names the desktop edition**. README and package metadata state support up to DSH 0.2.0-rc.2 desktop and document the safe-mode limitation on the desktop profile.
- **README repositioning**. Both editions move from an undo tool to a security caretaker, with proactive checks, upgrade guarding, and crash rescue as the main narrative.
- **New health endpoint in the REST contract**. Both in-host and standalone servers expose `GET /api/undo/health` returning the four-dimension report, with the route contract registry updated in step.
- **PowerShell offline tools enter deprecation**. The GUI and CLI show a deprecation notice and will be removed in 0.6.0; the Node offline WebUI is the replacement, feature-aligned and actively maintained.
- **Safe mode refuses to act on the desktop profile**. Desktop patches are host-managed, so `safe-mode on` is refused before any write and points to the third button of the official recovery dialog; `off` still runs, and crash self-healing no longer claims it entered safe mode when refused.

### Security

- **Patch and credential layers covered by redaction**. `cordis.patch.yml`, `cordis.yml` in the same directory, and `.yml` / `.yaml` suffixes all go through the YAML redaction path; token values go only to the local vault. Existing plaintext snapshots can be cleaned with `tools/redact-existing.mjs`, which reports by default, writes only with `--apply`, and is idempotent.
- **Privacy report output red line**. The privacy check emits counts and file names only; no secret content ever leaves the scanner.

### Fixed

- **v4 session generation census**. v0, v2, v3, and v4 each get their own bucket, higher generations are counted separately, and v4 is no longer merged into v3.
- **Mount-entry dedupe no longer touches user config**. Only entries whose `id` or `name` is the plugin name are recognized; mount positions with a non-empty `config` block are exempt, preferring a duplicate over touching user config.
- **Removing mount entries leaves no broken structure**. Removal is entry-grained: the plugin entry, its config block, and marker comments move out together, with new dangling-key detection and cleanup.
- **Profile detection gains six layers**. Resolution follows explicit config, settings file, command line, host profile channel, environment variable, and default, in that order; `undo_list` and `undo_doctor` name the source. When the new scope has no snapshot store after a profile switch, the historical location is reused and noted, so old snapshots do not seem to vanish.
- **Official desktop bundles are no longer misjudged**. On the desktop profile, unresolvable bundles in the `@deepseek-ai/dsh` scope are recorded as healthy with a note that the host launches them; the same names still hard-fail on non-desktop profiles.
- **Bundle resolution gains the installation anchor**. Resolution falls back through installation directory, profile directory, and home directory; the installation anchor is checked as a product tree first and simply absent when `DSH_ROOT` points elsewhere.
- **Profile directory discovery no longer falls back to a missing directory**. Only a missing `profiles/` root triggers the fallback; when `profiles/` exists but has no scannable directories, the scope is treated as empty with a clear notice.
- **Desktop shortcut resolution no longer hangs**. PowerShell calls that resolve the desktop directory and create the shortcut now carry a timeout and fall back to the user desktop directory, so DSH exit is not held up.
- **Patch-entry dedupe no longer swallows config lists**. Only top-level entries and direct children of a top-level `insert:` count as loader entries; nested lists are never registered. `fix` removes by the same rule, skips what does not match, and records them as skipped, narrowing accidental deletion to true entries (#47 by @youran0faust).
- **tools resolution picked stale dependencies under local link installs**. When the plugin's own `node_modules` held an older `@deepseek-ai/dsh-tools`, anchor resolution only resolved without loading, and the stale package failed to import with a missing `CallId` export, taking the whole plugin down. Resolution now loads each anchor and moves on when one fails, so desktop link installs and normal installs both land on the host runtime.

### Tests

- Smoke tests adopt baseline anchoring, so expected outputs no longer depend on hard-coded counts; the full suite grows to 545 checks.
- New assertions cover session format v4, mount exemptions, six-layer profile detection, installation anchors, desktop refusal, patch-entry rules, redaction, and existing-store cleanup, including a verbatim golden sample of the issue's original patch shape.

## Earlier versions

Full entries for older versions live in git history; every version has a tag, e.g. `git show v0.4.10 -- CHANGELOG.en.md`.

| Version | Date |
|---|---|
| 0.5.0-canary.6 | 2026-10-19 |
| 0.5.0-canary.5 | 2026-10-05 |
| 0.5.0-canary.4 | 2026-10-04 |
| 0.4.10 | 2026-10-03 |
| 0.4.9 | 2026-09-16 |
| 0.4.8 | 2026-09-16 |
| 0.4.7 | 2026-09-10 |
| 0.4.6 | 2026-09-08 |
| 0.4.5 | 2026-09-06 |
| 0.4.4 | 2026-08-31 |
| 0.4.3 | 2026-08-29 |
| 0.4.2 | 2026-08-27 |
| 0.4.1 | 2026-08-23 |
| 0.4.0 | 2026-08-22 |
| 0.3.9 | 2026-08-22 |
| 0.3.8 | 2026-08-21 |
| 0.3.7 | 2026-08-21 |
| 0.3.6 | 2026-08-20 |
| 0.3.5 | 2026-08-17 |
| 0.3.4 | 2026-08-16 |
| 0.3.3 | 2026-08-16 |
| 0.3.2 | 2026-08-15 |
| 0.3.1 | 2026-08-15 |
| 0.3.0 | 2026-08-15 |
| 0.2.1 | 2026-08-15 |
| 0.2.0 | 2026-08-15 |
| 0.1.1 | 2026-08-15 |
| 0.1.0 | 2026-08-14 |
| 0.0.1 | 2026-08-14 |
