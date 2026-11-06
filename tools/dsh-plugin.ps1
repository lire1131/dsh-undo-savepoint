# dsh-plugin.ps1 - safe plugin installer wrapper: auto-snapshots before and
# after every `dsh plugin` operation, and rolls back automatically on failure.
#
# Usage:
#   .\dsh-plugin.ps1 add <package-or-github>
#   .\dsh-plugin.ps1 remove <package>
#   .\dsh-plugin.ps1 update <package>
#
# It wraps: npx @deepseek-ai/dsh plugin --profile web <action> <package>

param(
    [Parameter(Position = 0)]
    [ValidateSet('add', 'remove', 'update')]
    [string]$Action = 'add',
    [Parameter(Position = 1, Mandatory = $true)]
    [string]$Package
)

$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'dsh-undo.ps1'

Write-Host "== dsh-plugin: $Action $Package =="

# 1. pre-snapshot (rollback point)
& $tool snapshot -Label "before plugin $Action $Package"
if ($LASTEXITCODE -ne 0) { Write-Warning 'Pre-snapshot failed; continuing anyway.' }

# 1.5 environment preflight (W86): same checks as the install hooks, strict mode aborts on blocking.
& node (Join-Path $PSScriptRoot 'install-preflight.mjs') --strict
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'Environment preflight failed; installation aborted (see the lines above).'
    exit $LASTEXITCODE
}

# 2. run the real command
& npx.cmd @deepseek-ai/dsh plugin --profile web $Action $Package
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host "== plugin $Action FAILED (exit $code); rolling back to pre-snapshot =="
    & $tool restore -Id latest -Force
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Auto-rollback failed. Run manually: dsh-undo.ps1 restore -Id latest -Force' }
    Write-Host "== rollback done =="
    exit $code
}

# 3. post-snapshot (the new state is now recoverable too)
& $tool snapshot -Label "after plugin $Action $Package"
Write-Host "== done. Restart DSH to apply. To roll back this install:"
Write-Host "   .\dsh-undo.ps1 list"
Write-Host "   .\dsh-undo.ps1 restore -Id <pre-snapshot-id> -Force"
