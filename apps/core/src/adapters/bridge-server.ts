import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  BridgeClientMessage,
  BridgeCommand,
  BridgeResult,
  BridgeServerMessage,
  ToolExecutionResult,
} from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { BridgeToolPort } from '../tools/ports.js';

interface ConnectedBridge {
  id: string;
  socket: WebSocket;
  hostname: string;
  capabilities: string[];
  lastSeenAt: number;
}

interface PendingResult {
  resolve: (result: ToolExecutionResult) => void;
  timer: NodeJS.Timeout;
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BridgeServer implements BridgeToolPort {
  private server?: WebSocketServer;
  private bridge: ConnectedBridge | undefined;
  private readonly pending = new Map<string, PendingResult>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.config.BRIDGE_ENABLED) return;
    this.server = new WebSocketServer({ host: '0.0.0.0', port: this.config.BRIDGE_PORT });
    this.server.on('connection', (socket) => this.handleConnection(socket));
    this.server.on('error', (error) => this.logger.error({ err: error }, 'Windows bridge WebSocket server error'));
    this.logger.info({ port: this.config.BRIDGE_PORT }, 'Windows bridge server listening');
  }

  async stop(): Promise<void> {
    for (const [commandId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, summary: 'Cinder shut down before the Windows command completed.', errorCode: 'SHUTDOWN' });
      this.pending.delete(commandId);
    }
    this.bridge?.socket.close(1001, 'Cinder shutting down');
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  isReady(): boolean {
    return !this.config.BRIDGE_ENABLED || this.bridge?.socket.readyState === WebSocket.OPEN;
  }

  getState(): Record<string, unknown> {
    return {
      enabled: this.config.BRIDGE_ENABLED,
      connected: this.isReady(),
      bridgeId: this.bridge?.id,
      hostname: this.bridge?.hostname,
      capabilities: this.bridge?.capabilities ?? [],
      lastSeenAt: this.bridge ? new Date(this.bridge.lastSeenAt).toISOString() : undefined,
    };
  }

  async sendCommand(input: {
    action: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolExecutionResult> {
    if (!this.bridge || this.bridge.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, summary: 'The Windows bridge is not connected.', errorCode: 'BRIDGE_OFFLINE', retryable: true };
    }

    if (!this.bridge.capabilities.includes(input.action)) {
      return { ok: false, summary: `The Windows bridge does not advertise ${input.action}.`, errorCode: 'CAPABILITY_UNAVAILABLE' };
    }

    const command: BridgeCommand = {
      id: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.config.BRIDGE_COMMAND_TTL_SECONDS * 1000).toISOString(),
      action: input.action as BridgeCommand['action'],
      arguments: input.arguments,
    };

    return new Promise<ToolExecutionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolve({ ok: false, summary: 'The Windows command timed out without a result.', errorCode: 'BRIDGE_TIMEOUT', retryable: true });
      }, this.config.BRIDGE_COMMAND_TTL_SECONDS * 1000);
      this.pending.set(command.id, { resolve, timer });
      this.send(this.bridge!.socket, { type: 'command', command });
    });
  }

  private handleConnection(socket: WebSocket): void {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(4001, 'Authentication timed out'), 10_000);

    socket.on('message', (raw) => {
      let message: BridgeClientMessage;
      try {
        message = JSON.parse(raw.toString()) as BridgeClientMessage;
      } catch {
        socket.close(4002, 'Invalid JSON');
        return;
      }

      if (!authenticated) {
        if (message.type !== 'hello' || !safeTokenEqual(message.token, this.config.BRIDGE_TOKEN ?? '')) {
          socket.close(4003, 'Authentication failed');
          return;
        }
        clearTimeout(authTimer);
        authenticated = true;
        this.bridge?.socket.close(4004, 'A newer bridge connected');
        this.bridge = {
          id: message.bridgeId,
          socket,
          hostname: message.hostname,
          capabilities: message.capabilities,
          lastSeenAt: Date.now(),
        };
        this.send(socket, { type: 'welcome', serverTime: new Date().toISOString() });
        this.logger.info({ bridgeId: message.bridgeId, hostname: message.hostname }, 'Windows bridge connected');
        return;
      }

      if (this.bridge) this.bridge.lastSeenAt = Date.now();
      if (message.type === 'heartbeat') {
        this.send(socket, { type: 'heartbeat_ack', receivedAt: new Date().toISOString() });
      } else if (message.type === 'result') {
        this.handleResult(message.result);
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (this.bridge?.socket === socket) {
        this.logger.warn({ bridgeId: this.bridge.id }, 'Windows bridge disconnected');
        this.bridge = undefined;
      }
    });

    socket.on('error', (error) => this.logger.error({ err: error }, 'Windows bridge socket error'));
  }

  private handleResult(result: BridgeResult): void {
    const pending = this.pending.get(result.commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(result.commandId);
    pending.resolve({
      ok: result.ok,
      summary: result.summary,
      ...(result.data ? { data: result.data } : {}),
      ...(!result.ok ? { errorCode: 'WINDOWS_ACTION_FAILED' } : {}),
    });
  }

  private send(socket: WebSocket, message: BridgeServerMessage): void {
    socket.send(JSON.stringify(message));
  }
}
