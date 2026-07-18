param(
    [string]$InstallDirectory = "$env:LOCALAPPDATA\CinderBridge"
)

$ErrorActionPreference = "Stop"
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-Secret([string]$Prompt) {
    $Secure = Read-Host $Prompt -AsSecureString
    $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr) }
}

$NodeVersion = (& node --version 2>$null)
if (-not $NodeVersion) { throw "Node.js 22 or newer is required." }
$Major = [int]($NodeVersion.TrimStart('v').Split('.')[0])
if ($Major -lt 22) { throw "Node.js 22 or newer is required. Found $NodeVersion." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required." }

Write-Host "Installing Cinder's Windows hands to $InstallDirectory"
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null

Get-ChildItem $SourceDirectory -Force | Where-Object {
    $_.Name -notin @('node_modules', '.env', 'logs')
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $InstallDirectory -Recurse -Force
}

Push-Location $InstallDirectory
try {
    npm install --omit=dev --no-audit --no-fund

    $BridgeToken = Read-Secret "Bridge token from the VM"
    if ([string]::IsNullOrWhiteSpace($BridgeToken) -or $BridgeToken.Length -lt 16) {
        throw "The bridge token is missing or too short."
    }

    $SongDirectories = Read-Host "Song directories separated by semicolons [$env:USERPROFILE\Music]"
    if ([string]::IsNullOrWhiteSpace($SongDirectories)) { $SongDirectories = "$env:USERPROFILE\Music" }

    $KnownApplications = Read-Host 'Known applications JSON [{"obs":"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe"}]'
    if ([string]::IsNullOrWhiteSpace($KnownApplications)) {
        $KnownApplications = '{"obs":"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe"}'
    }

    $ObsPassword = Read-Secret "OBS WebSocket password (press Enter when unused)"
    $TunnelMode = Read-Host "Use automatic gcloud tunnel? [Y/n]"
    if ($TunnelMode -match '^[Nn]') { $TunnelModeValue = 'none' } else { $TunnelModeValue = 'gcloud' }

    $Project = 'overtoolkit-speech-api'
    $Zone = 'us-west1-b'
    $Instance = 'neon-wreckers'
    $VmUser = 'crazytaxzi'
    if ($TunnelModeValue -eq 'gcloud') {
        if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
            throw "Google Cloud CLI is required for the automatic secure tunnel."
        }
        $Input = Read-Host "Google Cloud project [$Project]"; if ($Input) { $Project = $Input }
        $Input = Read-Host "VM zone [$Zone]"; if ($Input) { $Zone = $Input }
        $Input = Read-Host "VM instance [$Instance]"; if ($Input) { $Instance = $Input }
        $Input = Read-Host "VM user [$VmUser]"; if ($Input) { $VmUser = $Input }
    }

    $EnvLines = @(
        'CINDER_BRIDGE_URL=ws://127.0.0.1:3010',
        "CINDER_BRIDGE_TOKEN=$BridgeToken",
        'CINDER_BRIDGE_ID=senti-windows',
        "CINDER_TUNNEL_MODE=$TunnelModeValue",
        "CINDER_GCLOUD_PROJECT=$Project",
        "CINDER_GCLOUD_ZONE=$Zone",
        "CINDER_GCLOUD_INSTANCE=$Instance",
        "CINDER_GCLOUD_USER=$VmUser",
        'CINDER_LOCAL_TUNNEL_PORT=3010',
        'CINDER_REMOTE_BRIDGE_HOST=127.0.0.1',
        'CINDER_REMOTE_BRIDGE_PORT=3010',
        "SONG_DIRECTORIES=$SongDirectories",
        "KNOWN_APPLICATIONS_JSON=$KnownApplications",
        'OBS_WEBSOCKET_URL=ws://127.0.0.1:4455',
        "OBS_WEBSOCKET_PASSWORD=$ObsPassword",
        'LOG_LEVEL=info'
    )
    [IO.File]::WriteAllLines((Join-Path $InstallDirectory '.env'), $EnvLines, [Text.UTF8Encoding]::new($false))

    $TaskName = 'Cinder Windows Bridge'
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDirectory\Start-CinderBridge.ps1`""
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Write-Host "Cinder's Windows bridge is installed and started."
    Write-Host "Logs: $InstallDirectory\logs"
} finally {
    Pop-Location
}
