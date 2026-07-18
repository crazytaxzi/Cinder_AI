# Cinder Native 2.0 Verification Report

## Verified in the build environment

- npm lockfile installation completed
- Shared, Core, and Windows bridge TypeScript production builds completed
- 32 automated tests passed across Core and Windows bridge
- Explicit repaired-core tests passed for:
  - normal conversation without a tool
  - deliberate silence through a parsed function call
  - `function_call_output` continuation
  - strict schema required/nullable rules
  - harmless Discord administration execution
  - named Twitch response delivery through the Twitch adapter
- Existing tests passed for scene assembly, social priority, instructions, memory context, Twitch events, voice codec, WAV output, configuration, queueing, and Windows actions
- Behavioral evaluation contract validation is included in the production verification command
- All shell scripts pass `bash -n`
- Dashboard assets, authenticated control endpoints, and production static serving are validated
- npm production dependency audit reports zero known vulnerabilities
- Docker files and Docker runtime scripts are absent from the native package

## Enforced on the target VM before installation succeeds

- Clean npm install from `package-lock.json`
- Production dependency security audit
- Full TypeScript checks and tests
- Production build
- Complete OpenAI strict tool-set submission
- Harmless function call parsing and tool-output continuation
- Native PostgreSQL migration
- systemd readiness
- Discord connection
- Real Discord conversational delivery
- Harmless moderator administration action and cleanup
- Twitch EventSub readiness and live chat delivery
- Automatic rollback on any failed health or live-verification step

Live account verification cannot be performed inside the artifact environment because it does not contain the user's private Discord, Twitch, or OpenAI credentials. The installer performs those checks on the VM and refuses to remove the previous deployment until they pass.
