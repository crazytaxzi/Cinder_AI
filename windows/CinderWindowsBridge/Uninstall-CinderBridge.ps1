param(
    [string]$InstallDirectory = "$env:LOCALAPPDATA\CinderBridge"
)
$ErrorActionPreference = "Stop"
$TaskName = 'Cinder Windows Bridge'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($InstallDirectory)
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
if (Test-Path $InstallDirectory) { Remove-Item $InstallDirectory -Recurse -Force }
Write-Host "Cinder's Windows bridge was removed."
