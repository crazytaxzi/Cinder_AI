# Troubleshooting

## Service does not start

```bash
systemctl status cinder.service --no-pager
journalctl -u cinder.service -n 250 --no-pager
```

Startup stops before Discord and Twitch connect when the full real-tool OpenAI self-test fails. The log contains the exact API error and request ID.

## Dashboard is not reachable remotely

First confirm local health:

```bash
curl -fsS http://127.0.0.1:3100/health/ready
```

Then run:

```bash
cinderctl expose
```

and repair the selected Tailscale, Cloudflare, Caddy, or SSH path. The application itself intentionally remains bound to localhost.

## Discord works but thinking fails

Open **Exact failures** in the dashboard or run `cinderctl logs`. There is no generic fallback that conceals the cause.

## Twitch verification fails

Check that both Twitch tokens are still valid and that `cinder_ai` and `sentionce` remain distinct accounts. The live verifier requires EventSub readiness and a successful Twitch chat send.

## Database

```bash
pg_lsclusters
pg_isready -h 127.0.0.1 -p "$(python3 /opt/cinder/current/scripts/native_env.py get --file /etc/cinder/cinder.env CINDER_PG_PORT)"
```

The Cinder cluster is separate from other PostgreSQL clusters and does not use Docker.
