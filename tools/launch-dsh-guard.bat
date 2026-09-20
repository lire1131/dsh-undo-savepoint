@echo off
chcp 65001 >nul
rem dsh-undo-savepoint guarded DSH launcher (Windows).
rem Usage: launch-dsh-guard.bat [--safe-mode ask|on|off] [--profile <name>] [-- <dsh args>]
setlocal
set "DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [guard] Node.js not found. Please install Node.js ^>= 20 and add it to PATH.
  pause
  exit /b 1
)
node "%DIR%guard.mjs" %*
endlocal
