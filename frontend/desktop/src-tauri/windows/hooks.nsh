; Kill August + its Python/Node backend before NSIS copies files.
; Orphan uvicorn processes (AppData venv AND bundled resources\python) keep
; _asyncio.pyd locked after the tray app exits — that surfaces as
; "Error opening file for writing: …\resources\python\DLLs\_asyncio.pyd".
;
; Inline PowerShell -Command quoting is unreliable under nsExec, so we write a
; small script to %TEMP% and run it with -File (two passes + longer settle).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping August and backend processes…"
  nsExec::ExecToLog 'taskkill /F /IM August.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM august-desktop.exe /T'

  Push $R0
  FileOpen $R0 "$TEMP\august-preinstall-stop.ps1" w
  FileWrite $R0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R0 "function Stop-AugustBackends {$\r$\n"
  FileWrite $R0 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
  FileWrite $R0 "    $$.Name -match '^(python|pythonw|node)(\.exe)?$$' -and ($$\r$\n"
  FileWrite $R0 "      ($$.ExecutablePath -and ($$.ExecutablePath -match 'August|com\.august\.proxy|backend-runtime')) -or$\r$\n"
  FileWrite $R0 "      ($$.CommandLine -and ($$.CommandLine -match 'August|com\.august\.proxy|uvicorn.*app\.main|AUGUST_PROXY'))$\r$\n"
  FileWrite $R0 "    )$\r$\n"
  FileWrite $R0 "  } | ForEach-Object { Stop-Process -Id $$.ProcessId -Force }$\r$\n"
  FileWrite $R0 "  Get-NetTCPConnection -LocalPort 8085 -State Listen -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R0 "    ForEach-Object { Stop-Process -Id $$.OwningProcess -Force }$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "Stop-AugustBackends$\r$\n"
  FileWrite $R0 "Start-Sleep -Milliseconds 800$\r$\n"
  FileWrite $R0 "Stop-AugustBackends$\r$\n"
  FileClose $R0

  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\august-preinstall-stop.ps1"'
  Sleep 2500
  nsExec::ExecToLog 'taskkill /F /IM August.exe /T'
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\august-preinstall-stop.ps1"'
  Sleep 2000
  Delete "$TEMP\august-preinstall-stop.ps1"
  Pop $R0
!macroend
