# Privacy and Boundaries

- Secrets live in `/etc/cinder/cinder.env` with root and `cinder` group access only.
- Structured logs redact tokens, API keys, passwords, and authorization headers.
- OpenAI Responses calls use `store: false`.
- Raw Discord voice audio is handled in memory for transcription and is not retained by default.
- Cross-platform identity links require explicit confirmation.
- Twitch and public Discord scenes do not receive Senti-private or moderator-private memories.
- Channels can be excluded from long-term memory through the dashboard or natural Cinder configuration.
- Discord history indexing is an explicit moderator/owner tool, honors memory-excluded channels, and stores exact message references under the normal event-retention policy so indexed messages can be found for later moderation.
- Windows actions are allowlisted. Cinder has no arbitrary shell-execution tool.
- The dashboard listens on localhost and is remotely exposed only through an explicit Tailscale, Cloudflare, Caddy, or SSH path.
- The dashboard uses a scrypt password hash, signed HTTP-only sessions, CSRF protection, login rate limiting, and a short-lived internal control token.
- Action records preserve the requested tool, exact arguments, and the platform result.
