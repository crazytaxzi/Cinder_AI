# Remote Web Administration Paths

## The dashboard itself

The Cinder dashboard is a complete authenticated control surface, not a health-page placeholder.

### Overview

Shows native hosting state, Discord, Twitch, Windows bridge, OpenAI full-tool self-test, queue depth, pause state, and database record counts.

### Command Cinder

Sends a natural request into the same Cinder timeline used by Discord and Twitch. The dashboard supplies verified owner and moderator context. An optional Discord channel can be selected by name to ground references.

### Approvals

Lists pending consequential actions with their exact intended tool and arguments. Senti can approve or deny. The original Cinder context is retained and the same tool registry executes the result.

### Actions

Shows every tool call, arguments, verified API result, timestamp, source event, and failure. Cinder cannot claim an action succeeded without a successful result appearing here.

### Conversation

Searchable platform views for Discord text, Discord voice transcripts, Twitch chat, Twitch events, and dashboard/Windows events.

### Exact failures

Shows the unique failure ID, exact error, stack, OpenAI request ID, API code, HTTP status, source platform, and acknowledgment state. The old generic “loose wire” catch-all is removed.

### Memory and identities

Memory can be inspected and deleted. Observed Discord and Twitch identities can be explicitly linked. Audience scopes remain visible so private context is not mistaken for public context.

### Configuration

The dashboard loads verified Discord channels and roles and presents them by name. It controls moderator role, voice invitation role, optional approval channel, channels where Cinder should remain entirely quiet, and channels excluded from long-term memory.

### Runtime and verification

Senti can pause, resume, or restart Cinder. The verification page can run the full OpenAI tool-set round trip or the complete live Discord/admin/Twitch verification.

## Access path 1: Tailscale private HTTPS

**Recommended default.**

The VM and each authorized phone/computer join the same Tailscale network. `tailscale serve` publishes the localhost dashboard through private HTTPS. The dashboard is not exposed to the public Internet, and its own password remains required.

Best when:

- Senti wants access from a phone and personal computers
- No public domain is required
- Access should be private by default

Tradeoffs:

- Tailscale must be installed on each accessing device
- The VM must be approved into the tailnet once

Configure or repair with:

```bash
cinderctl expose
```

Choose option 1.

## Access path 2: Cloudflare Tunnel plus Access

A remotely managed Cloudflare Tunnel makes an outbound connection from the VM. A public hostname maps to `http://localhost:3100`. Cloudflare Access should be configured in front of it, and the Cinder dashboard password remains a second layer.

Best when:

- Senti owns a domain in Cloudflare
- Access is needed from arbitrary browsers without a VPN client
- Identity-based Cloudflare Access policies are desired

Tradeoffs:

- Requires a Cloudflare account, tunnel, hostname, and token
- Access policy configuration happens in Cloudflare
- A public hostname exists, although Access blocks unauthorized visitors

Choose option 2 and provide the tunnel token. The script installs `cloudflared` as a native system service. No Docker is involved.

## Access path 3: Caddy with a domain

Caddy listens on public ports 80 and 443, obtains and renews TLS automatically, and reverse-proxies to localhost port 3100.

Best when:

- A domain already points to the VM
- A direct conventional HTTPS endpoint is preferred
- Firewall ports 80 and 443 can be opened

Tradeoffs:

- The VM is directly reachable from the Internet
- DNS and firewall configuration must be correct
- The dashboard password is the primary application authentication, so a long unique password is mandatory

Choose option 3 and enter the domain.

## Access path 4: Google Cloud SSH tunnel

The dashboard remains localhost-only. `gcloud compute ssh` forwards a local port from the computer to the VM. Nothing new is exposed publicly.

Best when:

- Access is mainly from the Windows desktop
- No additional account or domain should be introduced
- Temporary access is acceptable

Tradeoffs:

- The PowerShell tunnel must remain open
- It is less convenient from a phone

The command is printed by option 4.

## Access path 5: Localhost only

The dashboard remains available only at `http://127.0.0.1:3100` on the VM. This is appropriate during maintenance or while selecting another access method.

## Rejected path: raw public port

The package deliberately does not open port 3100 directly to the Internet. Password authentication without a secure transport and network boundary is not an acceptable default for a server-administration console.
