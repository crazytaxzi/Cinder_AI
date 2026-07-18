# Cinder Native 2.0 Installation

## What this installer does

The installer preserves the existing Cinder `.env`, but removes the previous Cinder project, containers, images, network, and database volume only after the native replacement passes live verification. It never runs Cinder in Docker and does not stop or modify unrelated Docker workloads.

It installs:

- A checksum-verified private Node.js runtime under `/opt/cinder/runtime`
- A dedicated native PostgreSQL cluster on an isolated port
- A versioned release under `/opt/cinder/releases`
- A hardened `systemd` service
- The authenticated remote administration dashboard
- Transactional deployment and rollback tooling

## Upload

From Windows PowerShell:

```powershell
gcloud compute scp "$env:USERPROFILE\Downloads\Cinder_Native_2.0.0_Complete.zip" crazytaxzi@neon-wreckers:/home/crazytaxzi/ --project=overtoolkit-speech-api --zone=us-west1-b
```

Connect:

```powershell
gcloud compute ssh crazytaxzi@neon-wreckers --project=overtoolkit-speech-api --zone=us-west1-b
```

## Extract away from the old Cinder directory

```bash
cd /home/crazytaxzi
rm -rf CinderNativeInstaller
unzip Cinder_Native_2.0.0_Complete.zip -d CinderNativeInstaller
cd CinderNativeInstaller
chmod +x scripts/*
```

## Install

```bash
sudo ./scripts/install-native.sh
```

That is the complete installation command.

The installer finds `/home/crazytaxzi/Cinder/.env` automatically. To use another preserved file:

```bash
sudo CINDER_ENV_SOURCE=/path/to/preserved.env ./scripts/install-native.sh
```

## Verification performed before success

The installation is not declared successful until all of these pass:

1. Frozen npm dependency installation from the packaged lockfile
2. TypeScript checks
3. Automated normal-chat, silence, admin-tool, Twitch, voice, memory, and configuration tests
4. Production build
5. Behavioral-contract validation
6. Full real OpenAI tool-schema and tool-output round trip
7. Native service readiness
8. Discord gateway connection
9. Real Discord conversational reply in a temporary channel
10. Harmless moderator-requested channel creation and cleanup
11. Twitch EventSub readiness and a live Twitch chat reply

A failed cutover restores the previous native release, or restarts the old Cinder Docker app during the first conversion.

## Dashboard

At the end, choose a remote access method. Tailscale private HTTPS is the recommended default. The dashboard password is generated once and saved at:

```text
/home/crazytaxzi/Cinder-Dashboard-Login.txt
```

Change it later with:

```bash
cinderctl dashboard-password
```
