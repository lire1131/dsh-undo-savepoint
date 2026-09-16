# apply-dsh-patches.ps1 - dsh-session-persistence-jsonl 容错补丁托管（v0.3.8, B4；v0.4.8 支持 obsoleted）
#
# 背景：DSH 实际加载的 dsh-session-persistence-jsonl（全局包嵌套版本）缺 3 处
# 容错补丁（appendBatch 自愈 / listArtifacts 隔离 / readFirstZstdLine 宽容），
# 会话文件损坏/竞态会直接拖垮 DSH 启动。本脚本把 lib/ 同仓的补丁清单
# （dsh-patches.json：old = 原始代码片段，new = 已验证补丁代码片段）
# 精确替换到目标文件。所有操作可逆（remove 反向替换）。
#
# 用法: .\apply-dsh-patches.ps1 <status|verify|apply|remove>
#   status  只读：检测每个补丁 applied / missing / obsoleted / unknown（不写任何文件）
#   verify  校验清单每个补丁能在目标文件中精确匹配（applied / missing / obsoleted 都算通过）
#   apply   逐补丁备份（<file>.bak-<id>）+ old->new 替换；已应用或已消解则跳过，未知则中止
#   remove  反向 new->old 还原全部补丁
#
# v0.4.8：清单可给补丁标 obsoletedOn（如 ["0.1.5"]）。官方在 0.1.5 重写了
# appendBatch，原竞态被消解，产物里既无 old 也无 new 锚点，此时该补丁判为
# obsoleted 属预期状态，apply 跳过它并继续处理其余补丁，不再中止（此前 0.1.5
# 上会因它 unknown 而连带放弃另两个可打的补丁）。目标版本从目标包同级的
# package.json 读取；读不到版本时不判 obsoleted，仍保持 unknown 的保守中止语义。

param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'verify', 'apply', 'remove')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$listPath = Join-Path $PSScriptRoot 'dsh-patches.json'
if (-not (Test-Path -LiteralPath $listPath)) { Write-Host "patch manifest not found: $listPath"; exit 2 }
$manifest = Get-Content -LiteralPath $listPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 定位目标文件。DSH_ROOT 指向一份 dsh 产品树时进入严格隔离模式：只认该产品树，
# 不再回落到全局安装与用户级 node_modules，隔离实例（副本 DSH）靠它保证补丁只打
# 副本树、绝不碰本体产物树。产品树判定要求同时存在 package.json 与 lib\bin.js，
# 因为 DSH_ROOT 另有既存含义（dsh 依赖树解析根，测试与 CI 里指向 /tmp/dsh-fake15、
# 用户主目录这类目录），那种目录不触发严格模式。未设置时保持原有优先级：
# 全局 dsh 嵌套 > 全局顶层 > 用户级 > DSH_HOME。
$cands = @()
$productTree = $false
if ($env:DSH_ROOT) {
    $productTree = (Test-Path -LiteralPath (Join-Path $env:DSH_ROOT 'package.json')) -and
                   (Test-Path -LiteralPath (Join-Path $env:DSH_ROOT 'lib\bin.js'))
}
if ($productTree) {
    $cands += (Join-Path $env:DSH_ROOT 'node_modules')
    $cands += $env:DSH_ROOT
} else {
    if ($env:APPDATA) {
        $appdataNpm = Join-Path $env:APPDATA 'npm\node_modules'
        $cands += (Join-Path $appdataNpm '@deepseek-ai\dsh\node_modules')
        $cands += $appdataNpm
    }
    $cands += (Join-Path $HOME 'node_modules')
    if ($env:DSH_HOME) { $cands += (Join-Path $env:DSH_HOME 'node_modules') }
}
$target = $null
foreach ($c in $cands) {
    $p = Join-Path $c $manifest.target
    if (Test-Path -LiteralPath $p) { $target = $p; break }
}
if (-not $target) {
    Write-Host "target not found: $($manifest.target) — searched:"
    $cands | ForEach-Object { Write-Host "  $_" }
    exit 2
}

# v0.4.8：读目标包版本，供 obsoletedOn 判定（补丁已被官方产物消解时无锚点属预期）
$targetVersion = $null
$targetPkgJson = Join-Path (Split-Path (Split-Path $target -Parent) -Parent) 'package.json'
if (Test-Path -LiteralPath $targetPkgJson) {
    try { $targetVersion = (Get-Content -LiteralPath $targetPkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $targetVersion = $null }
}

# v0.4.5：补丁可带多版本子串（variants，DSH 0.1.2-rc.1 起 appendBatch 签名变化），
# 无 variants 的补丁按扁平 old/new 处理（单形态）。任一形态命中即匹配。
function Get-Variants($Patch) {
    if ($Patch.variants) { return @($Patch.variants) }
    return @([pscustomobject]@{ old = $Patch.old; new = $Patch.new })
}

# 补丁声明 obsoletedOn 且目标版本命中该前缀时，无锚点属预期（官方产物已消解该问题）。
# 读不到目标版本时不判定，保持 unknown 的保守中止语义。
function Test-PatchObsoleted($Patch) {
    if (-not $Patch.obsoletedOn) { return $false }
    if (-not $targetVersion) { return $false }
    foreach ($prefix in @($Patch.obsoletedOn)) {
        if ($targetVersion.StartsWith([string]$prefix)) { return $true }
    }
    return $false
}

function Get-PatchState($Text, $Patch) {
    $variants = Get-Variants $Patch
    foreach ($v in $variants) { if ($Text.Contains($v.new)) { return 'applied' } }
    foreach ($v in $variants) { if ($Text.Contains($v.old)) { return 'missing' } }
    if (Test-PatchObsoleted $Patch) { return 'obsoleted' }
    return 'unknown'
}

# 返回当前文本命中的形态：applied 返回 new 命中者，missing 返回 old 命中者，
# 供 apply/remove 做精确替换（多版本子串互不干扰）。
function Get-MatchingVariant($Text, $Patch) {
    $variants = Get-Variants $Patch
    foreach ($v in $variants) { if ($Text.Contains($v.new)) { return $v } }
    foreach ($v in $variants) { if ($Text.Contains($v.old)) { return $v } }
    return $null
}

$text = Get-Content -LiteralPath $target -Raw -Encoding UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

switch ($Action) {
    'status' {
        Write-Host "target: $target"
        if ($targetVersion) { Write-Host "version: $targetVersion" }
        foreach ($p in $manifest.patches) {
            $s = Get-PatchState $text $p
            Write-Host ("  {0,-26} {1,-9} {2}" -f $p.id, $s, $p.description)
            if ($s -eq 'obsoleted') { Write-Host ("  {0,-26} {1,-9} {2}" -f '', '', "官方产物已消解，无需补丁：$($p.obsoletedNote)") }
        }
    }
    'verify' {
        $bad = 0
        $obs = 0
        Write-Host "target: $target"
        if ($targetVersion) { Write-Host "version: $targetVersion" }
        foreach ($p in $manifest.patches) {
            $s = Get-PatchState $text $p
            Write-Host ("  {0,-26} {1,-9} {2}" -f $p.id, $s, $p.description)
            if ($s -eq 'unknown') { $bad++ }
            if ($s -eq 'obsoleted') { $obs++ }
        }
        if ($bad -gt 0) { Write-Host "verify FAILED: $bad patch(es) cannot be matched (manual edit of the target? first inspect the diff before running apply/remove)."; exit 1 }
        if ($obs -gt 0) { Write-Host "verify OK: all patches resolve ($obs obsoleted by the official product, expected on this version)." }
        else { Write-Host 'verify OK: all patches resolve (applied or missing).' }
    }
    'apply' {
        $any = $false
        Write-Host "target: $target"
        if ($targetVersion) { Write-Host "version: $targetVersion" }
        foreach ($p in $manifest.patches) {
            $s = Get-PatchState $text $p
            if ($s -eq 'applied') { Write-Host "  skip    $($p.id) (already applied)"; continue }
            if ($s -eq 'obsoleted') { Write-Host "  skip    $($p.id) (obsoleted：DSH $targetVersion 官方产物已消解，无锚点属预期)"; continue }
            if ($s -eq 'unknown') { Write-Host "  ERROR   $($p.id) (neither old nor new matches — target manually edited? aborting, nothing written)"; exit 1 }
            $v = Get-MatchingVariant $text $p
            $bak = "$target.bak-$($p.id)"
            if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $target -Destination $bak -Force }
            $text = $text.Replace($v.old, $v.new)
            $any = $true
            Write-Host "  apply   $($p.id)"
        }
        if ($any) {
            [System.IO.File]::WriteAllText($target, $text, $utf8NoBom)
            Write-Host "written: $target"
        }
        Write-Host 'apply done. Restart DSH for the patches to take effect.'
    }
    'remove' {
        $any = $false
        Write-Host "target: $target"
        if ($targetVersion) { Write-Host "version: $targetVersion" }
        foreach ($p in $manifest.patches) {
            $s = Get-PatchState $text $p
            if ($s -eq 'missing') { Write-Host "  skip    $($p.id) (already removed)"; continue }
            if ($s -eq 'obsoleted') { Write-Host "  skip    $($p.id) (obsoleted：官方产物已消解，无补丁可还原)"; continue }
            if ($s -eq 'unknown') { Write-Host "  ERROR   $($p.id) (cannot match new — target manually edited? aborting, nothing written)"; exit 1 }
            $v = Get-MatchingVariant $text $p
            $text = $text.Replace($v.new, $v.old)
            $any = $true
            Write-Host "  remove  $($p.id)"
        }
        if ($any) {
            [System.IO.File]::WriteAllText($target, $text, $utf8NoBom)
            Write-Host "written: $target"
        }
        Write-Host 'remove done. Restart DSH for the change to take effect.'
    }
}
