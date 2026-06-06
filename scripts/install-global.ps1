# Safely add august-proxy to your user PATH so you can run
# claude-local, codex-local, august-local, and launch from any directory.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')

# Normalize path for comparison
$normalizedDir = (Resolve-Path $dir).Path.TrimEnd('\')

if ($currentPath -split ';' | ForEach-Object { $_.TrimEnd('\') } | Where-Object { $_ -eq $normalizedDir }) {
    Write-Host "[install-global] Already in PATH: $normalizedDir" -ForegroundColor Cyan
    exit 0
}

$newPath = if ($currentPath) { "$currentPath;$normalizedDir" } else { $normalizedDir }
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')

Write-Host "[install-global] Added to user PATH: $normalizedDir" -ForegroundColor Green
Write-Host "[install-global] Close and reopen your terminal, then run:" -ForegroundColor Yellow
Write-Host "               claude-local"
Write-Host "               codex-local"
Write-Host "               august-local"
Write-Host "               launch"
