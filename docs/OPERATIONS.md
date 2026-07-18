# Operations

## Daily commands

```bash
cinderctl status
cinderctl logs 200
cinderctl follow
cinderctl restart
```

## Verification

```bash
cinderctl self-test
cinderctl verify-live
```

`self-test` sends all production tool definitions to OpenAI, executes a harmless function call, sends the tool result back, and requires a final response.

`verify-live` creates temporary Discord channels, sends a real conversational reply, executes a harmless moderator administration action, cleans it up, checks Twitch EventSub, and sends a Twitch reply. It returns nonzero when any step fails.

## Backup

```bash
cinderctl backup
```

Backups are stored in `/var/lib/cinder/backups` as PostgreSQL custom-format dumps with the matching environment file and SHA-256 list.

## Restore

```bash
sudo /opt/cinder/current/scripts/restore-native.sh /var/lib/cinder/backups/cinder-TIMESTAMP.dump
```

## Deployment

Extract a future complete release and run:

```bash
sudo ./scripts/deploy-native.sh
```

The deployment builds and tests the candidate, runs the full-tool preflight, switches atomically, runs readiness and live verification, and rolls back automatically on failure.

## Dashboard access

```bash
cinderctl url
cinderctl expose
cinderctl dashboard-password
```

## Exact troubleshooting

```bash
cinderctl logs 300
journalctl -u cinder.service --since '15 minutes ago' --no-pager
```

Cognitive failures also appear in the dashboard with a unique error ID and the OpenAI request ID when available.
