import type { Scene } from '@cinder/shared';

export type ForcedDiscordTool = 'discord_join_voice' | 'discord_leave_voice' | 'discord_assign_role';

export function voiceControlToolForScene(scene: Scene): 'discord_join_voice' | 'discord_leave_voice' | undefined {
  if (scene.current.platform !== 'discord_text' && scene.current.platform !== 'discord_voice') return undefined;
  if (scene.current.metadata.verified !== true) return undefined;
  const text = scene.current.text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const leave = /\b(?:leave|exit|disconnect|drop|bounce)\b.{0,32}\b(?:voice|vc)\b/.test(text)
    || /\b(?:voice|vc)\b.{0,32}\b(?:leave|exit|disconnect)\b/.test(text)
    || (scene.current.platform === 'discord_voice' && /\b(?:you can|cinder|go ahead)\b.{0,24}\bleave\b/.test(text));
  if (leave) return 'discord_leave_voice';
  const join = /\b(?:join|enter|connect|hop|rejoin)\b.{0,40}\b(?:voice|vc|lobby)\b/.test(text)
    || /\b(?:voice|vc|lobby)\b.{0,40}\b(?:join|enter|connect|rejoin)\b/.test(text);
  return join ? 'discord_join_voice' : undefined;
}

export function forcedDiscordToolForScene(scene: Scene): ForcedDiscordTool | undefined {
  const voiceControl = voiceControlToolForScene(scene);
  if (voiceControl) return voiceControl;
  if (scene.current.platform !== 'discord_text' && scene.current.platform !== 'discord_voice') return undefined;
  if (scene.current.metadata.verified !== true) return undefined;
  const current = scene.current.text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const recent = scene.recentEvents
    .filter((event) => event.platform === scene.current.platform)
    .slice(-4)
    .map((event) => event.text.toLocaleLowerCase())
    .join(' ');
  const assignmentVerb = /\b(?:give|assign|add|remove|change)\b/.test(current);
  const roleContext = /\b(?:roles?|rules?|verified|chief bonk officer)\b/.test(`${current} ${recent}`);
  return assignmentVerb && roleContext ? 'discord_assign_role' : undefined;
}
