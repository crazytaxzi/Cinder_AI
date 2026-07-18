import { describe, expect, it } from 'vitest';
import { cleanCompactVoiceReply, isVoiceAcknowledgement, resetsVoiceContext, voiceCorrections } from '../src/voice/conversation.js';

describe('voice conversation controls', () => {
  it.each(['Mhm.', 'Hm', 'uh huh', 'Okay.', 'Gotcha'])('recognizes a pure acknowledgement: %s', (text) => {
    expect(isVoiceAcknowledgement(text)).toBe(true);
  });

  it('does not discard a meaningful sentence beginning with an acknowledgement', () => {
    expect(isVoiceAcknowledgement('Okay, next is his personality.')).toBe(false);
  });

  it('recognizes redirection and personality criticism as context resets', () => {
    expect(resetsVoiceContext('Focus on something else other than my sleep, please.')).toBe(true);
    expect(resetsVoiceContext("Cinder's personality is way off.")).toBe(true);
  });

  it('extracts corrections despite the observed Cinder/sender transcription ambiguity', () => {
    expect(voiceCorrections('The real sender never asks questions.')).toContain(
      'Do not ask questions unless essential to complete an explicit request.',
    );
    expect(voiceCorrections('No fucking emojis!')).toContain('Never use emoji.');
  });

  it('removes emoji and drops questions when the session forbids them', () => {
    expect(cleanCompactVoiceReply('Understood. What now? 😼', true)).toBe('Understood.');
  });
});
