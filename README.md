# Cinder Native 2.0

Cinder is Senti's one continuous shoulder-demon intelligence across Discord, Twitch, Discord voice, the Windows bridge, and the remote administration dashboard.

This release replaces the Docker deployment completely. Cinder runs as a hardened native `systemd` service with a private Node.js runtime and a dedicated native PostgreSQL cluster. Other Docker workloads on the VM are left alone.

## Install

Extract the release somewhere other than the old `/home/crazytaxzi/Cinder` directory, then run:

```bash
sudo ./scripts/install-native.sh
```

The installer automatically finds and preserves the old `.env`, verifies the complete build, performs a real OpenAI round trip with every production tool, cuts over from the old Cinder container, verifies Discord chat, a harmless Discord administration action, and Twitch chat, then removes the old Cinder Docker resources only after all checks pass.

## Cost-aware cognition and voice

Cinder continuously hears Discord voice without a wake word. Discord speech frames are transcribed with `gpt-4o-mini-transcribe` for accuracy, with the resident local Whisper installation retained as an automatic network/API fallback. Ordinary Discord, Twitch, and voice conversation first uses a compact `gpt-5.4-nano` attention turn. That turn can speak, remain silent, or escalate administration, moderation, memory, and complex work to the full `gpt-5.4-mini` agent with its tools.

Voice prompts contain only the live conversational beat, a short rolling voice history, participants, and a few relevant memories. They do not carry the full server topology and action ledger. Piper runs as a persistent local worker so its model loads once per Cinder process, and local speech generation remains API-free. Cloud transcription duration and nano/mini token costs are recorded in PostgreSQL and included in dashboard cost totals.

The main tuning settings are `CINDER_SOCIAL_MODEL`, `CINDER_VOICE_SOCIAL_MODEL`, `CINDER_VOICE_CLOUD_TRANSCRIPTION`, `CINDER_VOICE_CONTEXT_EVENT_LIMIT`, `CINDER_VOICE_MAX_REPLY_CHARACTERS`, and `CINDER_VOICE_SPEECH_END_MS`.

Failure before final verification triggers automatic rollback.

## Dashboard

The authenticated dashboard provides:

- Live readiness and connection state
- Direct natural commands to the same Cinder mind
- Pending approval review
- Exact action and tool-result history
- Discord/Twitch conversation history
- Exact failures with OpenAI request IDs and stacks
- Memory inspection and deletion
- Cross-platform identity linking
- Discord roles and channels selected by name
- Pause, resume, and restart controls
- Full real-tool OpenAI self-test
- Live Discord, administration, and Twitch verification

After installation, the guided remote-access menu supports Tailscale, Cloudflare Tunnel, Caddy with a domain, or a Google Cloud SSH tunnel.

## Operations

```bash
cinderctl status
cinderctl logs 200
cinderctl follow
cinderctl self-test
cinderctl verify-live
cinderctl restart
cinderctl backup
cinderctl expose
cinderctl dashboard-password
```

## Native paths

- Current release: `/opt/cinder/current`
- Versioned releases: `/opt/cinder/releases`
- Private Node runtime: `/opt/cinder/runtime/node`
- Preserved secrets: `/etc/cinder/cinder.env`
- Database backups and state: `/var/lib/cinder`
- Service: `cinder.service`
- Database cluster: dedicated PostgreSQL cluster named `cinder`

See `docs/WEB_ADMIN_PATHS.md`, `docs/ARCHITECTURE.md`, and `docs/OPERATIONS.md` for full details.
