# install.ps1 — August Proxy desktop backend setup (Windows)
#
# One-shot setup: create backend-py/.venv with Python >= 3.12 and install
# the backend as an editable package. Run once after cloning, before
# `npm run dev:desktop`.
#
#   .\install.ps1
#
# Idempotent: skips venv creation if a valid .venv already exists.
# Prefers uv-managed 3.12, then the py launcher / a PATH python >= 3.12.

$ErrorActionPreference = 'Stop'

# install.ps1 lives at the repo root (same as install.sh).
$RepoRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'backend-py'))) {
    $parent = Resolve-Path (Join-Path $PSScriptRoot '..') -ErrorAction SilentlyContinue
    if ($parent -and (Test-Path (Join-Path $parent 'backend-py'))) {
        $RepoRoot = $parent.Path
    }
}
$BackendDir = Join-Path $RepoRoot 'backend-py'
$VenvDir   = Join-Path $BackendDir '.venv'
$VenvPy    = Join-Path $VenvDir 'Scripts\python.exe'
$PipExe     = Join-Path $VenvDir 'Scripts\pip.exe'

function Test-PythonVersion {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$PrefixArgs = @()
    )
    $out = & $Exe @PrefixArgs --version 2>&1 | Out-String
    if ($out -match 'Python (\d+)\.(\d+)') {
        $maj = [int]$Matches[1]; $min = [int]$Matches[2]
        if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 12)) {
            return @{ Ok = $true; Version = $out.Trim() }
        }
    }
    return @{ Ok = $false; Version = $out.Trim() }
}

function Find-Python {
    # Prefer uv (honours backend-py/.python-version = 3.12), then py >=3.12, then PATH.
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        try {
            $uvPy = (& uv python find 3.12 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -eq 0 -and $uvPy) {
                $path = $uvPy.ToString().Trim()
                $check = Test-PythonVersion -Exe $path
                if ($check.Ok) {
                    Write-Host "Found Python via uv: $($check.Version)"
                    return @{ Kind = 'path'; Cmd = $path }
                }
            }
        } catch { }
    }
    # py launcher with an explicit 3.x that is >= 3.12
    foreach ($flag in @('-3.14', '-3.13', '-3.12', '-3')) {
        try {
            $check = Test-PythonVersion -Exe 'py' -PrefixArgs @($flag)
            if ($check.Ok) {
                Write-Host "Found Python via py $flag : $($check.Version)"
                return @{ Kind = 'py'; Flag = $flag }
            }
        } catch { }
    }
    foreach ($cmd in 'python3', 'python') {
        try {
            $p = (Get-Command $cmd -ErrorAction Stop).Source
            if ($p -and $p -notmatch 'WindowsApps') {
                $check = Test-PythonVersion -Exe $cmd
                if ($check.Ok) {
                    Write-Host "Found Python on PATH: $($check.Version) ($p)"
                    return @{ Kind = 'path'; Cmd = $cmd }
                }
            }
        } catch { }
    }
    return $null
}

if (-not (Test-Path $BackendDir)) {
    Write-Error "backend-py directory not found at $BackendDir. Clone the repo first."
    exit 1
}

$Py = Find-Python
if (-not $Py) {
    Write-Error "No suitable Python found. Install Python 3.12+ (https://www.python.org/downloads/) or: uv python install 3.12"
    exit 1
}

# Create venv if missing, invalid, or older than 3.12
$NeedVenv = $true
if (Test-Path $VenvPy) {
    $venvCheck = Test-PythonVersion -Exe $VenvPy
    if (-not $venvCheck.Ok) {
        Write-Warning "Existing venv is not Python >= 3.12 ($($venvCheck.Version)); recreating."
        Remove-Item -Recurse -Force $VenvDir
    } else {
        try {
            $null = & $VenvPy -c "import fastapi" 2>&1
            if ($LASTEXITCODE -eq 0) { $NeedVenv = $false }
        } catch { $NeedVenv = $true }
    }
}

if ($NeedVenv) {
    Write-Host "Creating virtual environment at $VenvDir ..."
    if ($Py.Kind -eq 'py') {
        & py $Py.Flag -m venv $VenvDir
    } else {
        & $Py.Cmd -m venv $VenvDir
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create venv."; exit 1 }
    $after = Test-PythonVersion -Exe $VenvPy
    if (-not $after.Ok) {
        Write-Error "Venv Python is still < 3.12 ($($after.Version)). Install 3.12+ and re-run."
        exit 1
    }
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
