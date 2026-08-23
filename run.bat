@echo off
rem DeepSpeak launcher (Windows)
rem Usage: double-click, or run "run.bat" from a terminal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   DeepSpeak - English Deep Learning (local-first, no API key)
echo ============================================================

rem 1. Locate Python (prefer py launcher, fall back to python)
set PY=
where py >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('py -3 -c "import sys; print(sys.executable)"') do set PY=%%i
)
if not defined PY (
  where python >nul 2>nul
  if %errorlevel%==0 set PY=python
)
if not defined PY (
  echo [ERROR] Python 3.10+ not found. Install it from https://www.python.org/downloads/
  echo         and make sure "Add Python to PATH" is checked.
  pause
  exit /b 1
)

rem 2. Virtual environment (created on first run)
if not exist ".venv\Scripts\python.exe" (
  echo [1/3] First run: creating virtual environment...
  "%PY%" -m venv .venv
)

rem 3. Optional local ASR (faster-whisper). App works fully without it.
".venv\Scripts\python.exe" -c "import faster_whisper" >nul 2>nul
if errorlevel 1 (
  echo [2/3] Installing faster-whisper (local speech recognition, needs internet once)...
  ".venv\Scripts\pip.exe" install -q faster-whisper
  if errorlevel 1 (
    echo       Install failed (network?). App still works: only mic transcription is off.
    echo       Re-run run.bat later to retry.
  )
)

rem 4. Start server (audio for built-in materials is generated on first launch)
echo [3/3] Starting server at http://127.0.0.1:8531 ...
".venv\Scripts\python.exe" -m backend.server %*
pause
