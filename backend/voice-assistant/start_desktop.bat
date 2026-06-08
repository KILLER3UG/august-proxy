@echo off
title August Desktop
echo Starting August Desktop...
echo Proxy: http://localhost:8085
echo Say "August" to open the transparent desktop UI.
echo.
python "%~dp0august_desktop.py"
if %errorlevel% neq 0 (
    echo.
    echo Failed to start. Make sure Python dependencies are installed:
    echo    pip install sounddevice numpy requests pystray pillow SpeechRecognition
    pause
)
