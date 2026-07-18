export function isVoiceAcknowledgement(text: string): boolean {
  const normalized = text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:m+h+m*|h+m+|uh+ huh+|u+h+um+|mm+hmm+|yeah|yep|yup|okay|ok|right|indeed|gotcha|sure|fair|oh|ah|huh)$/.test(normalized);
}

export function voiceCorrections(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  const corrections: string[] = [];
  if (/\b(?:no|stop|don't|do not|never)\b.{0,24}\bemoji/.test(normalized)) corrections.push('Never use emoji.');
  if (/\b(?:stop|don't|do not|never)\b.{0,30}\b(?:ask|asking|question)/.test(normalized)
    || /\breal (?:cinder|sender) never asks questions\b/.test(normalized)) {
    corrections.push('Do not ask questions unless essential to complete an explicit request.');
  }
  return corrections;
}

export function resetsVoiceContext(text: string): boolean {
  const normalized = text.toLocaleLowerCase();
  return /\b(?:forget (?:about )?(?:that|it|the)|drop (?:that|it|the)|move on|change (?:the )?subject|focus on something else|stop (?:talking|asking)|you(?:'re| are) (?:still )?off|personality is (?:way )?off|that was weird)\b/.test(normalized);
}

export function cleanCompactVoiceReply(text: string, noQuestions: boolean): string {
  const withoutEmoji = text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '').replace(/\s+/g, ' ').trim();
  if (!noQuestions || !withoutEmoji.includes('?')) return withoutEmoji;
  const statements = withoutEmoji.match(/[^.!?]+[.!]/g)?.filter((part) => !part.includes('?')) ?? [];
  return statements.join(' ').trim();
}
