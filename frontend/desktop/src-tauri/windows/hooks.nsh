; Close August + its hidden Python backend before NSIS copies files.
; Orphan uvicorn/python often survive after the tray UI is gone and lock
; resources\python\DLLs\_asyncio.pyd — beginners then see a scary Abort/Retry dialog.
;
; Strategy (must stay automatic — no Task Manager steps for users):
;   1) Kill August.exe
;   2) Kill any python/node whose path/command line mentions August / this install
;   3) Kill whatever still listens on 8085 — but ONLY when the owning process
;      also matches the August markers (never an unrelated service)
;   4) Rename locked python trees out of the way so the copy can proceed
;   5) Retry a few times; only then show a plain-language Retry prompt.
;      A silent/updater install shows no box — it aborts the install rather
;      than copy over a file a live process holds, so the previous version
;      stays intact and the waiter relaunches it.
;
; After install: silent/updater mode must relaunch August — Tauri NSIS does not
; auto-start the app after a quiet update (known gap; see tauri#6955).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing August so it can be updated…"

  Push $R0
  Push $R1

  FileOpen $R0 "$TEMP\august-preinstall-stop.ps1" w
  FileWrite $R0 "param([string]$$InstallDir = '')$\r$\n"
  FileWrite $R0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R0 "function Test-AugustProcess($$p) {$\r$\n"
  FileWrite $R0 "  return ($$p.Name -match '^(python|pythonw|node)(\.exe)?$$' -and ($\r$\n"
  FileWrite $R0 "    ($$p.ExecutablePath -and ($\r$\n"
  FileWrite $R0 "      $$p.ExecutablePath -match '[\\/]August([\\/]|$)' -or$\r$\n"
  FileWrite $R0 "      $$p.ExecutablePath -match 'com\.august\.proxy' -or$\r$\n"
  FileWrite $R0 "      $$p.ExecutablePath -match 'backend-runtime' -or$\r$\n"
  FileWrite $R0 "      ($$InstallDir -and $$p.ExecutablePath.StartsWith($$InstallDir, [System.StringComparison]::OrdinalIgnoreCase))$\r$\n"
  FileWrite $R0 "    )) -or$\r$\n"
  FileWrite $R0 "    ($$p.CommandLine -and ($\r$\n"
  FileWrite $R0 "      $$p.CommandLine -match '[\\/]August([\\/]|$)' -or$\r$\n"
  FileWrite $R0 "      $$p.CommandLine -match 'com\.august\.proxy' -or$\r$\n"
  FileWrite $R0 "      $$p.CommandLine -match 'uvicorn.*app\.main' -or$\r$\n"
  FileWrite $R0 "      $$p.CommandLine -match 'AUGUST_PROXY' -or$\r$\n"
  FileWrite $R0 "      ($$InstallDir -and $$p.CommandLine.IndexOf($$InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)$\r$\n"
  FileWrite $R0 "    ))$\r$\n"
  FileWrite $R0 "  ))$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "function Stop-AugustEverything {$\r$\n"
  FileWrite $R0 "  Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R0 "  Get-CimInstance Win32_Process | Where-Object { Test-AugustProcess $$_ } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }$\r$\n"
  FileWrite $R0 "  foreach ($$port in 8085, 8787) {$\r$\n"
  FileWrite $R0 "    Get-NetTCPConnection -LocalPort $$port -State Listen -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R0 "      ForEach-Object {$\r$\n"
  FileWrite $R0 "        $$owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$_.OwningProcess)$\r$\n"
  FileWrite $R0 "        if ($$owner -and (Test-AugustProcess $$owner)) { Stop-Process -Id $$owner.ProcessId -Force }$\r$\n"
  FileWrite $R0 "      }$\r$\n"
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
  FileWrite $R0 "  $$venvPy = Join-Path $$Root 'Scripts\python.exe'$\r$\n"
  FileWrite $R0 "  if (Test-Path -LiteralPath $$venvPy) {$\r$\n"
  FileWrite $R0 "    try { Rename-Item -LiteralPath $$venvPy -NewName ('python.exe.old_' + $$stamp) -Force } catch {}$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "  $$sitePackages = Join-Path $$Root 'Lib\site-packages'$\r$\n"
  FileWrite $R0 "  if (Test-Path -LiteralPath $$sitePackages) {$\r$\n"
  FileWrite $R0 "    try { Rename-Item -LiteralPath $$sitePackages -NewName ('site-packages.old_' + $$stamp) -Force } catch {}$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "  # -Recurse: two of the renames above land BELOW $$Root (Scripts\python.exe,\r$\n"
  FileWrite $R0 "  # Lib\site-packages), so a top-level scan alone left a full site-packages\r$\n"
  FileWrite $R0 "  # copy behind on every update. Only *.old_* matches, i.e. this scheme's own\r$\n"
  FileWrite $R0 "  # leftovers — locked ones are skipped here and caught by the next update.$\r$\n"
  FileWrite $R0 "  Get-ChildItem -LiteralPath $$Root -Filter '*.old_*' -Recurse -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R0 "    ForEach-Object { Remove-Item -LiteralPath $$_.FullName -Recurse -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "function Test-AnyAugustProcess {$\r$\n"
  FileWrite $R0 "  if (Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue) { return $$true }$\r$\n"
  FileWrite $R0 "  return [bool]@(Get-CimInstance Win32_Process | Where-Object { Test-AugustProcess $$_ })$\r$\n"
  FileWrite $R0 "}$\r$\n"
  ; Four passes was a timer, not a condition: with nothing left to kill it still
  ; burned 2.8 s of sleeps plus four full process enumerations, and the app has
  ; already tree-killed and reaped its own backend before launching this. Stop
  ; as soon as no August-shaped process exists; keep retrying while one does.
  FileWrite $R0 "for ($$i = 0; $$i -lt 4; $$i++) {$\r$\n"
  FileWrite $R0 "  Stop-AugustEverything$\r$\n"
  FileWrite $R0 "  if (-not (Test-AnyAugustProcess)) { break }$\r$\n"
  FileWrite $R0 "  Start-Sleep -Milliseconds 700$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "$$candidates = @($\r$\n"
  FileWrite $R0 "  (Join-Path $$InstallDir 'resources\python'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:APPDATA 'com.august.proxy\backend-runtime\backend-py\.venv')$\r$\n"
  FileWrite $R0 ") | Select-Object -Unique$\r$\n"
  FileWrite $R0 "foreach ($$c in $$candidates) { Move-LockedPythonTree $$c }$\r$\n"
  ; Same rule as the loop above: the last sweep and its second of settling only
  ; matter when something is still alive to sweep.
  FileWrite $R0 "if (Test-AnyAugustProcess) {$\r$\n"
  FileWrite $R0 "  Stop-AugustEverything$\r$\n"
  FileWrite $R0 "  Start-Sleep -Milliseconds 1000$\r$\n"
  FileWrite $R0 "}$\r$\n"
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
    ; Four attempts, not three: each one is cheaper now that the sweep stops as
    ; soon as nothing August-shaped is alive, so the extra try costs time only
    ; when something really is still holding the file.
    IntCmp $R1 4 stop_ask stop_retry_loop stop_ask

  stop_ask:
    ; Reached only when the probe file is STILL locked after every retry. The
    ; old code fell through to `stop_done` here, which started copying over a
    ; file a live process holds: NSIS then half-writes the install, or raises
    ; its own Abort/Retry box — and in a silent update nobody is there to
    ; answer that box, which is the stranded-update failure this file exists to
    ; prevent. Refuse instead. Nothing has been copied yet (this macro is the
    ; first thing `Section Install` runs), so the installed version stays
    ; intact, and the detached post-update waiter sees "no installer running,
    ; no marker" and relaunches August by itself.
    DetailPrint "August is still holding its own files — the update was cancelled and nothing was changed."
    Delete "$TEMP\august-preinstall-stop.ps1"
    IfSilent stop_refuse stop_ask_user

  stop_ask_user:
    MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION \
      "August is still finishing in the background.$\r$\n$\r$\nClick Retry — we will close it for you.$\r$\nCancel leaves your current version untouched." \
      IDRETRY stop_retry_loop
    ; Cancel must not proceed either — same reason as the silent path.
    Abort

  stop_refuse:
    Abort

  stop_done:
  Delete /REBOOTOK "$INSTDIR\resources\python\DLLs\_asyncio.pyd.old"
  Delete "$TEMP\august-preinstall-stop.ps1"

  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Quiet/updater installs exit without starting the app (Tauri#6955).
  ; 1) Write a completion marker so the pre-scheduled safety-net waiter
  ;    knows the file copy finished (it must NOT relaunch mid-install).
  ; 2) Start August via ShellExecute after a short settle delay.
  ;
  ; The marker is written UNCONDITIONALLY, silent or not, so a waiter that is
  ; still running can stop polling. Writing it only in the non-silent branch
  ; meant a silent update wrote nothing at all and the app never came back.
  FileOpen $R9 "$INSTDIR\.august-update-complete" w
  FileWrite $R9 "ok$\r$\n"
  FileClose $R9
  ;
  ; The installer starts the app for EVERY silent install, including /UPDATE.
  ;
  ; It used to skip /UPDATE on the theory that this races the detached waiter
  ; and starts a second August. That theory is now wrong in a way that mattered:
  ; the waiter lives in the app that is being replaced, so a user on an older
  ; build runs the OLD waiter — the one that expired at 600 s and exited without
  ; relaunching — and the installer was the only component in the update that
  ; could not help. The installer is the only part of this path that is always
  ; current, so it is the one that must own bringing the app back.
  ;
  ; The race itself is harmless: a second August hits the single-instance guard
  ; in lib.rs::setup, calls acquireInstanceLock, sees the live owner's pid and
  ; exits — and because INSTANCE_LOCK_OWNED was never set, its exit path neither
  ; kills the first instance's backend nor deletes the other instance's lock
  ; file. Two launches now cost one extra process for a few hundred ms.
  ;
  ; A non-silent install is left alone: NSIS's own finish page starts the app.
  IfSilent 0 august_postinstall_skip
    DetailPrint "Starting August…"
    ; Let file handles / AV scanners settle before launch.
    Sleep 800
    ; ShellExecute is more reliable than Exec for GUI apps after silent NSIS.
    ExecShell "open" "$INSTDIR\August.exe" "" SW_SHOWNORMAL
  august_postinstall_skip:
!macroend
