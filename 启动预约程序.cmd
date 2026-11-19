@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 24 或以上版本后重试。
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 (
  echo 本程序需要 Node.js 24 或以上版本。
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo 正在安装本项目依赖，请保持联网。
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
node src/server.ts --open
pause
