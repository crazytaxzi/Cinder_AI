import 'dotenv/config';
import { hostname } from 'node:os';
import pino from 'pino';
import WebSocket from 'ws';
import type { BridgeClientMessage, BridgeServerMessage } from '@cinder/shared';
import { WindowsActions } from './actions.js';
import { loadBridgeConfig } from './config.js';
import { TunnelManager } from './tunnel.js';

const config = loadBridgeConfig();
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'cinder-windows-bridge' } });
const actions = new WindowsActions(config);
const tunnel = new TunnelManager(config, logger);
tunnel.start();
let stopped = false;
let attempt = 0;
let heartbeat: NodeJS.Timeout | undefined;

function send(socket: WebSocket, message: BridgeClientMessage): void {
  socket.send(JSON.stringify(message));
}

function connect(): void {
  if (stopped) return;
  const socket = new WebSocket(config.CINDER_BRIDGE_URL);

  socket.on('open', () => {
    attempt = 0;
    send(socket, {
      type: 'hello',
      bridgeId: config.CINDER_BRIDGE_ID,
      token: config.CINDER_BRIDGE_TOKEN,
      hostname: hostname(),
      capabilities: actions.capabilities(),
    });
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) send(socket, { type: 'heartbeat', sentAt: new Date().toISOString() });
    }, 20_000);
  });

  socket.on('message', (raw) => {
    let message: BridgeServerMessage;
    try {
      message = JSON.parse(raw.toString()) as BridgeServerMessage;
    } catch {
      logger.warn('Ignored invalid bridge message');
      return;
    }
    if (message.type === 'welcome') {
      logger.info({ serverTime: message.serverTime }, 'Connected to Cinder core');
    } else if (message.type === 'command') {
      void actions.execute(message.command).then((result) => {
        if (socket.readyState === WebSocket.OPEN) send(socket, { type: 'result', result });
      });
    } else if (message.type === 'error') {
      logger.error({ message: message.message }, 'Cinder core reported a bridge error');
    }
  });

  socket.on('close', (code, reason) => {
    if (heartbeat) clearInterval(heartbeat);
    logger.warn({ code, reason: reason.toString() }, 'Bridge connection closed');
    if (!stopped) setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt++));
  });

  socket.on('error', (error) => logger.error({ err: error }, 'Bridge socket error'));
}

process.on('SIGINT', () => { stopped = true; tunnel.stop(); process.exit(0); });
process.on('SIGTERM', () => { stopped = true; tunnel.stop(); process.exit(0); });
connect();
