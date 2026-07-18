#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import urllib.parse
from pathlib import Path


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in raw:
            continue
        key, value = raw.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def render(values: dict[str, str]) -> str:
    groups = [
        ('Core', ['NODE_ENV','LOG_LEVEL','HOST','PORT','DATABASE_URL','DATABASE_SSL','MIGRATIONS_DIR']),
        ('OpenAI', ['OPENAI_API_KEY','OPENAI_MODEL','OPENAI_REASONING_EFFORT','OPENAI_TIMEOUT_MS','OPENAI_MAX_RETRIES','STARTUP_SELF_TEST','OPENAI_TRANSCRIBE_MODEL','CINDER_SOCIAL_MODEL','CINDER_VOICE_SOCIAL_MODEL','CINDER_VOICE_CLOUD_TRANSCRIPTION','CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE','OPENAI_TTS_MODEL','OPENAI_TTS_VOICE','OPENAI_TTS_INSTRUCTIONS','CINDER_VOICE_SPEED','CINDER_VOICE_PITCH']),
        ('Discord', ['DISCORD_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID','CINDER_OWNER_DISCORD_ID','DEFAULT_MODERATOR_ROLE_NAME','DEFAULT_VOICE_JOIN_ROLE_NAME','DISCORD_VOICE_IDLE_MINUTES','DISCORD_VOICE_MAX_UTTERANCE_SECONDS']),
        ('Twitch', ['TWITCH_ENABLED','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','TWITCH_BOT_ACCESS_TOKEN','TWITCH_BOT_REFRESH_TOKEN','TWITCH_BOT_USER_ID','TWITCH_BROADCASTER_ACCESS_TOKEN','TWITCH_BROADCASTER_REFRESH_TOKEN','TWITCH_BROADCASTER_ID','TWITCH_CHAT_BATCH_MS','TWITCH_MAX_BATCH_MESSAGES']),
        ('Windows bridge', ['BRIDGE_ENABLED','BRIDGE_TOKEN','BRIDGE_PORT','BRIDGE_COMMAND_TTL_SECONDS','BRIDGE_PUBLISH_ADDRESS']),
        ('Cinder context', ['SCENE_RECENT_EVENT_LIMIT','SCENE_MEMORY_LIMIT','SCENE_RECENT_ACTION_LIMIT','CINDER_SOCIAL_CONTEXT_EVENT_LIMIT','CINDER_SOCIAL_MAX_REPLY_CHARACTERS','CINDER_VOICE_CONTEXT_EVENT_LIMIT','CINDER_VOICE_MAX_REPLY_CHARACTERS','CINDER_VOICE_SPEECH_END_MS','CINDER_MAX_TOOL_ROUNDS','CINDER_MAX_OUTPUT_TOKENS','CINDER_MAX_REPLY_CHARACTERS','CINDER_PROFILE_PATH','LOCAL_PIPER_WORKER','EVENT_RETENTION_DAYS','ACTION_RETENTION_DAYS','EXTERNAL_EVENT_RETENTION_DAYS']),
        ('Dashboard', ['DASHBOARD_ENABLED','DASHBOARD_ADMIN_PASSWORD_HASH','DASHBOARD_SESSION_SECRET','DASHBOARD_SESSION_TTL_HOURS','CINDER_INTERNAL_CONTROL_TOKEN']),
        ('Native PostgreSQL metadata', ['POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','CINDER_PG_MAJOR','CINDER_PG_CLUSTER','CINDER_PG_PORT']),
    ]
    used: set[str] = set()
    lines: list[str] = []
    for title, keys in groups:
        lines.append(f'# {title}')
        for key in keys:
            if key in values:
                lines.append(f'{key}={values[key]}')
                used.add(key)
        lines.append('')
    extras = sorted(set(values) - used)
    if extras:
        lines.append('# Preserved additional settings')
        lines.extend(f'{key}={values[key]}' for key in extras)
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
    return f'scrypt${enc(salt)}${enc(digest)}'


def prepare(args: argparse.Namespace) -> None:
    source = Path(args.source)
    target = Path(args.target)
    values = parse_env(source)
    required = ['OPENAI_API_KEY','DISCORD_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID']
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise SystemExit('The preserved .env is missing: ' + ', '.join(missing))

    db_user = values.get('POSTGRES_USER') or 'cinder'
    db_name = values.get('POSTGRES_DB') or 'cinder'
    db_password = values.get('POSTGRES_PASSWORD')
    if not db_password or db_password == 'CHANGE_ME':
        db_password = secrets.token_hex(32)

    dashboard_password = ''
    if not values.get('DASHBOARD_ADMIN_PASSWORD_HASH'):
        dashboard_password = secrets.token_urlsafe(18)
        values['DASHBOARD_ADMIN_PASSWORD_HASH'] = hash_password(dashboard_password)

    values.update({
        'NODE_ENV': 'production',
        'HOST': '127.0.0.1',
        'PORT': args.port,
        'DATABASE_URL': f"postgresql://{urllib.parse.quote(db_user, safe='')}:{urllib.parse.quote(db_password, safe='')}@127.0.0.1:{args.pg_port}/{urllib.parse.quote(db_name, safe='')}",
        'DATABASE_SSL': 'false',
        'MIGRATIONS_DIR': '/opt/cinder/current/migrations',
        'CINDER_PROFILE_PATH': '/opt/cinder/current/config/cinder-profile.md',
        'OPENAI_TIMEOUT_MS': values.get('OPENAI_TIMEOUT_MS') or '120000',
        'OPENAI_MAX_RETRIES': values.get('OPENAI_MAX_RETRIES') or '2',
        'STARTUP_SELF_TEST': 'true',
        'CINDER_SOCIAL_MODEL': 'gpt-5.4-nano',
        'CINDER_VOICE_SOCIAL_MODEL': 'gpt-5.4-nano',
        'CINDER_VOICE_CLOUD_TRANSCRIPTION': 'true',
        'CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE': '0.003',
        'CINDER_SOCIAL_CONTEXT_EVENT_LIMIT': '10',
        'CINDER_SOCIAL_MAX_REPLY_CHARACTERS': '500',
        'CINDER_VOICE_CONTEXT_EVENT_LIMIT': '8',
        'CINDER_VOICE_MAX_REPLY_CHARACTERS': '220',
        'CINDER_VOICE_SPEECH_END_MS': '550',
        'CINDER_VOICE_SPEED': '0.468',
        'LOCAL_PIPER_WORKER': '/opt/cinder/current/scripts/piper-worker.py',
        'DASHBOARD_ENABLED': 'true',
        'DASHBOARD_SESSION_SECRET': values.get('DASHBOARD_SESSION_SECRET') or secrets.token_urlsafe(48),
        'DASHBOARD_SESSION_TTL_HOURS': values.get('DASHBOARD_SESSION_TTL_HOURS') or '72',
        'CINDER_INTERNAL_CONTROL_TOKEN': values.get('CINDER_INTERNAL_CONTROL_TOKEN') or secrets.token_urlsafe(48),
        'POSTGRES_USER': db_user,
        'POSTGRES_DB': db_name,
        'POSTGRES_PASSWORD': db_password,
        'CINDER_PG_MAJOR': args.pg_major,
        'CINDER_PG_CLUSTER': 'cinder',
        'CINDER_PG_PORT': args.pg_port,
    })
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render(values))
    os.chmod(target, 0o640)
    if dashboard_password:
        Path(args.password_output).write_text(
            'Cinder Admin Dashboard\n'
            f'Username: Senti\nPassword: {dashboard_password}\n'
            f'Local URL: http://127.0.0.1:{args.port}/\n'
        )
        os.chmod(args.password_output, 0o600)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--source', required=True)
    prep.add_argument('--target', required=True)
    prep.add_argument('--pg-port', required=True)
    prep.add_argument('--pg-major', required=True)
    prep.add_argument('--port', default='3100')
    prep.add_argument('--password-output', required=True)
    get = sub.add_parser('get')
    get.add_argument('--file', required=True)
    get.add_argument('key')
    hp = sub.add_parser('hash-password')
    hp.add_argument('password')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args)
    elif args.command == 'get':
        print(parse_env(Path(args.file)).get(args.key, ''))
    elif args.command == 'hash-password':
        print(hash_password(args.password))

if __name__ == '__main__':
    main()
