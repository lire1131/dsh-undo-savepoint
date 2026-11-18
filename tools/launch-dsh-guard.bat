@echo off
chcp 65001 >nul
rem dsh-undo-savepoint guarded DSH launcher (Windows).
rem Usage: launch-dsh-guard.bat [--safe-mode ask|on|off] [--profile <name>] [-- <dsh args>] [--print-node]
rem Node resolution order: DSH_UNDO_NODE override > bundled Node (recorded root) > node on PATH.
setlocal
set "DIR=%~dp0"
set "NODE_EXE="
set "PRINT_NODE="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--print-node" set "PRINT_NODE=1"
shift
goto :parse_args
:args_done

if defined DSH_UNDO_NODE if exist "%DSH_UNDO_NODE%" set "NODE_EXE=%DSH_UNDO_NODE%"
if defined NODE_EXE goto :have_node

set "UNDO_DIR="
if defined DSH_UNDO_SETTINGS goto :dir_settings
if defined DSH_HOME goto :dir_home
set "UNDO_DIR=%USERPROFILE%\.dsh\undo\"
goto :dir_ready
:dir_settings
for %%F in ("%DSH_UNDO_SETTINGS%") do set "UNDO_DIR=%%~dpF"
goto :dir_ready
:dir_home
set "UNDO_DIR=%DSH_HOME%\undo\"

:dir_ready
if not exist "%UNDO_DIR%dsh-root.txt" goto :from_path
set /p DSHROOT=<"%UNDO_DIR%dsh-root.txt"
if not defined DSHROOT goto :from_path
if not exist "%DSHROOT%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" goto :from_path
set "NODE_EXE=%DSHROOT%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
goto :have_node

:from_path
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"

:have_node
if not defined NODE_EXE (
  echo [guard] Node.js not found. Please install Node.js ^>= 20, or set DSH_UNDO_NODE to a node executable.
  echo [guard] Then retry.
  pause
  exit /b 1
)
if defined PRINT_NODE (
  echo %NODE_EXE%
  exit /b 0
)
for %%F in ("%NODE_EXE%") do set "PATH=%%~dpF;%PATH%"
"%NODE_EXE%" "%DIR%guard.mjs" %*
endlocal
