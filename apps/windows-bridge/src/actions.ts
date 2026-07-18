import { access, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import loudness from 'loudness';
import OBSWebSocket from 'obs-websocket-js';
import type { BridgeCommand, BridgeResult } from '@cinder/shared';
import type { BridgeConfig } from './config.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma']);

function completed(command: BridgeCommand, ok: boolean, summary: string, data?: Record<string, unknown>): BridgeResult {
  return {
    commandId: command.id,
    completedAt: new Date().toISOString(),
    ok,
    summary,
    ...(data ? { data } : {}),
  };
}

export async function discoverSongs(root: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await discoverSongs(path, depth + 1));
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) output.push(path);
  }
  return output;
}

function openWindowsPath(path: string): void {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function mediaKey(code: number): Promise<void> {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; [K]::keybd_event(${code},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [K]::keybd_event(${code},0,2,[UIntPtr]::Zero)`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    child.once('exit', (codeValue) => codeValue === 0 ? resolve() : reject(new Error(`PowerShell exited ${codeValue}`)));
    child.once('error', reject);
  });
}

export class WindowsActions {
  private readonly obs = new OBSWebSocket();
  private obsConnected = false;

  constructor(private readonly config: BridgeConfig) {}

  capabilities(): BridgeCommand['action'][] {
    return [
      'play_song', 'pause_media', 'resume_media', 'stop_media', 'set_volume',
      'open_application', 'obs_scene', 'obs_stream_start', 'obs_stream_stop',
    ];
  }

  async execute(command: BridgeCommand): Promise<BridgeResult> {
    if (new Date(command.expiresAt).getTime() < Date.now()) {
      return completed(command, false, 'The command expired before it reached Windows.');
    }
    try {
      switch (command.action) {
        case 'play_song': return await this.playSong(command);
        case 'pause_media':
        case 'resume_media':
          await mediaKey(0xB3);
          return completed(command, true, 'Toggled media playback.');
        case 'stop_media':
          await mediaKey(0xB2);
          return completed(command, true, 'Stopped media playback.');
        case 'set_volume': return await this.setVolume(command);
        case 'open_application': return await this.openApplication(command);
        case 'obs_scene': return await this.obsScene(command);
        case 'obs_stream_start': return await this.obsStream(command, true);
        case 'obs_stream_stop': return await this.obsStream(command, false);
      }
    } catch (error) {
      return completed(command, false, error instanceof Error ? error.message : String(error));
    }
  }

  private async playSong(command: BridgeCommand): Promise<BridgeResult> {
    if (this.config.songDirectories.length === 0) {
      return completed(command, false, 'No song directories are configured.');
    }
    const songs = (await Promise.all(this.config.songDirectories.map((directory) => discoverSongs(directory)))).flat();
    if (songs.length === 0) return completed(command, false, 'No playable songs were found in the configured directories.');
    const query = typeof command.arguments.query === 'string' ? command.arguments.query.trim().toLocaleLowerCase() : '';
    const matches = query ? songs.filter((song) => basename(song).toLocaleLowerCase().includes(query)) : songs;
    if (matches.length === 0) return completed(command, false, `No known song matched “${query}”.`);
    const selected = matches[Math.floor(Math.random() * matches.length)]!;
    openWindowsPath(selected);
    return completed(command, true, `Playing ${basename(selected)}.`, { path: selected, title: basename(selected) });
  }

  private async setVolume(command: BridgeCommand): Promise<BridgeResult> {
    const value = Number(command.arguments.percent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return completed(command, false, 'Volume must be between 0 and 100.');
    await loudness.setVolume(Math.round(value));
    return completed(command, true, `Volume set to ${Math.round(value)}%.`);
  }

  private async openApplication(command: BridgeCommand): Promise<BridgeResult> {
    const name = String(command.arguments.name ?? '').trim().toLocaleLowerCase();
    const entry = Object.entries(this.config.knownApplications).find(([key]) => key.toLocaleLowerCase() === name);
    if (!entry) return completed(command, false, `“${name}” is not in the known application list.`);
    await access(entry[1]);
    openWindowsPath(entry[1]);
    return completed(command, true, `Opened ${entry[0]}.`);
  }

  private async ensureObs(): Promise<void> {
    if (this.obsConnected) return;
    await this.obs.connect(this.config.OBS_WEBSOCKET_URL, this.config.OBS_WEBSOCKET_PASSWORD);
    this.obsConnected = true;
    this.obs.once('ConnectionClosed', () => { this.obsConnected = false; });
  }

  private async obsScene(command: BridgeCommand): Promise<BridgeResult> {
    const sceneName = String(command.arguments.scene_name ?? '').trim();
    if (!sceneName) return completed(command, false, 'A scene name is required.');
    await this.ensureObs();
    await this.obs.call('SetCurrentProgramScene', { sceneName });
    return completed(command, true, `Switched OBS to ${sceneName}.`);
  }

  private async obsStream(command: BridgeCommand, start: boolean): Promise<BridgeResult> {
    await this.ensureObs();
    await this.obs.call(start ? 'StartStream' : 'StopStream');
    return completed(command, true, start ? 'Started the OBS stream.' : 'Stopped the OBS stream.');
  }
}
