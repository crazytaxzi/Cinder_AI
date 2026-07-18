import type { BridgeCommand, BridgeResult } from './types.js';

export type BridgeClientMessage =
  | { type: 'hello'; bridgeId: string; token: string; hostname: string; capabilities: string[] }
  | { type: 'result'; result: BridgeResult }
  | { type: 'heartbeat'; sentAt: string };

export type BridgeServerMessage =
  | { type: 'welcome'; serverTime: string }
  | { type: 'command'; command: BridgeCommand }
  | { type: 'error'; message: string }
  | { type: 'heartbeat_ack'; receivedAt: string };
