# Native Architecture

## One Cinder

Discord text, Twitch chat, Discord voice, Windows events, dashboard commands, memory, moderation, and administration enter one serialized cognitive timeline. There is no admin submind, permission persona, moderation persona, or pre-conversation classifier.

Platform adapters provide verified identity, role, channel, reply, message, thread, speaker, and event facts. Cinder receives those facts and decides whether to answer, stay silent, use a tool, moderate, remember, or request approval.

## Process layout

- `cinder.service` runs one Node.js process as the unprivileged `cinder` user.
- A private Node runtime is installed under `/opt/cinder/runtime/node`.
- Releases are immutable directories under `/opt/cinder/releases`.
- `/opt/cinder/current` is an atomic symlink to the active release.
- Secrets are stored at `/etc/cinder/cinder.env`, readable only by root and the `cinder` group.
- Persistent records use a dedicated native PostgreSQL cluster named `cinder` on its own port.
- The web dashboard listens only on `127.0.0.1:3100` and is published through an explicit secure access method.

## OpenAI turn loop

Every real tool is registered as a strict Responses API function. Every object property is included in `required`; conceptually optional values are nullable. Startup verification sends the complete production tool set, forces a harmless tool call, parses the function call, executes it, returns a `function_call_output`, and requires a final model response.

A cognitive failure receives a unique error ID. The database stores the exact error name, message, stack, OpenAI request ID, API code, and HTTP status. Discord receives a short truthful failure with the dashboard error reference rather than a generic catch-all sentence.

## Transactional deployment

A candidate release is built and tested before the active service is touched. A standalone full-tool OpenAI preflight runs against the candidate. Cutover changes the `current` symlink, starts the candidate, waits for readiness, and runs live platform verification.

Failure restores the previous symlink and service. During the first Docker-to-native conversion, failure restarts the old Cinder app container. Old Docker resources are deleted only after the native candidate passes every live check.

## Docker isolation

Cinder itself does not use Docker. The installer only calls Docker when an old `/home/crazytaxzi/Cinder/compose.yaml` exists, and then only to stop and remove that specific old Compose project after native verification. No unrelated container, image, volume, or network is selected.
