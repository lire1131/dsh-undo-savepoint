# make-desktop-shortcut.ps1 — 在桌面一键创建「DSH 撤销管理器」快捷方式
#
# 用途：解决"装完插件找不到局外撤销工具"的问题。
# 自动定位插件目录（按顺序）：
#   1) 本脚本自己就在插件的 tools 目录里（方式 B：clone + junction）；
#   2) 常见安装位置（方式 A：dsh plugin add → profile 依赖树；方式 B：用户 node_modules）。
# 找到后把 tools\launch-undo.bat 的快捷方式放到桌面，双击即可打开
# 「DSH 撤销管理器」窗口（DSH 崩溃、启动不了时也能用）。快捷方式名与插件内创建逻辑一致
# （dsh-undo-savepoint.lnk），目标同为 cmd.exe + /c launch-undo.bat；已存在且指向当前安装
# 位置时跳过，指向别处时重写。
#
# 用法：
#   双击 tools\make-desktop-shortcut.bat（推荐，会自动保持窗口）
#   或：powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-desktop-shortcut.ps1

$ErrorActionPreference = 'Stop'

# 定位插件的 tools 目录；找不到返回 $null
function Find-UndoToolsDir {
    # 1) 自身就在插件 tools 目录里（最常见：直接双击仓库/安装目录里的 bat）
    $self = Join-Path $PSScriptRoot 'dsh-undo-savepoint-gui.bat'
    if (Test-Path -LiteralPath $self) { return $PSScriptRoot }

    # 2) 搜索常见安装位置（只查固定候选路径，避免递归扫整个 node_modules 树）
    #    issue #6:优先 $DSH_HOME（自定义家目录客户端），否则 %USERPROFILE%\.dsh
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $candidates = @(
        (Join-Path $dshHome 'profiles\web\node_modules\dsh-undo-savepoint'),
        (Join-Path $dshHome 'profiles\node_modules\dsh-undo-savepoint'),
        (Join-Path $env:USERPROFILE 'node_modules\dsh-undo-savepoint')
    )
    foreach ($c in $candidates) {
        $tools = Join-Path $c 'tools'
        if (Test-Path -LiteralPath (Join-Path $tools 'dsh-undo-savepoint-gui.bat')) {
            return $tools
        }
    }
    return $null
}

$toolsDir = Find-UndoToolsDir
if (-not $toolsDir) {
    Write-Host '未找到 dsh-undo-savepoint 插件（tools 目录不存在）。请先安装插件：'
    Write-Host '  dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master'
    Write-Host '安装后重跑本脚本。'
    Read-Host '按回车退出'
    exit 1
}

$targetBat = Join-Path $toolsDir 'launch-undo.bat'
if (-not (Test-Path -LiteralPath $targetBat)) { $targetBat = Join-Path $toolsDir 'dsh-undo-savepoint-gui.bat' }
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'dsh-undo-savepoint.lnk'

$ws = New-Object -ComObject WScript.Shell

# W59：存在不等于正确。先读回现有快捷方式，目标与当前安装位置一致就跳过（保留用户自定义
# 图标）；指向别的实例或旧安装位置时按当前安装位置重写。旧口径只判文件存在，快捷方式被改成
# 指向隔离实例的启动脚本也发现不了。与插件内的创建逻辑同名同目标（cmd.exe + /c launch-undo.bat）。
if (Test-Path -LiteralPath $lnk) {
    $cur = $ws.CreateShortcut($lnk)
    $sameTarget = ($cur.TargetPath -match '(?i)cmd(\.exe)?$') -and (($cur.Arguments -replace '"', '') -like ('*' + $targetBat + '*'))
    $sameDir = ((($cur.WorkingDirectory) -replace '\\+$', '') -ieq (($toolsDir) -replace '\\+$', ''))
    if ($sameTarget -and $sameDir) {
        Write-Host "桌面快捷方式已指向当前安装位置，跳过：$lnk"
        Read-Host '按回车退出'
        exit 0
    }
    Write-Host "现有快捷方式指向别处（$($cur.TargetPath) $($cur.Arguments)），按当前安装位置重写。"
}

$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'cmd.exe'
$sc.Arguments = '/c ""' + $targetBat + '""'
$sc.WorkingDirectory = $toolsDir            # 工作目录设为 tools，保证相对路径解析正确
$ico = Join-Path $toolsDir 'webui\logo.ico'
if (Test-Path -LiteralPath $ico) { $sc.IconLocation = $ico + ',0' }
$sc.Description = 'DSH 撤销管理器（dsh-undo-savepoint 局外工具）'
$sc.Save()

Write-Host "已创建桌面快捷方式：$lnk"
Write-Host '双击桌面的「DSH撤销管理器」即可打开撤销工具（DSH 打不开时也能用）。'
Write-Host '如需删除：右键快捷方式 → 删除即可，不影响插件本身。'
Read-Host '按回车退出'
