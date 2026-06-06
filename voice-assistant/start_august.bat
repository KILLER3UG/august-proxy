@echo off
title August Desktop
echo Starting August Desktop...
echo Proxy: http://localhost:8085
echo Say "August" to wake the transparent overlay.
echo Esc to hide it back to background.
echo.
cd /d "%~dp0"
python -u august_desktop.py
if %errorlevel% neq 0 (
    echo.
    echo Failed to start. Make sure dependencies are installed:
    echo    pip install pywebview sounddevice numpy requests pystray pillow SpeechRecognition
    pause
)
