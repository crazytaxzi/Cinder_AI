$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDirectory = Join-Path $Root "logs"
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Set-Location $Root

$Node = (Get-Command node -ErrorAction Stop).Source
$LogFile = Join-Path $LogDirectory "bridge.log"
$ErrorFile = Join-Path $LogDirectory "bridge-error.log"

& $Node (Join-Path $Root "dist\index.js") 1>> $LogFile 2>> $ErrorFile
exit $LASTEXITCODE
