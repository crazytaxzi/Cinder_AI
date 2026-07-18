# Setup

The native installer preserves the verified secrets from the previous `/home/crazytaxzi/Cinder/.env`. It does not ask for OpenAI, Discord, or Twitch credentials again.

Extract the complete package to a separate directory and run:

```bash
sudo ./scripts/install-native.sh
```

The installer creates the native runtime, database cluster, systemd service, dashboard password, transactional release, and secure remote-access choice. See `../INSTALL.md` for exact upload commands.
