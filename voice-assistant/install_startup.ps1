$wshell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
$lnk = $wshell.CreateShortcut("$startup\August Desktop.lnk")
$lnk.TargetPath = "C:\Users\rober\LocalFolders\DockerContainer\august-proxy\apps\voice-assistant\start_august.bat"
$lnk.WorkingDirectory = "C:\Users\rober\LocalFolders\DockerContainer\august-proxy\apps\voice-assistant"
$lnk.Description = "August voice assistant - say August to wake"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Host "Auto-start shortcut created in Startup folder"
