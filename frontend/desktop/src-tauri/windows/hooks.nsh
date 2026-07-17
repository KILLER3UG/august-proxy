; Kill August + its Python/Node backend before NSIS copies files.
; Otherwise Windows returns "Error opening file for writing" on locked
; resources\python\DLLs\_asyncio.pyd (and similar native modules).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping August and backend processes…"
  ; Main app (+ child tree when /T works)
  nsExec::ExecToLog 'taskkill /F /IM August.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM august-desktop.exe /T'
  ; Orphans whose exe lives under the install dir or AppData runtime
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match ''^(python|pythonw|node)(\.exe)?$'' -and $_.ExecutablePath -and ($_.ExecutablePath -like ''*\August\*'' -or $_.ExecutablePath -like ''*\com.august.proxy\*'') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 1500
!macroend
