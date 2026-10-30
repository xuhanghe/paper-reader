@echo off
rem Puts a "Paper Reader" shortcut on the desktop and in the Start menu
rem (Windows). Double-click this once; afterwards the shortcut is the one
rem click: it starts Zotero if it isn't running, starts the reader and opens
rem it in the browser, or only opens the browser when the reader is already
rem up. It runs start.cmd in a minimized window: closing that window stops
rem the reader.
rem
rem Run it again after moving this folder, so the shortcut follows.
setlocal
set "PR_ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = $env:PR_ROOT.TrimEnd('\');" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $path = Join-Path $dir 'Paper Reader.lnk';" ^
  "  $link = $shell.CreateShortcut($path);" ^
  "  $link.TargetPath = Join-Path $root 'start.cmd';" ^
  "  $link.WorkingDirectory = $root;" ^
  "  $link.IconLocation = (Join-Path $root 'app\favicon.ico') + ',0';" ^
  "  $link.WindowStyle = 7;" ^
  "  $link.Description = 'Start Zotero and open Paper Reader';" ^
  "  $link.Save();" ^
  "  Write-Host ('Made ' + $path)" ^
  "}"
if errorlevel 1 (
  echo The shortcut couldn't be made. Run start.cmd instead.
  exit /b 1
)
echo Double-click "Paper Reader" on the desktop or in the Start menu to start it.
pause
