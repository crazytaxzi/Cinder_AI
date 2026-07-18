import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/cinder/instructions.js';

describe('Cinder instructions', () => {
  const instructions = buildInstructions('Funny first. Useful second.');

  it('defines one continuous Cinder', () => {
    expect(instructions).toContain('There is no second mind');
    expect(instructions).toContain('Tools are your hands');
  });

  it('requires contextual silence instead of a wake word', () => {
    expect(instructions).toContain('Every event reaches you without a wake-word filter');
    expect(instructions).toContain('Call stay_silent');
  });

  it('does not create an admin-channel prison', () => {
    expect(instructions).toContain('not a gate for ordinary administration or conversation');
  });

  it('keeps moderator eligibility inside Cinder judgment', () => {
    expect(instructions).toContain('Only perform it when the current requester holds the configured moderator role');
  });
});
