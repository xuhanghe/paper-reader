@echo off
rem One command from a fresh clone to the reader open in your browser (Windows).
rem
rem   start.cmd
rem
rem It checks for Node.js (the one thing it cannot install for you), then the
rem launcher installs the dependencies the first time, starts the server and
rem opens the reader once the server answers. From there the setup assistant
rem inside the app connects Zotero and a coding agent. Stop it with Ctrl-C.
rem
rem   set PORT=3100 && start.cmd                  a fixed port instead of the next free one
rem   set PAPER_READER_NO_OPEN=1 && start.cmd    don't open a browser
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Paper Reader needs Node.js 20 or newer, and this machine has none.
  echo   Install the LTS version from https://nodejs.org, then run start.cmd again.
  exit /b 1
)
for /f "usebackq delims=" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Paper Reader needs Node.js 20 or newer; this is Node %NODE_MAJOR%.
  echo   Update it from https://nodejs.org, then run start.cmd again.
  exit /b 1
)

node scripts\start.mjs
exit /b %errorlevel%
