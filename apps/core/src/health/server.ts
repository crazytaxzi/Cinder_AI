import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { DiscordAdapter } from '../adapters/discord.js';
import type { TwitchAdapter } from '../adapters/twitch.js';
import type { BridgeServer } from '../adapters/bridge-server.js';
import type { CinderRuntime } from '../cinder/runtime.js';

export class HealthServer {
  private readonly app: ReturnType<typeof Fastify>;

  constructor(
    private readonly config: Config,
    logger: Logger,
    private readonly database: Database,
    private readonly discord: DiscordAdapter,
    private readonly runtime: CinderRuntime,
    private readonly twitch?: TwitchAdapter,
    private readonly bridge?: BridgeServer,
  ) {
    this.app = Fastify({ loggerInstance: logger });
    this.routes();
  }

  async start(): Promise<void> {
    await this.app.listen({ host: this.config.HOST, port: this.config.PORT });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  private routes(): void {
    this.app.get('/health/live', async () => ({ status: 'alive' }));

    this.app.get('/health/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
      const database = await this.database.isReady();
      const discord = this.discord.isReady();
      const ready = database && discord;
      const body = {
        status: ready ? 'ready' : 'not-ready',
        components: {
          database,
          discord,
          twitch: this.twitch?.isReady() ?? !this.config.TWITCH_ENABLED,
          windowsBridge: this.bridge?.isReady() ?? !this.config.BRIDGE_ENABLED,
        },
        queueDepth: this.runtime.queueSize(),
      };
      return reply.code(ready ? 200 : 503).send(body);
    });

    const status = async () => ({
      name: 'Cinder',
      version: '1.0.1',
      oneMind: true,
      personality: 'Funny first. Useful second. Innuendo when the opening deserves it.',
      discordConnected: this.discord.isReady(),
      twitchConnected: this.twitch?.isReady() ?? false,
      bridge: this.bridge?.getState() ?? { enabled: false },
      queueDepth: this.runtime.queueSize(),
    });
    this.app.get('/status', status);
    this.app.get('/health/status', status);
  }
}
