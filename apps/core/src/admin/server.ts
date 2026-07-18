import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { EventEnvelope, GuildConfiguration, Scene } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { DiscordAdapter } from '../adapters/discord.js';
import type { TwitchAdapter } from '../adapters/twitch.js';
import type { BridgeServer } from '../adapters/bridge-server.js';
import type { CinderRuntime } from '../cinder/runtime.js';
import type { CinderBrain, CinderSelfTestResult } from '../cinder/brain.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SceneAssembler } from '../scene/assembler.js';
import { DashboardSessions, verifyDashboardPassword } from './auth.js';
import type { LiveVerifier, LiveVerificationReport } from '../verification/live.js';

const SESSION_COOKIE = 'cinder_session';

interface AuthenticatedRequest extends FastifyRequest {
  cinderSession?: {
    sub: string;
    csrf: string;
    exp: number;
  };
}

export class AdminServer {
  private readonly app: FastifyInstance;
  private readonly sessions: DashboardSessions;
  private lastSelfTest: CinderSelfTestResult | undefined;
  private lastLiveVerification: LiveVerificationReport | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly database: Database,
    private readonly discord: DiscordAdapter,
    private readonly runtime: CinderRuntime,
    private readonly brain: CinderBrain,
    private readonly tools: ToolRegistry,
    private readonly assembler: SceneAssembler,
    private readonly verifier: LiveVerifier,
    private readonly twitch?: TwitchAdapter,
    private readonly bridge?: BridgeServer,
  ) {
    this.app = Fastify({
      loggerInstance: logger,
      trustProxy: true,
      bodyLimit: 1_000_000,
    }) as unknown as FastifyInstance;
    this.sessions = new DashboardSessions(
      config.DASHBOARD_SESSION_SECRET,
      config.DASHBOARD_SESSION_TTL_HOURS,
    );
  }

  async start(): Promise<void> {
    await this.app.register(cookie);
    await this.app.register(rateLimit, {
      global: false,
      max: 10,
      timeWindow: '1 minute',
    });
    await this.app.register(fastifyStatic, {
      root: resolve(process.cwd(), 'dashboard'),
      prefix: '/assets/',
      decorateReply: true,
      wildcard: false,
    });
    this.routes();
    await this.app.listen({ host: this.config.HOST, port: this.config.PORT });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  setStartupSelfTest(result: CinderSelfTestResult): void {
    this.lastSelfTest = result;
  }

  private routes(): void {
    this.app.get('/health/live', async () => ({ status: 'alive' }));

    this.app.get('/health/ready', async (_request, reply) => {
      const database = await this.database.isReady();
      const discord = this.discord.isReady();
      const openai = this.lastSelfTest?.ok ?? !this.config.STARTUP_SELF_TEST;
      const ready = database && discord && openai;
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not-ready',
        components: {
          database,
          discord,
          openai,
          twitch: this.twitch?.isReady() ?? !this.config.TWITCH_ENABLED,
          windowsBridge: this.bridge?.isReady() ?? !this.config.BRIDGE_ENABLED,
          dashboard: true,
        },
        queueDepth: this.runtime.queueSize(),
        paused: this.runtime.isPaused(),
      });
    });

    this.app.get('/status', async () => this.publicStatus());
    this.app.get('/health/status', async () => this.publicStatus());

    this.app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    this.app.get('/login', async (_request, reply) => reply.sendFile('login.html'));
    this.app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

    this.app.post('/api/login', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const body = request.body as { password?: unknown } | undefined;
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!verifyDashboardPassword(password, this.config.DASHBOARD_ADMIN_PASSWORD_HASH)) {
        await this.database.recordDashboardAudit({
          actor: 'anonymous',
          action: 'login_failed',
          remoteAddress: request.ip,
        });
        return reply.code(401).send({ ok: false, error: 'Incorrect password.' });
      }
      const session = this.sessions.create('senti');
      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: this.isSecureRequest(request),
        path: '/',
        expires: new Date(session.expiresAt),
      });
      await this.database.recordDashboardAudit({
        actor: 'senti',
        action: 'login_succeeded',
        remoteAddress: request.ip,
      });
      return { ok: true, csrf: session.csrf, expiresAt: session.expiresAt };
    });

    this.app.get('/api/session', async (request, reply) => {
      const session = this.readSession(request);
      if (!session) return reply.code(401).send({ authenticated: false });
      return {
        authenticated: true,
        subject: session.sub,
        csrf: session.csrf,
        expiresAt: new Date(session.exp).toISOString(),
      };
    });

    this.app.post('/api/logout', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'logout',
        remoteAddress: request.ip,
      });
      return { ok: true };
    });

    this.app.get('/api/overview', async (request, reply) => {
      const session = this.requireAuth(request, reply);
      if (!session) return;
      return {
        status: await this.publicStatus(),
        stats: await this.database.dashboardStats(),
        usage: await this.database.dashboardUsage(),
        startupSelfTest: this.lastSelfTest,
        liveVerification: this.lastLiveVerification,
        runtime: {
          paused: this.runtime.isPaused(),
          pauseReason: this.runtime.getPauseReason(),
          queueDepth: this.runtime.queueSize(),
        },
      };
    });

    this.app.get('/api/events', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string; platform?: string };
      return this.database.dashboardEvents({
        limit: this.limit(query.limit, 100, 500),
        ...(query.platform ? { platform: query.platform } : {}),
        serverId: this.config.DISCORD_GUILD_ID,
      });
    });

    this.app.get('/api/actions', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string };
      return this.database.dashboardActions({
        limit: this.limit(query.limit, 100, 500),
        serverId: this.config.DISCORD_GUILD_ID,
      });
    });

    this.app.get('/api/approvals', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string; resolved?: string };
      return this.database.dashboardApprovals({
        limit: this.limit(query.limit, 100, 500),
        serverId: this.config.DISCORD_GUILD_ID,
        includeResolved: query.resolved === 'true',
      });
    });

    this.app.post('/api/approvals/:id/approve', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      return this.resolveApproval(request, session.sub, true);
    });

    this.app.post('/api/approvals/:id/deny', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      return this.resolveApproval(request, session.sub, false);
    });

    this.app.get('/api/failures', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string };
      return this.database.dashboardFailures(this.limit(query.limit, 100, 500));
    });

    this.app.post('/api/failures/:id/acknowledge', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const { id } = request.params as { id: string };
      const changed = await this.database.acknowledgeFailure(id);
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'failure_acknowledged',
        details: { id, changed },
        remoteAddress: request.ip,
      });
      return { ok: changed };
    });

    this.app.get('/api/memories', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string };
      return this.database.dashboardMemories({
        limit: this.limit(query.limit, 100, 500),
        serverId: this.config.DISCORD_GUILD_ID,
      });
    });

    this.app.delete('/api/memories/:id', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const { id } = request.params as { id: string };
      const deleted = await this.database.deleteMemory(id);
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'memory_deleted',
        details: { id, deleted },
        remoteAddress: request.ip,
      });
      return { ok: deleted };
    });

    this.app.get('/api/identities', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const query = request.query as { limit?: string };
      return this.database.dashboardIdentities(this.limit(query.limit, 100, 500));
    });

    this.app.post('/api/identities/link', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const body = request.body as Record<string, unknown>;
      const sourcePlatform = this.stringBody(body.sourcePlatform, 'sourcePlatform');
      const sourceUserId = this.stringBody(body.sourceUserId, 'sourceUserId');
      const targetPlatform = this.stringBody(body.targetPlatform, 'targetPlatform');
      const targetUserId = this.stringBody(body.targetUserId, 'targetUserId');
      const personId = await this.database.linkIdentities({
        sourcePlatform,
        sourceUserId,
        targetPlatform,
        targetUserId,
        verified: true,
      });
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'identities_linked',
        details: { sourcePlatform, sourceUserId, targetPlatform, targetUserId, personId },
        remoteAddress: request.ip,
      });
      return { ok: true, personId };
    });

    this.app.get('/api/config', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      return this.database.getGuildConfiguration(this.config.DISCORD_GUILD_ID);
    });

    this.app.get('/api/resources', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      const event = this.dashboardEvent('Load verified Discord resources for the dashboard.');
      const snapshot = await this.discord.getServerSnapshot(event) ?? {};
      return {
        guild: snapshot.guild ?? null,
        channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
        roles: Array.isArray(snapshot.roles) ? snapshot.roles : [],
      };
    });

    this.app.put('/api/config', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const current = await this.database.getGuildConfiguration(this.config.DISCORD_GUILD_ID);
      const body = request.body as Partial<GuildConfiguration>;
      const next: GuildConfiguration = {
        ...current,
        serverId: this.config.DISCORD_GUILD_ID,
        ...(typeof body.moderatorRoleName === 'string' && body.moderatorRoleName.trim()
          ? { moderatorRoleName: body.moderatorRoleName.trim() }
          : {}),
        ...(typeof body.voiceJoinRoleName === 'string' && body.voiceJoinRoleName.trim()
          ? { voiceJoinRoleName: body.voiceJoinRoleName.trim() }
          : {}),
        ...(typeof body.botAdminChannelId === 'string' && body.botAdminChannelId.trim()
          ? { botAdminChannelId: body.botAdminChannelId.trim() }
          : {}),
        ...(Array.isArray(body.quietChannelIds)
          ? { quietChannelIds: body.quietChannelIds.filter((value): value is string => typeof value === 'string') }
          : {}),
        ...(Array.isArray(body.memoryExcludedChannelIds)
          ? { memoryExcludedChannelIds: body.memoryExcludedChannelIds.filter((value): value is string => typeof value === 'string') }
          : {}),
      };
      const saved = await this.database.saveGuildConfiguration(next);
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'guild_configuration_updated',
        details: saved as unknown as Record<string, unknown>,
        remoteAddress: request.ip,
      });
      return saved;
    });

    this.app.post('/api/command', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const body = request.body as Record<string, unknown>;
      const text = this.stringBody(body.text, 'text');
      const result = await this.runtime.runDashboardCommand({
        text,
        ...(typeof body.channelId === 'string' && body.channelId ? { channelId: body.channelId } : {}),
        ...(typeof body.channelName === 'string' && body.channelName ? { channelName: body.channelName } : {}),
      });
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'dashboard_command',
        details: { text, turnId: result.turnId, toolCalls: result.toolCalls },
        remoteAddress: request.ip,
      });
      return result;
    });

    this.app.post('/api/control/pause', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      const body = request.body as { reason?: unknown } | undefined;
      const reason = typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Paused from the dashboard';
      this.runtime.pause(reason);
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'runtime_paused',
        details: { reason },
        remoteAddress: request.ip,
      });
      return { ok: true, paused: true, reason };
    });

    this.app.post('/api/control/resume', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      this.runtime.resume();
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'runtime_resumed',
        remoteAddress: request.ip,
      });
      return { ok: true, paused: false };
    });

    this.app.post('/api/control/restart', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'runtime_restart_requested',
        remoteAddress: request.ip,
      });
      reply.send({ ok: true, message: 'Cinder is restarting under systemd.' });
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref();
    });

    this.app.post('/api/self-test', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      this.lastSelfTest = await this.brain.startupSelfTest();
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'full_tool_self_test',
        details: this.lastSelfTest as unknown as Record<string, unknown>,
        remoteAddress: request.ip,
      });
      return this.lastSelfTest;
    });

    this.app.post('/api/verify-live', async (request, reply) => {
      const session = this.requireAuth(request, reply, true);
      if (!session) return;
      this.lastLiveVerification = await this.verifier.run();
      await this.database.recordDashboardAudit({
        actor: session.sub,
        action: 'live_verification',
        details: this.lastLiveVerification as unknown as Record<string, unknown>,
        remoteAddress: request.ip,
      });
      return this.lastLiveVerification;
    });

    this.app.post('/internal/self-test', async (request, reply) => {
      if (!this.internalAuthorized(request)) return reply.code(401).send({ ok: false });
      this.lastSelfTest = await this.brain.startupSelfTest();
      return this.lastSelfTest;
    });

    this.app.post('/internal/verify-live', async (request, reply) => {
      if (!this.internalAuthorized(request)) return reply.code(401).send({ ok: false });
      this.lastLiveVerification = await this.verifier.run();
      return this.lastLiveVerification;
    });

    this.app.get('/api/stream', async (request, reply) => {
      if (!this.requireAuth(request, reply)) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = async () => {
        try {
          const payload = {
            at: new Date().toISOString(),
            status: await this.publicStatus(),
            stats: await this.database.dashboardStats(),
            usage: await this.database.dashboardUsage(),
            runtime: {
              paused: this.runtime.isPaused(),
              pauseReason: this.runtime.getPauseReason(),
              queueDepth: this.runtime.queueSize(),
            },
          };
          reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch (error) {
          this.logger.warn({ err: error }, 'Dashboard SSE snapshot failed');
        }
      };
      await send();
      const timer = setInterval(() => void send(), 3000);
      request.raw.on('close', () => clearInterval(timer));
    });
  }

  private async publicStatus(): Promise<Record<string, unknown>> {
    return {
      name: 'Cinder',
      version: '2.0.0-native',
      hosting: 'native-systemd',
      oneMind: true,
      personality: 'Funny first. Useful second. Innuendo when the opening deserves it.',
      discordConnected: this.discord.isReady(),
      twitchConnected: this.twitch?.isReady() ?? false,
      bridge: this.bridge?.getState() ?? { enabled: false },
      queueDepth: this.runtime.queueSize(),
      paused: this.runtime.isPaused(),
      fullToolSelfTest: this.lastSelfTest?.ok ?? false,
    };
  }

  private readSession(request: FastifyRequest) {
    return this.sessions.verify(request.cookies[SESSION_COOKIE]);
  }

  private requireAuth(request: FastifyRequest, reply: FastifyReply, csrf = false) {
    const session = this.readSession(request);
    if (!session) {
      void reply.code(401).send({ ok: false, error: 'Authentication required.' });
      return undefined;
    }
    if (csrf) {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || header !== session.csrf) {
        void reply.code(403).send({ ok: false, error: 'CSRF token missing or invalid.' });
        return undefined;
      }
    }
    (request as AuthenticatedRequest).cinderSession = session;
    return session;
  }

  private internalAuthorized(request: FastifyRequest): boolean {
    const token = request.headers['x-cinder-control-token'];
    return typeof token === 'string' && token === this.config.CINDER_INTERNAL_CONTROL_TOKEN;
  }

  private isSecureRequest(request: FastifyRequest): boolean {
    return request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  }

  private limit(value: string | undefined, fallback: number, maximum: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, parsed));
  }

  private stringBody(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    return value.trim();
  }

  private async resolveApproval(request: FastifyRequest, actor: string, approved: boolean) {
    const { id } = request.params as { id: string };
    const body = request.body as { note?: unknown } | undefined;
    const approval = await this.database.getApproval(id);
    if (!approval) return { ok: false, summary: 'Approval not found.' };
    const event = this.dashboardEvent(
      approved ? `Approve pending action ${id}.` : `Deny pending action ${id}.`,
      approval.originChannelId,
    );
    const scene = await this.assembler.assemble(event);
    const result = await this.tools.resolveApprovalFromDashboard({
      approvalId: id,
      approved,
      ...(typeof body?.note === 'string' ? { note: body.note } : {}),
      context: {
        currentEvent: event,
        scene,
        cinderTurnId: `dashboard-approval:${randomUUID()}`,
      },
    });
    await this.database.recordDashboardAudit({
      actor,
      action: approved ? 'approval_approved' : 'approval_denied',
      details: { id, result },
      remoteAddress: request.ip,
    });
    await this.discord.sendMessage({
      serverId: approval.serverId,
      channelReference: approval.originChannelId,
      text: result.ok
        ? `${approved ? 'Approved' : 'Denied'} from the Cinder dashboard: ${result.summary}`
        : `Dashboard approval failed: ${result.summary}`,
    }).catch(() => undefined);
    return result;
  }

  private dashboardEvent(text: string, channelId?: string): EventEnvelope {
    return {
      id: `dashboard-event:${randomUUID()}`,
      platform: 'windows',
      occurredAt: new Date().toISOString(),
      serverId: this.config.DISCORD_GUILD_ID,
      ...(channelId ? { channelId } : {}),
      actor: {
        platform: 'windows',
        platformUserId: this.config.CINDER_OWNER_DISCORD_ID ?? 'dashboard-owner',
        displayName: 'Senti via dashboard',
        roles: [this.config.DEFAULT_MODERATOR_ROLE_NAME],
        isBot: false,
        isGuildOwner: true,
      },
      text,
      mentions: [],
      attachments: [],
      metadata: { verified: true, dashboard: true, directMention: true },
    };
  }
}
