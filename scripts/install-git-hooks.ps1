#Requires -Version 5.1
<#
.SYNOPSIS
  Install a Device Guard–safe Git pre-commit hook for August Proxy.

.DESCRIPTION
  Stock `pre-commit install` hard-codes backend-py/.venv/Scripts/python.exe.
  On some Windows machines Application Control blocks that binary, so every
  `git commit` fails with "Permission denied".

  This script:
    1. Finds a working Python that can import pre_commit (installs the package
       on the first viable interpreter if needed).
    2. Writes .git/hooks/pre-commit from scripts/git-hooks/pre-commit with LF
       line endings and the chosen interpreter path.

.EXAMPLE
  .\scripts\install-git-hooks.ps1
#>

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

function Test-PreCommitPython {
  param([string]$PythonExe)
  if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe)) { return $false }
  try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $null = & $PythonExe -c "import pre_commit" 2>&1
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prev
    return $ok
  } catch {
    return $false
  }
}

function Install-PreCommitPackage {
  param([string]$PythonExe)
  Write-Host "Installing pre-commit via $PythonExe ..."
  & $PythonExe -m pip install --upgrade pre-commit
  if ($LASTEXITCODE -ne 0) { throw "pip install pre-commit failed ($LASTEXITCODE)" }
}

$candidates = @(
  (Get-Command py -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
  "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  (Join-Path $RepoRoot 'backend-py\.venv\Scripts\python.exe'),
  (Get-Command python -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
) | Where-Object { $_ } | Select-Object -Unique

$python = $null
foreach ($c in $candidates) {
  # `py` launcher needs special handling
  if ($c -match '[\\/]py\.exe$') {
    try {
      $resolved = & py -3 -c "import sys; print(sys.executable)" 2>$null
      if ($resolved -and (Test-PreCommitPython $resolved.Trim())) {
        $python = $resolved.Trim()
        break
      }
      # Try install onto py -3
      Write-Host "Trying: py -3 -m pip install pre-commit"
      & py -3 -m pip install --upgrade pre-commit 2>&1 | Out-Host
      $resolved = & py -3 -c "import sys; print(sys.executable)" 2>$null
      if ($resolved -and (Test-PreCommitPython $resolved.Trim())) {
        $python = $resolved.Trim()
        break
      }
    } catch { continue }
    continue
  }

  if (Test-PreCommitPython $c) {
    $python = $c
    break
  }

  # Offer to install on this interpreter if it runs at all
  try {
    $null = & $c -c "print(1)" 2>&1
    if ($LASTEXITCODE -eq 0) {
      try {
        Install-PreCommitPackage -PythonExe $c
        if (Test-PreCommitPython $c) {
          $python = $c
          break
        }
      } catch {
        Write-Warning "Could not install pre-commit on $c : $_"
      }
    } else {
      Write-Host "Skipping blocked or unusable interpreter: $c"
    }
  } catch {
    # Device Guard / missing binary
    Write-Host "Skipping blocked or unusable interpreter: $c"
  }
}

if (-not $python) {
  throw @"
No working Python with pre-commit found.
Install Python from python.org, then:
  py -3 -m pip install pre-commit
  .\scripts\install-git-hooks.ps1
"@
}

Write-Host "Using Python: $python"

# Forward-slash path for Git Bash
$installPython = ($python -replace '\\', '/')

$templatePath = Join-Path $RepoRoot 'scripts\git-hooks\pre-commit'
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "Missing template: $templatePath"
}

$template = [System.IO.File]::ReadAllText($templatePath)
# Force INSTALL_PYTHON line to the chosen interpreter
$template = [regex]::Replace(
  $template,
  "INSTALL_PYTHON='[^']*'",
  "INSTALL_PYTHON='$installPython'"
)
# LF only (Git Bash chokes on CRLF in shebang scripts)
$template = $template -replace "`r`n", "`n" -replace "`r", "`n"
if (-not $template.EndsWith("`n")) { $template += "`n" }

$hookDir = Join-Path $RepoRoot '.git\hooks'
if (-not (Test-Path -LiteralPath $hookDir)) {
  throw "Not a git repo (missing .git/hooks): $RepoRoot"
}
$hookPath = Join-Path $hookDir 'pre-commit'
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hookPath, $template, $utf8)

Write-Host "Wrote $hookPath"
Write-Host "INSTALL_PYTHON=$installPython"

# Smoke-test via Git Bash when available
$gitBash = @(
  "${env:ProgramFiles}\Git\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($gitBash) {
  Write-Host "Smoke-testing hook with Git Bash..."
  $repoUnix = ($RepoRoot.Path -replace '\\', '/' -replace '^([A-Za-z]):', { '/' + $_.Groups[1].Value.ToLower() })
  # cygpath-style: C:\Dev\foo -> /c/Dev/foo
  $drive = $RepoRoot.Path.Substring(0, 1).ToLower()
  $rest = $RepoRoot.Path.Substring(2) -replace '\\', '/'
  $repoUnix = "/$drive$rest"
  & $gitBash -lc "cd '$repoUnix' && .git/hooks/pre-commit" | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Hook smoke test exited $LASTEXITCODE (may be ok if no staged files)."
  } else {
    Write-Host "Hook smoke test OK."
  }
} else {
  Write-Host "Git Bash not found; skip smoke test. Commit once to verify."
}

Write-Host "Done."
