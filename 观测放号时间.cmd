@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 24 or newer first.
  pause
  exit /b 1
)
echo Release-time read-only observation.
echo Only local /api/check is used (site side: GET settings). No submit, no task enabling.
echo Default: starts 23:50, ends 23:59:40. Log: test-results\diag
node "test-results\diag\observe-release.mjs" %*
pause