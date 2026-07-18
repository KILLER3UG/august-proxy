; Close August + its hidden Python backend before NSIS copies files.
; Orphan uvicorn/python often survive after the tray UI is gone and lock
; resources\python\DLLs\_asyncio.pyd — beginners then see a scary Abort/Retry dialog.
;
; Strategy (must stay automatic — no Task Manager steps for users):
;   1) Kill August.exe
;   2) Kill any python/node whose path/command line mentions August / this install
;   3) Kill whatever still listens on 8085
;   4) Rename locked python trees out of the way so the copy can proceed
;   5) Retry a few times; only then show a plain-language Retry prompt

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing August so it can be updated…"

  Push $R0
  Push $R1

  FileOpen $R0 "$TEMP\august-preinstall-stop.ps1" w
  FileWrite $R0 "param([string]$$InstallDir = '')$\r$\n"
  FileWrite $R0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R0 "function Stop-AugustEverything {$\r$\n"
  FileWrite $R0 "  Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R0 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
  FileWrite $R0 "    $$.Name -match '^(python|pythonw|node)(\.exe)?$$' -and ($$\r$\n"
  FileWrite $R0 "      ($$.ExecutablePath -and ($$\r$\n"
  FileWrite $R0 "        $$.ExecutablePath -match '[\\/]August([\\/]|$)' -or$\r$\n"
  FileWrite $R0 "        $$.ExecutablePath -match 'com\.august\.proxy' -or$\r$\n"
  FileWrite $R0 "        $$.ExecutablePath -match 'backend-runtime' -or$\r$\n"
  FileWrite $R0 "        ($$InstallDir -and $$.ExecutablePath.StartsWith($$InstallDir, [System.StringComparison]::OrdinalIgnoreCase))$\r$\n"
  FileWrite $R0 "      )) -or$\r$\n"
  FileWrite $R0 "      ($$.CommandLine -and ($$\r$\n"
  FileWrite $R0 "        $$.CommandLine -match '[\\/]August([\\/]|$)' -or$\r$\n"
  FileWrite $R0 "        $$.CommandLine -match 'com\.august\.proxy' -or$\r$\n"
  FileWrite $R0 "        $$.CommandLine -match 'uvicorn.*app\.main' -or$\r$\n"
  FileWrite $R0 "        $$.CommandLine -match 'AUGUST_PROXY' -or$\r$\n"
  FileWrite $R0 "        ($$InstallDir -and $$.CommandLine.IndexOf($$InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)$\r$\n"
  FileWrite $R0 "      ))$\r$\n"
  FileWrite $R0 "    )$\r$\n"
  FileWrite $R0 "  } | ForEach-Object { Stop-Process -Id $$.ProcessId -Force }$\r$\n"
  FileWrite $R0 "  foreach ($$port in 8085, 8787) {$\r$\n"
  FileWrite $R0 "    Get-NetTCPConnection -LocalPort $$port -State Listen -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R0 "      ForEach-Object { Stop-Process -Id $$.OwningProcess -Force }$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "function Move-LockedPythonTree([string]$$Root) {$\r$\n"
  FileWrite $R0 "  if (-not $$Root -or -not (Test-Path -LiteralPath $$Root)) { return }$\r$\n"
  FileWrite $R0 "  $$stamp = Get-Date -Format 'yyyyMMddHHmmss'$\r$\n"
  FileWrite $R0 "  $$dlls = Join-Path $$Root 'DLLs'$\r$\n"
  FileWrite $R0 "  if (Test-Path -LiteralPath $$dlls) {$\r$\n"
  FileWrite $R0 "    try { Rename-Item -LiteralPath $$dlls -NewName ('DLLs.old_' + $$stamp) -Force } catch {}$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "  $$py = Join-Path $$Root 'python.exe'$\r$\n"
  FileWrite $R0 "  if (Test-Path -LiteralPath $$py) {$\r$\n"
  FileWrite $R0 "    try { Rename-Item -LiteralPath $$py -NewName ('python.exe.old_' + $$stamp) -Force } catch {}$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "  Get-ChildItem -LiteralPath $$Root -Filter '*.old_*' -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R0 "    ForEach-Object { Remove-Item -LiteralPath $$.FullName -Recurse -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "for ($$i = 0; $$i -lt 4; $$i++) {$\r$\n"
  FileWrite $R0 "  Stop-AugustEverything$\r$\n"
  FileWrite $R0 "  Start-Sleep -Milliseconds 700$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "$$candidates = @($\r$\n"
  FileWrite $R0 "  (Join-Path $$InstallDir 'resources\python'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:LOCALAPPDATA 'August\resources\python')$\r$\n"
  FileWrite $R0 ") | Select-Object -Unique$\r$\n"
  FileWrite $R0 "foreach ($$c in $$candidates) { Move-LockedPythonTree $$c }$\r$\n"
  FileWrite $R0 "Stop-AugustEverything$\r$\n"
  FileWrite $R0 "Start-Sleep -Milliseconds 1000$\r$\n"
  FileClose $R0

  StrCpy $R1 0
  stop_retry_loop:
    nsExec::ExecToLog 'taskkill /F /IM August.exe /T'
    nsExec::ExecToLog 'taskkill /F /IM august-desktop.exe /T'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\august-preinstall-stop.ps1" -InstallDir "$INSTDIR"'
    Sleep 1500

    IfFileExists "$INSTDIR\resources\python\DLLs\_asyncio.pyd" 0 stop_done
    Rename "$INSTDIR\resources\python\DLLs\_asyncio.pyd" "$INSTDIR\resources\python\DLLs\_asyncio.pyd.old"
    IfFileExists "$INSTDIR\resources\python\DLLs\_asyncio.pyd" 0 stop_done

    IntOp $R1 $R1 + 1
    IntCmp $R1 3 stop_ask stop_retry_loop stop_ask

  stop_ask:
    MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION \
      "August is still finishing in the background.$\r$\n$\r$\nClick Retry — we will close it for you.$\r$\nNo need to open Task Manager." \
      IDRETRY stop_retry_loop
    Goto stop_done

  stop_done:
  Delete /REBOOTOK "$INSTDIR\resources\python\DLLs\_asyncio.pyd.old"
  Delete "$TEMP\august-preinstall-stop.ps1"

  Pop $R1
  Pop $R0
!macroend
