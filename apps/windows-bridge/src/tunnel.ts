import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import type { BridgeConfig } from './config.js';

export class TunnelManager {
  private process: ChildProcess | undefined;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.config.CINDER_TUNNEL_MODE !== 'gcloud' || this.process || this.stopped) return;
    const executable = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
    const target = `${this.config.CINDER_GCLOUD_USER}@${this.config.CINDER_GCLOUD_INSTANCE}`;
    const forward = `${this.config.CINDER_LOCAL_TUNNEL_PORT}:${this.config.CINDER_REMOTE_BRIDGE_HOST}:${this.config.CINDER_REMOTE_BRIDGE_PORT}`;
    const args = [
      'compute', 'ssh', target,
      `--project=${this.config.CINDER_GCLOUD_PROJECT}`,
      `--zone=${this.config.CINDER_GCLOUD_ZONE}`,
      '--quiet',
      '--ssh-flag=-N',
      `--ssh-flag=-L${forward}`,
      '--ssh-flag=-oExitOnForwardFailure=yes',
      '--ssh-flag=-oServerAliveInterval=30',
      '--ssh-flag=-oServerAliveCountMax=3',
    ];

    this.logger.info({ target, forward }, 'Starting secure gcloud tunnel to Cinder core');
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout?.on('data', (data) => this.logger.debug({ output: String(data).trim() }, 'gcloud tunnel output'));
    child.stderr?.on('data', (data) => this.logger.debug({ output: String(data).trim() }, 'gcloud tunnel diagnostic'));
    child.on('error', (error) => this.logger.error({ err: error }, 'gcloud tunnel failed to start'));
    child.on('exit', (code, signal) => {
      if (this.process === child) this.process = undefined;
      this.logger.warn({ code, signal }, 'gcloud tunnel exited');
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          this.start();
        }, 5_000);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.process?.kill();
    this.process = undefined;
  }
}
