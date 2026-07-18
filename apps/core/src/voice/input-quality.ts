const PROMPT_LEAKAGE = [
  'discord voice conversation',
  'cinder is a participant',
  'participant names may include',
];

export function sanitizeVoiceTranscript(value: string): string | undefined {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || !/[a-z0-9]/i.test(text)) return undefined;
  const normalized = text.toLocaleLowerCase();
  if (PROMPT_LEAKAGE.some((phrase) => normalized.includes(phrase))) return undefined;
  if (/^\[(?:blank[ _-]?audio|silence|no speech|inaudible|music|laughter)\][.!]?$/i.test(text)) return undefined;
  if (/^\((?:silence|inaudible|laughs?|laughter|whoosh|music|background noise)\)[.!]?$/i.test(text)) return undefined;
  return text;
}

export function pcmHasSpeechEnergy(pcm: Buffer): boolean {
  // Reject sub-half-second receiver fragments before paying for STT. Short
  // acknowledgements still clear this boundary; Discord/Opus noise bursts do not.
  if (pcm.length < 48_000 * 2 * 2 * 0.45) return false;
  let squareSum = 0;
  let peak = 0;
  let active = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = Math.abs(pcm.readInt16LE(offset));
    squareSum += sample * sample;
    peak = Math.max(peak, sample);
    if (sample >= 500) active += 1;
  }
  const rms = Math.sqrt(squareSum / samples);
  return peak >= 650 && rms >= 90 && active / samples >= 0.002;
}

export function isUsableVoiceText(value: string): boolean {
  return sanitizeVoiceTranscript(value) !== undefined;
}
