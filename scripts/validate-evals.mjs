#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const scenarios = JSON.parse(await readFile(new URL('../config/behavior-evals.json', import.meta.url), 'utf8'));
if (!Array.isArray(scenarios) || scenarios.length < 20) throw new Error('Behavior evaluation suite is incomplete.');
const ids = new Set();
for (const item of scenarios) {
  if (!item || typeof item.id !== 'string' || !Array.isArray(item.scene) || typeof item.expected !== 'string') {
    throw new Error(`Invalid behavior scenario: ${JSON.stringify(item)}`);
  }
  if (ids.has(item.id)) throw new Error(`Duplicate behavior scenario: ${item.id}`);
  ids.add(item.id);
}
console.log(`${scenarios.length} behavioral contracts validated.`);
