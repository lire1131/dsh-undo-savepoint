# dsh-undo.ps1 - external undo/rollback CLI for DSH config (works even when DSH cannot boot)
#
# Usage:
#   .\dsh-undo.ps1 snapshot [-Label "before installing X"]   # manual save
#   .\dsh-undo.ps1 undo                                       # undo the last change
#   .\dsh-undo.ps1 undo -SyncDeps                             # undo and rebuild node_modules from the restored lockfile
#   .\dsh-undo.ps1 redo                                       # redo the last undo
#   .\dsh-undo.ps1 list                                       # visual list
#   .\dsh-undo.ps1 diff -Id <id|latest>
#   .\dsh-undo.ps1 restore -Id <id|latest> [-Force] [-SyncDeps]
#   .\dsh-undo.ps1 remove -Id <id>                            # delete a snapshot
#   .\dsh-undo.ps1 prune [-KeepAuto 20]
#   .\dsh-undo.ps1 status
#   .\dsh-undo.ps1 settings                                   # show current settings
#   .\dsh-undo.ps1 scan [--fix] [-Label <home>]               # scan/repair DSH session files (v0.3.8; v0.4.2 adds synthetic-closer seq overlap repair)
#
# Snapshot stores: D:\dsh\undo-snapshots\manual and \auto (shared with the
# dsh-undo DSH plugin; legacy flat snapshots are read too).

param(
    [Parameter(Position = 0)]
    [ValidateSet('snapshot', 'list', 'diff', 'restore', 'undo', 'redo', 'remove', 'prune', 'export', 'import', 'status', 'settings', 'safe-mode', 'recent', 'scan')]
    [string]$Command = 'status',
    [string]$Label = '',
    [string]$Id = '',
    [int]$KeepAuto = 20,
    [switch]$Force,
    [switch]$SyncDeps
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dsh-undo-savepoint-lib.ps1')

function Write-UndoDepsResult($Deps) {
    if (-not $Deps.touched) { return }
    if ($Deps.synced) { Write-Host "Dependencies synced: $($Deps.command)" }
    else {
        Write-Host "WARNING $($Deps.note)"
        Write-Host 'Restored config files are in place; re-run with -SyncDeps to rebuild dependencies automatically.'
    }
}

switch ($Command) {
    'snapshot' {
        $reason = if ($Label) { $Label } else { 'manual' }
        $s = New-UndoSnapshot 'manual' $reason
        Write-Host (Get-UndoText 'snap.created' -Params @{ id = $s.id; n = @($s.files).Count; reason = $reason; dir = (Get-UndoSettings).manualDir })
    }
    'undo' {
        $r = Invoke-UndoRestore 'undo' '' -SyncDeps:$SyncDeps
        if (-not $r.ok) { Write-Host "undo failed: $($r.error)"; exit 1 }
        if ($r.unchanged) { Write-Host $r.message; exit 0 }
        Write-Host (Get-UndoText 'restore.ok' -Params @{ id = $r.targetId; kind = $r.targetKind; reason = $(if ($r.targetReason) { ": $($r.targetReason)" } else { '' }) })
        Write-Host (Get-UndoText 'restore.files' -Params @{ files = $r.restored -join ', ' })
        Write-Host (Get-UndoText 'restore.prestate' -Params @{ id = $r.preSnapshotId })
        if ($r.remounted) { Write-Host 'dsh-undo mount re-ensured in cordis.patch.yml' }
        if ($r.missing -and @($r.missing).Count -gt 0) { Write-Host "Not restored: $($r.missing -join ', ')" }
        if ($r.needsRestart) { Write-Host 'NOTE: a restart of DSH is required for the restored state to take effect.' }
        Write-UndoDepsResult $r.deps
        if ($r.preflight -and @($r.preflight.missing).Count -gt 0) {
            Write-Host "WARNING Cross-machine preflight: not resolvable on this machine: $($r.preflight.missing -join ', ')"
            Write-Host 'DSH may fail to start after restore - install them first, or run: dsh-undo.ps1 safe-mode -Label on'
        }
        foreach ($n in @($r.notes)) { Write-Host "Note: $n" }
    }
    'redo' {
        $r = Invoke-UndoRestore 'redo' '' -SyncDeps:$SyncDeps
        if (-not $r.ok) { Write-Host "redo failed: $($r.error)"; exit 1 }
        Write-Host "Redone: re-applied $($r.targetId)"
        Write-Host "Files: $($r.restored -join ', ')"
        if ($r.missing -and @($r.missing).Count -gt 0) { Write-Host "Not restored: $($r.missing -join ', ')" }
        if ($r.needsRestart) { Write-Host 'NOTE: a restart of DSH is required for the restored state to take effect.' }
        Write-UndoDepsResult $r.deps
        foreach ($n in @($r.notes)) { Write-Host "Note: $n" }
    }
    'list' {
        $list = Get-UndoSnapshots
        if (@($list).Count -eq 0) { Write-Host 'No snapshots yet.'; break }
        Write-Host ('{0,-22} {1,-11} {2,-8} {3,-9} {4,-10} {5,-40} {6}' -f 'ID', 'KIND', 'TIME', 'STORE', 'MARK', 'REASON', 'FILES')
        foreach ($s in $list) {
            $t = ([datetime]$s.time).ToLocalTime().ToString('MM-dd HH:mm')
            $mark = if ($s.stepped) { 'stepped' } elseif ($s.consumed) { 'consumed' } else { '' }
            $pCount = 0
            foreach ($p in @($s.plugins | Where-Object { $_ })) { $pCount += @($p.files | Where-Object { $_ }).Count }
            $pCount += @($s.profileFiles | Where-Object { $_ -and $_.hash }).Count
            Write-Host ('{0,-22} {1,-11} {2,-8} {3,-9} {4,-10} {5,-40} {6}' -f $s.id, $s.kind, $t, $s._Store, $mark, ($s.reason | Out-String).Trim(), (@($s.files).Count + $pCount))
        }
        $settings = Get-UndoSettings
        Write-Host "Manual store: $($settings.manualDir)"
        Write-Host "Auto store:   $($settings.autoDir)"
    }
    'diff' {
        if ([string]::IsNullOrEmpty($Id)) { throw 'diff requires -Id <id|latest>' }
        # 统一走 lib 的 Get-UndoDiffText：配置文件 + 插件代码文件（v0.2）一次输出
        Write-Host (Get-UndoDiffText $Id)
    }
    'restore' {
        if ([string]::IsNullOrEmpty($Id)) { throw 'restore requires -Id <id|latest>' }
        $targetId = if ($Id -eq 'latest') { @(Get-UndoSnapshots)[0].id } else { $Id }
        $r = Invoke-UndoRestore 'id' $targetId -SyncDeps:$SyncDeps
        if (-not $r.ok) { Write-Host "restore failed: $($r.error)"; exit 1 }
        Write-Host "Restored $($r.targetId) ($($r.targetKind): $($r.targetReason))"
        Write-Host "Files: $($r.restored -join ', ')"
        Write-Host "Pre-restore safety snapshot: $($r.preSnapshotId)"
        if ($r.remounted) { Write-Host 'dsh-undo mount re-ensured in cordis.patch.yml' }
        if ($r.missing -and @($r.missing).Count -gt 0) { Write-Host "Not restored: $($r.missing -join ', ')" }
        if ($r.needsRestart) { Write-Host 'NOTE: a restart of DSH is required for the restored state to take effect.' }
        Write-UndoDepsResult $r.deps
        if ($r.preflight -and @($r.preflight.missing).Count -gt 0) {
            Write-Host "WARNING Cross-machine preflight: not resolvable on this machine: $($r.preflight.missing -join ', ')"
            Write-Host 'DSH may fail to start after restore - install them first, or run: dsh-undo.ps1 safe-mode -Label on'
        }
        foreach ($n in @($r.notes)) { Write-Host "Note: $n" }
    }
    'remove' {
        if ([string]::IsNullOrEmpty($Id)) { throw 'remove requires -Id <id>' }
        $r = Remove-UndoSnapshot $Id
        if (-not $r.ok) { Write-Host "remove failed: $($r.error)"; exit 1 }
        Write-Host "Removed snapshot $($r.removed)"
    }
    'prune' {
        $r = Invoke-UndoPrune
        if ($r.disabled) { Write-Host 'Auto-cleanup is disabled in settings - nothing deleted.'; break }
        Write-Host "Pruned $($r.removedAuto) auto/baseline and $($r.removedPre) pre-restore snapshot(s)$(if ($r.removedBlobs -gt 0) { ", $($r.removedBlobs) orphan blob(s)" } else { '' })."
    }
    'export' {
        $r = Export-UndoSnapshots
        if (-not $r.ok) { Write-Host "export failed: $($r.error)"; exit 1 }
        Write-Host "Exported $($r.count) snapshot(s) to $($r.path)"
        if ($r.sensitiveWarning) {
            Write-Host 'WARNING: this archive contains REAL secrets (.env / .credentials.yaml in keep mode or legacy snapshots) - do NOT share it.'
        }
    }
    'import' {
        if ([string]::IsNullOrEmpty($Id)) { throw 'import requires -Id <zip-path>' }
        $r = Import-UndoSnapshots $Id
        if (-not $r.ok) { Write-Host "import failed: $($r.error)"; exit 1 }
        Write-Host "Imported $($r.imported) snapshot(s) ($($r.skipped) duplicate(s) skipped) from $($r.source)"
    }
    'status' {
        $settings = Get-UndoSettings
        $list = Get-UndoSnapshots
        Write-Host "Manual store: $($settings.manualDir)"
        Write-Host "Auto store:   $($settings.autoDir)"
        Write-Host "Auto-save enabled: $($settings.autoEnabled) (debounce $($settings.watchDebounceMs)ms, keep $($settings.keepAuto))"
        Write-Host "Total snapshots: $(@($list).Count)"
        Write-Host ("  manual:       {0}" -f @($list | Where-Object { $_.kind -eq 'manual' }).Count)
        Write-Host ("  auto:         {0}" -f @($list | Where-Object { $_.kind -eq 'auto' }).Count)
        Write-Host ("  baseline:     {0}" -f @($list | Where-Object { $_.kind -eq 'baseline' }).Count)
        Write-Host ("  pre-restore:  {0}" -f @($list | Where-Object { $_.kind -eq 'pre-restore' }).Count)
        if (@($list).Count -gt 0) { Write-Host "Newest: $($list[0].id) ($($list[0].kind): $($list[0].reason))" }
    }
    'settings' {
        $settings = Get-UndoSettings
        if ($Label) {
            # settings -Label "key=value;key2=value2" (v0.3.2: offline editing)
            $new = @{}
            foreach ($pair in ($Label -split ';')) {
                $kv = $pair -split '=', 2
                if ($kv.Count -ne 2 -or [string]::IsNullOrWhiteSpace($kv[0])) { continue }
                $key = $kv[0].Trim()
                $val = $kv[1].Trim()
                if ($val -eq 'true') { $new[$key] = $true }
                elseif ($val -eq 'false') { $new[$key] = $false }
                elseif ($val -match '^\d+$') { $new[$key] = [int]$val }
                else { $new[$key] = $val }
            }
            if ($new.Count -eq 0) { Write-Host 'settings: no valid key=value pairs in -Label'; exit 1 }
            $saved = Set-UndoSettings $new
            Write-Host 'Settings updated:'
            $saved | ConvertTo-Json
        } else {
            $settings | ConvertTo-Json
        }
    }
    'recent' {
        $limit = if ($KeepAuto -gt 0) { [Math]::Min(20, $KeepAuto) } else { 5 }
        $log = Join-Path (Split-Path $script:UndoSettingsFile -Parent) 'rollback-log.jsonl'
        if (-not (Test-Path -LiteralPath $log)) { Write-Host 'No rollback operations recorded yet.'; break }
        $lines = @(Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Last $limit)
        Write-Host 'Recent rollback operations (newest first):'
        foreach ($l in ($lines | Select-Object -Last $limit)) {
            try {
                $e = $l | ConvertFrom-Json
                Write-Host ("{0}  {1}  -> {2}  files: {3}" -f $e.ts, $e.mode, $e.targetId, (@($e.files) -join ', '))
            } catch { Write-Host '(unreadable entry)' }
        }
    }
    'safe-mode' {
        if ($Label -eq 'on' -or $Label -eq 'off') {
            $r = Set-UndoSafeMode ($Label -eq 'on')
            if (-not $r.ok) { Write-Host "safe-mode failed: $($r.error)"; exit 1 }
            Write-Host $r.message
        } else {
            $st = Get-UndoSafeModeState
            if ($st.active) { Write-Host "Safe mode is ON (entered $($st.enteredAt), backup $($st.backup))" }
            else { Write-Host 'Safe mode is OFF.' }
        }
    }
    'scan' {
        # dsh-undo.ps1 scan [--fix] [-Label <home>]（v0.3.8, B6；v0.4.2 增加 synthetic-closer seq 重叠修复）
        # 离线会话扫描/修复：DSH 起不来时也能用；--fix 通过 -Label 传入。
        $fix = $false
        $homeArg = $null
        if ($Label) {
            if ($Label -eq '--fix') { $fix = $true } else { $homeArg = $Label }
        }
        if (-not $homeArg) {
            $homeArg = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
        }
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Host 'scan requires Node.js; please install Node.js first.'; exit 1
        }
        $scriptPath = Join-Path $PSScriptRoot 'session-scan.mjs'
        if (-not (Test-Path -LiteralPath $scriptPath)) {
            Write-Host "session-scan.mjs not found: $scriptPath"; exit 1
        }
        $nodeArgs = @($scriptPath)
        if ($fix) { $nodeArgs += '--fix' }
        $nodeArgs += $homeArg
        & node $nodeArgs
        exit $LASTEXITCODE
    }
}
