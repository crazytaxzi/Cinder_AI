import 'dotenv/config';
import { hashDashboardPassword } from './admin/auth.js';
import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { Database } from './db/database.js';
import { DiscordAdapter } from './adapters/discord.js';
import { ToolRegistry } from './tools/registry.js';
import { CinderBrain } from './cinder/brain.js';

async function postInternal(path: string): Promise<unknown> {
  const config = loadConfig();
  const response = await fetch(`http://${config.HOST}:${config.PORT}${path}`, {
    method: 'POST',
    headers: {
      'x-cinder-control-token': config.CINDER_INTERNAL_CONTROL_TOKEN,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${text}`);
  }
  return body;
}


async function standaloneSelfTest(): Promise<unknown> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = new Database(config, logger);
  await database.initialize();
  const discord = new DiscordAdapter(config, logger, async () => undefined);
  const tools = new ToolRegistry(database, config, logger, discord);
  const brain = new CinderBrain(config, logger, tools, database);
  try {
    await brain.initialize();
    return await brain.startupSelfTest();
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'hash-password': {
      const password = args.join(' ');
      if (!password) throw new Error('Password is required.');
      process.stdout.write(`${hashDashboardPassword(password)}\n`);
      return;
    }
    case 'self-test':
      console.log(JSON.stringify(await postInternal('/internal/self-test'), null, 2));
      return;
    case 'self-test-standalone':
      console.log(JSON.stringify(await standaloneSelfTest(), null, 2));
      return;
    case 'verify-live': {
      const report = await postInternal('/internal/verify-live') as { ok?: boolean };
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case 'status': {
      const config = loadConfig();
      const response = await fetch(`http://${config.HOST}:${config.PORT}/health/ready`);
      console.log(await response.text());
      if (!response.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error('Usage: cinder-cli <hash-password|self-test|self-test-standalone|verify-live|status>');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
