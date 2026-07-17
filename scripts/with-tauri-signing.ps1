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
    Write-Error "Missing $KeyPath — run: npx tauri signer generate -w tauri-signing.key --ci -f (from frontend/desktop)"
}

$env:TAURI_SIGNING_PRIVATE_KEY_PATH = $KeyPath
# Prefer path-based signing so we never echo key material into the shell history.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

if ($args.Count -eq 0) {
    Write-Host "Signing env ready (TAURI_SIGNING_PRIVATE_KEY_PATH=$KeyPath)"
    exit 0
}

& $args[0] @($args | Select-Object -Skip 1)
exit $LASTEXITCODE
