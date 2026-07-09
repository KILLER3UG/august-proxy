# install.ps1 — August Proxy desktop backend setup (Windows)
#
# One-shot setup: create backend-py/.venv with Python >= 3.12 and install
# the backend as an editable package. Run once after cloning, before
# `npm run dev:desktop`.
#
#   .\install.ps1
#
# Idempotent: skips venv creation if a valid .venv already exists.
# Prefers the `py` launcher (py -3) so we avoid the Microsoft Store stub.

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not (Test-Path $RepoRoot)) { $RepoRoot = $PSScriptRoot }
$BackendDir = Join-Path $RepoRoot 'backend-py'
$VenvDir   = Join-Path $BackendDir '.venv'
$VenvPy    = Join-Path $VenvDir 'Scripts\python.exe'
$PipExe     = Join-Path $VenvDir 'Scripts\pip.exe'

function Find-Python {
    # 1. py launcher (preferred — avoids Store stub)
    try {
        $v = & py -3 --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Found Python via py launcher: $v"
            return 'py'
        }
    } catch { }
    # 2. py without -3
    try {
        $v = & py --version 2>&1
        if ($LASTEXITCODE -eq 0) { return 'py' }
    } catch { }
    # 3. python3 / python on PATH (reject Store stub path)
    foreach ($cmd in 'python3', 'python') {
        try {
            $p = (Get-Command $cmd -ErrorAction Stop).Source
            if ($p -and $p -notmatch 'WindowsApps') {
                $v = & $cmd --version 2>&1
                if ($LASTEXITCODE -eq 0) { return $cmd }
            }
        } catch { }
    }
    return $null
}

function Assert-Version {
    param($Cmd)
    # Parse "Python X.Y.Z" and require >= 3.12
    $out = & $Cmd --version 2>&1 | Out-String
    if ($out -match 'Python (\d+)\.(\d+)') {
        $maj = [int]$Matches[1]; $min = [int]$Matches[2]
        if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 12)) { return $true }
    }
    Write-Warning "Python >= 3.12 is required (found: $out)"
    return $false
}

if (-not (Test-Path $BackendDir)) {
    Write-Error "backend-py directory not found at $BackendDir. Clone the repo first."
    exit 1
}

$PyCmd = Find-Python
if (-not $PyCmd) {
    Write-Error "No suitable Python found. Install Python 3.12+ (https://www.python.org/downloads/) and ensure 'py' or 'python' is on PATH."
    exit 1
}
if (-not (Assert-Version $PyCmd)) { exit 1 }

# Create venv if missing or invalid
$NeedVenv = $true
if (Test-Path $VenvPy) {
    try {
        $ok = & $VenvPy -c "import fastapi" 2>&1
        if ($LASTEXITCODE -eq 0) { $NeedVenv = $false }
    } catch { $NeedVenv = $true }
}

if ($NeedVenv) {
    Write-Host "Creating virtual environment at $VenvDir ..."
    if ($PyCmd -eq 'py') {
        & py -3 -m venv $VenvDir
    } else {
        & $PyCmd -m venv $VenvDir
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create venv."; exit 1 }
} else {
    Write-Host "Reusing existing venv at $VenvDir"
}

# Prefer uv if available, else pip
$UseUv = $false
try { & uv --version 2>&1 | Out-Null; $UseUv = $LASTEXITCODE -eq 0 } catch { }

Write-Host "Installing backend dependencies ..."
if ($UseUv) {
    if (Test-Path (Join-Path $BackendDir 'uv.lock')) {
        & uv sync --project $BackendDir
    } else {
        & uv pip install -e "$BackendDir"
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "uv install failed."; exit 1 }
} else {
    & $PipExe install -e "$BackendDir"
    if ($LASTEXITCODE -ne 0) { Write-Error "pip install failed."; exit 1 }
}

# Version stamp (repo location for dev parity; the desktop app re-stamps
# into its app-data dir on first run — see backend.rs syncBackendDeps).
try {
    $ver = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
    $dataDir = Join-Path $RepoRoot 'data'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Set-Content -Path (Join-Path $dataDir 'backend-version.txt') -Value $ver
} catch { Write-Warning "Could not write version stamp (non-fatal)." }

Write-Host ""
Write-Host "✅ Backend ready." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  npm install"
Write-Host "  npm run dev:desktop"
