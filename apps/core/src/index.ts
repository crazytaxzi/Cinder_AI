import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { Database } from './db/database.js';
import { DiscordAdapter } from './adapters/discord.js';
import { TwitchAdapter } from './adapters/twitch.js';
import { BridgeServer } from './adapters/bridge-server.js';
import { PlatformAwareToolRegistry } from './tools/platform-aware-registry.js';
import { CinderBrain } from './cinder/brain.js';
import { TurnQueue } from './cinder/turn-queue.js';
import { CompositeStateProvider } from './scene/composite-state.js';
import { SceneAssembler } from './scene/assembler.js';
import { CinderRuntime } from './cinder/runtime.js';
import { AdminServer } from './admin/server.js';
import { LiveVerifier } from './verification/live.js';
import type { EventEnvelope } from '@cinder/shared';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = new Database(config, logger);
  await database.initialize();
  await database.pruneTransientData();

  const pruneTimer = setInterval(() => {
    void database.pruneTransientData().catch((error) => logger.error({ err: error }, 'Scheduled data pruning failed'));
  }, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  let eventSink: (event: EventEnvelope) => Promise<void> = async () => {
    throw new Error('Cinder received an event before the cognitive runtime was ready.');
  };

  const discord = new DiscordAdapter(config, logger, (event) => eventSink(event), database);
  const twitch = config.TWITCH_ENABLED
    ? new TwitchAdapter(config, logger, database, (event) => eventSink(event))
    : undefined;
  const bridge = config.BRIDGE_ENABLED ? new BridgeServer(config, logger) : undefined;
  const tools = new PlatformAwareToolRegistry(database, config, logger, discord, twitch, bridge);
  const brain = new CinderBrain(config, logger, tools, database);
  await brain.initialize();

  const startupSelfTest = config.STARTUP_SELF_TEST
    ? await brain.startupSelfTest()
    : undefined;

  const queue = new TurnQueue(logger);
  const states = new CompositeStateProvider(discord, twitch, bridge);
  const assembler = new SceneAssembler(database, config, logger, states);
  const runtime = new CinderRuntime(config, logger, database, assembler, brain, queue, discord, twitch);
  eventSink = (event) => runtime.ingest(event);
  const verifier = new LiveVerifier(config, logger, database, discord, runtime, brain, assembler, twitch);
  const admin = new AdminServer(
    config,
    logger,
    database,
    discord,
    runtime,
    brain,
    tools,
    assembler,
    verifier,
    twitch,
    bridge,
  );
  if (startupSelfTest) admin.setStartupSelfTest(startupSelfTest);

  await bridge?.start();
  await discord.start();
  await twitch?.start();
  await admin.start();

  logger.info({
    hosting: 'native-systemd',
    discord: discord.isReady(),
    twitch: twitch?.isReady() ?? false,
    bridge: bridge?.isReady() ?? false,
    dashboard: config.DASHBOARD_ENABLED,
    model: config.OPENAI_MODEL,
    startupSelfTest: startupSelfTest?.ok ?? false,
    toolCount: tools.toolNames().length,
  }, 'Cinder is awake');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.stopAcceptingEvents();
    clearInterval(pruneTimer);
    logger.info({ signal }, 'Cinder is shutting down');
    const results = await Promise.allSettled([
      admin.stop(),
      twitch?.stop(),
      discord.stop(),
      bridge?.stop(),
      database.close(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logger.error({ err: result.reason }, 'Shutdown component failed');
    }
    process.exit(results.some((result) => result.status === 'rejected') ? 1 : 0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (error) => {
    logger.fatal({ err: error }, 'Unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((error) => {
  console.error('Cinder failed to start:', error);
  process.exit(1);
});
