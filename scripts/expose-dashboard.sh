#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
source /opt/cinder/current/scripts/native-lib.sh
port="$(env_get PORT)"; port="${port:-3100}"
user="${SUDO_USER:-crazytaxzi}"
project="${GOOGLE_CLOUD_PROJECT:-overtoolkit-speech-api}"
zone="${GOOGLE_CLOUD_ZONE:-us-west1-b}"
instance="$(hostname -s)"

cat <<EOF

Cinder dashboard remote access

1. Tailscale private HTTPS (recommended)
   Best for your phone and computers. Only devices in your Tailscale network can reach it.

2. Cloudflare Tunnel
   Best for a public hostname protected by Cloudflare Access. Requires a Cloudflare tunnel token.

3. Caddy with your own domain
   Direct HTTPS on the VM. Requires a DNS name pointing here and inbound ports 80/443.

4. Google Cloud SSH tunnel
   No new service and no public exposure. The browser works while the tunnel window stays open.

5. Localhost only
   Keep the dashboard at http://127.0.0.1:${port}/
EOF
read -r -p 'Choose 1-5 [1]: ' choice
choice="${choice:-1}"

case "$choice" in
  1)
    if ! command -v tailscale >/dev/null 2>&1; then
      curl -fsSL https://tailscale.com/install.sh | sh
    fi
    systemctl enable --now tailscaled
    if ! tailscale status >/dev/null 2>&1; then
      echo 'Tailscale will print a sign-in URL. Open it and approve this VM.'
      tailscale up
    fi
    tailscale serve reset >/dev/null 2>&1 || true
    tailscale serve --bg "http://127.0.0.1:${port}"
    dns="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))')"
    echo "Cinder Admin: https://${dns}/"
    ;;
  2)
    if ! command -v cloudflared >/dev/null 2>&1; then
      arch="$(dpkg --print-architecture)"
      tmp="$(mktemp --suffix=.deb)"
      curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" -o "$tmp" || {
        rm -f "$tmp"
        echo 'Automatic cloudflared download failed. Use the Cloudflare package instructions, then rerun cinderctl expose.' >&2
        exit 1
      }
      dpkg -i "$tmp" || apt-get -f install -y
      rm -f "$tmp"
    fi
    read -rsp 'Cloudflare Tunnel token: ' token; echo
    [[ -n "$token" ]] || fail 'A tunnel token is required.'
    cloudflared service uninstall >/dev/null 2>&1 || true
    cloudflared service install "$token"
    echo
    echo "In Cloudflare, publish the tunnel hostname to http://localhost:${port}."
    echo 'Protect it with a Cloudflare Access policy. The Cinder password remains required too.'
    ;;
  3)
    read -r -p 'Dashboard domain (example: cinder.example.com): ' domain
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'That domain is not valid.'
    apt-get update
    apt-get install -y caddy
    cat > /etc/caddy/Caddyfile <<EOF
${domain} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${port}
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "same-origin"
  }
}
EOF
    systemctl enable --now caddy
    systemctl reload caddy
    echo "Cinder Admin: https://${domain}/"
    ;;
  4)
    cat <<EOF
Run this in Windows PowerShell and leave the window open:

gcloud compute ssh ${user}@${instance} --project=${project} --zone=${zone} --ssh-flag="-N" --ssh-flag="-L ${port}:127.0.0.1:${port}"

Then open: http://127.0.0.1:${port}/
EOF
    ;;
  5)
    echo "Dashboard remains private at http://127.0.0.1:${port}/"
    ;;
  *) fail 'Choose 1, 2, 3, 4, or 5.' ;;
esac
