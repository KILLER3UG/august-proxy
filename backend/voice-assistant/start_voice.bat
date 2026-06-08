@echo off
title August Voice Assistant
echo Starting August Voice Assistant...
echo Proxy: http://localhost:8085
echo Say "August" followed by your command.
echo.
python "%~dp0august_voice.py"
if %errorlevel% neq 0 (
    echo.
    echo Failed to start. Make sure Python dependencies are installed:
    echo    pip install sounddevice numpy requests pyttsx3 pystray pillow SpeechRecognition
    pause
)
