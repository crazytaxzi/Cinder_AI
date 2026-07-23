export const VOICE_RECEIVE_RECOVERY_COOLDOWN_MS = 15_000;
export const VOICE_RECEIVE_CORRUPT_PACKET_LIMIT = 3;

export interface VoiceReceiveRecoveryInput {
  corruptPackets: number;
  decodedBytes: number;
  lastRecoveryAt: number;
  now: number;
  cooldownMs?: number;
}

export function shouldRecoverVoiceReceive(input: VoiceReceiveRecoveryInput): boolean {
  const cooldownMs = input.cooldownMs ?? VOICE_RECEIVE_RECOVERY_COOLDOWN_MS;
  if (input.now - input.lastRecoveryAt < cooldownMs) return false;
  if (input.corruptPackets >= VOICE_RECEIVE_CORRUPT_PACKET_LIMIT) return true;
  return input.corruptPackets > 0 && input.decodedBytes === 0;
}
