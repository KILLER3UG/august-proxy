# scripts/with-tauri-signing.ps1
# Loads the local updater signing key into the environment, then runs the
# remaining args as a command. The key file is gitignored (tauri-signing.key).
#
# Usage:
#   .\scripts\with-tauri-signing.ps1 npm run release:desktop
#   .\scripts\with-tauri-signing.ps1 npm run tauri -w frontend/desktop build

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$KeyPath = Join-Path $RepoRoot 'tauri-signing.key'

if (-not (Test-Path -LiteralPath $KeyPath)) {
    Write-Error "Missing $KeyPath - run: npx tauri signer generate -w tauri-signing.key --ci -f (from frontend/desktop)"
}

# Tauri CLI expects the key material in TAURI_SIGNING_PRIVATE_KEY (not just a path).
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = $KeyPath
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

if ($args.Count -eq 0) {
    Write-Host "Signing env ready (key loaded from $KeyPath)"
    exit 0
}

# Rebuild the command line from the RAW argv (not $args — PowerShell mangles
# tokens like -w or --flag value pairs when splatting positionally) and run it.
# `& $args[0] @($args | Select-Object -Skip 1)` broke `npm run tauri -w ...`:
# npm received '-w' as its own arg in the wrong position and failed.
$cmd = ($args -join ' ')
Invoke-Expression $cmd
exit $LASTEXITCODE
