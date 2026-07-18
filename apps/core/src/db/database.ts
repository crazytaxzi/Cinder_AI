import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  ActionRecord,
  ActorIdentity,
  AudienceScope,
  EventEnvelope,
  GuildConfiguration,
  MemoryRecord,
  PendingApproval,
  ToolExecutionResult,
} from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { runMigrations } from './migrate.js';

const { Pool } = pg;

type JsonObject = Record<string, unknown>;

export class Database {
  readonly pool: pg.Pool;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      max: 15,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    this.pool.on('error', (error) => {
      this.logger.error({ err: error }, 'Unexpected PostgreSQL pool error');
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    await runMigrations(this.pool, this.config.MIGRATIONS_DIR, this.logger);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async storeEvent(event: EventEnvelope): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO events(id, platform, occurred_at, server_id, channel_id, actor, text, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.platform,
        event.occurredAt,
        event.serverId ?? null,
        event.channelId ?? null,
        JSON.stringify(event.actor),
        event.text,
        JSON.stringify(event),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recentEvents(input: {
    serverId?: string;
    channelId?: string;
    limit: number;
  }): Promise<EventEnvelope[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (input.serverId) {
      values.push(input.serverId);
      clauses.push(`server_id = $${values.length}`);
    }
    if (input.channelId) {
      values.push(input.channelId);
      clauses.push(`channel_id = $${values.length}`);
    }
    values.push(input.limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{ payload: EventEnvelope }>(
      `SELECT payload
       FROM events
       ${where}
       ORDER BY occurred_at DESC
       LIMIT $${values.length}`,
      values,
    );

    return result.rows.map((row) => row.payload).reverse();
  }

  async searchDiscordMessages(input: {
    serverId: string;
    query?: string;
    channelId?: string;
    authorReference?: string;
    limit: number;
  }): Promise<EventEnvelope[]> {
    const values: unknown[] = [input.serverId];
    const clauses = [`server_id = $1`, `platform = 'discord_text'`, `id LIKE 'discord-message:%'`];
    if (input.channelId) {
      values.push(input.channelId);
      clauses.push(`channel_id = $${values.length}`);
    }
    if (input.query) {
      values.push(`%${input.query}%`);
      clauses.push(`text ILIKE $${values.length}`);
    }
    if (input.authorReference) {
      values.push(input.authorReference);
      clauses.push(`(actor->>'platformUserId' = $${values.length} OR actor->>'displayName' ILIKE '%' || $${values.length} || '%' OR actor->>'username' ILIKE '%' || $${values.length} || '%')`);
    }
    values.push(input.limit);
    const result = await this.pool.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.payload);
  }

  async ensureIdentity(actor: ActorIdentity): Promise<string> {
    const existing = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM identities WHERE platform = $1 AND platform_user_id = $2`,
      [actor.platform, actor.platformUserId],
    );

    if (existing.rows[0]) {
      await this.pool.query(
        `UPDATE identities
         SET display_name = $3, username = $4, updated_at = NOW()
         WHERE platform = $1 AND platform_user_id = $2`,
        [actor.platform, actor.platformUserId, actor.displayName, actor.username ?? null],
      );
      return existing.rows[0].person_id;
    }

    const personId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO people(id, preferred_name) VALUES ($1, $2)`,
        [personId, actor.displayName],
      );
      await client.query(
        `INSERT INTO identities(platform, platform_user_id, person_id, display_name, username)
         VALUES ($1,$2,$3,$4,$5)`,
        [actor.platform, actor.platformUserId, personId, actor.displayName, actor.username ?? null],
      );
      await client.query('COMMIT');
      return personId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async linkIdentities(input: {
    sourcePlatform: string;
    sourceUserId: string;
    targetPlatform: string;
    targetUserId: string;
    verified: boolean;
  }): Promise<string> {
    const source = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM identities WHERE platform = $1 AND platform_user_id = $2`,
      [input.sourcePlatform, input.sourceUserId],
    );
    const target = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM identities WHERE platform = $1 AND platform_user_id = $2`,
      [input.targetPlatform, input.targetUserId],
    );
    if (!source.rows[0] || !target.rows[0]) {
      throw new Error('Both identities must exist before they can be linked.');
    }

    const sourcePersonId = source.rows[0].person_id;
    const targetPersonId = target.rows[0].person_id;
    if (sourcePersonId === targetPersonId) return sourcePersonId;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE identities SET person_id = $1, verified = $2, updated_at = NOW()
         WHERE person_id = $3`,
        [sourcePersonId, input.verified, targetPersonId],
      );
      await client.query(
        `UPDATE memories SET person_id = $1, updated_at = NOW() WHERE person_id = $2`,
        [sourcePersonId, targetPersonId],
      );
      await client.query('DELETE FROM people WHERE id = $1', [targetPersonId]);
      await client.query('COMMIT');
      return sourcePersonId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPersonId(platform: string, platformUserId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM identities WHERE platform = $1 AND platform_user_id = $2`,
      [platform, platformUserId],
    );
    return result.rows[0]?.person_id;
  }

  async resolveIdentity(platform: string, reference: string): Promise<{
    platformUserId: string;
    personId: string;
    displayName: string;
    username?: string;
  } | undefined> {
    const trimmed = reference.trim();
    const exact = await this.pool.query<{
      platform_user_id: string;
      person_id: string;
      display_name: string;
      username: string | null;
    }>(
      `SELECT platform_user_id, person_id, display_name, username
       FROM identities
       WHERE platform = $1
         AND (
           platform_user_id = $2
           OR LOWER(display_name) = LOWER($2)
           OR LOWER(COALESCE(username, '')) = LOWER($2)
         )
       ORDER BY updated_at DESC
       LIMIT 2`,
      [platform, trimmed],
    );
    if (exact.rows.length === 1) {
      const row = exact.rows[0]!;
      return {
        platformUserId: row.platform_user_id,
        personId: row.person_id,
        displayName: row.display_name,
        ...(row.username ? { username: row.username } : {}),
      };
    }
    if (exact.rows.length > 1) return undefined;

    const partial = await this.pool.query<{
      platform_user_id: string;
      person_id: string;
      display_name: string;
      username: string | null;
    }>(
      `SELECT platform_user_id, person_id, display_name, username
       FROM identities
       WHERE platform = $1
         AND (display_name ILIKE $2 OR COALESCE(username, '') ILIKE $2)
       ORDER BY updated_at DESC
       LIMIT 2`,
      [platform, `%${trimmed}%`],
    );
    if (partial.rows.length !== 1) return undefined;
    const row = partial.rows[0]!;
    return {
      platformUserId: row.platform_user_id,
      personId: row.person_id,
      displayName: row.display_name,
      ...(row.username ? { username: row.username } : {}),
    };
  }

  async getRelevantMemories(input: {
    personId?: string;
    serverId?: string;
    allowedScopes: AudienceScope[];
    limit: number;
  }): Promise<MemoryRecord[]> {
    const result = await this.pool.query<{
      id: string;
      person_id: string | null;
      server_id: string | null;
      scope: AudienceScope;
      kind: MemoryRecord['kind'];
      content: string;
      importance: number;
      created_at: Date;
      updated_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT * FROM memories
       WHERE (expires_at IS NULL OR expires_at > NOW())
         AND scope = ANY($1::text[])
         AND ($2::text IS NULL OR person_id = $2 OR person_id IS NULL)
         AND ($3::text IS NULL OR server_id = $3 OR server_id IS NULL)
       ORDER BY importance DESC, updated_at DESC
       LIMIT $4`,
      [input.allowedScopes, input.personId ?? null, input.serverId ?? null, input.limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      ...(row.server_id ? { serverId: row.server_id } : {}),
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    }));
  }

  async saveMemory(input: {
    personId?: string;
    serverId?: string;
    scope: AudienceScope;
    kind: MemoryRecord['kind'];
    content: string;
    importance: number;
    expiresAt?: string;
  }): Promise<MemoryRecord> {
    const id = randomUUID();
    const result = await this.pool.query<{
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO memories(id, person_id, server_id, scope, kind, content, importance, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING created_at, updated_at`,
      [
        id,
        input.personId ?? null,
        input.serverId ?? null,
        input.scope,
        input.kind,
        input.content,
        input.importance,
        input.expiresAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Memory insert returned no row.');

    return {
      id,
      ...(input.personId ? { personId: input.personId } : {}),
      ...(input.serverId ? { serverId: input.serverId } : {}),
      scope: input.scope,
      kind: input.kind,
      content: input.content,
      importance: input.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM memories WHERE id = $1', [memoryId]);
    return (result.rowCount ?? 0) > 0;
  }

  async getGuildConfiguration(serverId: string): Promise<GuildConfiguration> {
    const result = await this.pool.query<{ config: GuildConfiguration }>(
      'SELECT config FROM guild_settings WHERE server_id = $1',
      [serverId],
    );

    return result.rows[0]?.config ?? {
      serverId,
      moderatorRoleName: this.config.DEFAULT_MODERATOR_ROLE_NAME,
      voiceJoinRoleName: this.config.DEFAULT_VOICE_JOIN_ROLE_NAME,
      quietChannelIds: [],
      memoryExcludedChannelIds: [],
      ...(this.config.CINDER_OWNER_DISCORD_ID
        ? { ownerDiscordUserId: this.config.CINDER_OWNER_DISCORD_ID }
        : {}),
      ...(this.config.TWITCH_BROADCASTER_ID
        ? { twitchBroadcasterId: this.config.TWITCH_BROADCASTER_ID }
        : {}),
      ...(this.config.TWITCH_BOT_USER_ID
        ? { twitchBotUserId: this.config.TWITCH_BOT_USER_ID }
        : {}),
    };
  }

  async saveGuildConfiguration(config: GuildConfiguration): Promise<GuildConfiguration> {
    await this.pool.query(
      `INSERT INTO guild_settings(server_id, config)
       VALUES ($1,$2)
       ON CONFLICT (server_id)
       DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [config.serverId, JSON.stringify(config)],
    );
    return config;
  }

  async getPendingApprovals(serverId: string): Promise<PendingApproval[]> {
    const result = await this.pool.query<{
      id: string;
      server_id: string;
      requested_by_platform_user_id: string;
      requested_by_name: string;
      created_at: Date;
      expires_at: Date;
      description: string;
      tool_name: string;
      tool_arguments: JsonObject;
      origin_channel_id: string;
      approval_channel_id: string | null;
    }>(
      `SELECT * FROM pending_approvals
       WHERE server_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [serverId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      requestedByPlatformUserId: row.requested_by_platform_user_id,
      requestedByName: row.requested_by_name,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      description: row.description,
      toolName: row.tool_name,
      toolArguments: row.tool_arguments,
      originChannelId: row.origin_channel_id,
      ...(row.approval_channel_id ? { approvalChannelId: row.approval_channel_id } : {}),
    }));
  }

  async createApproval(input: Omit<PendingApproval, 'id' | 'createdAt' | 'expiresAt'> & {
    ttlMinutes: number;
  }): Promise<PendingApproval> {
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.ttlMinutes * 60_000);

    await this.pool.query(
      `INSERT INTO pending_approvals(
         id, server_id, requested_by_platform_user_id, requested_by_name,
         created_at, expires_at, description, tool_name, tool_arguments,
         origin_channel_id, approval_channel_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.serverId,
        input.requestedByPlatformUserId,
        input.requestedByName,
        createdAt,
        expiresAt,
        input.description,
        input.toolName,
        JSON.stringify(input.toolArguments),
        input.originChannelId,
        input.approvalChannelId ?? null,
      ],
    );

    return {
      id,
      serverId: input.serverId,
      requestedByPlatformUserId: input.requestedByPlatformUserId,
      requestedByName: input.requestedByName,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      description: input.description,
      toolName: input.toolName,
      toolArguments: input.toolArguments,
      originChannelId: input.originChannelId,
      ...(input.approvalChannelId ? { approvalChannelId: input.approvalChannelId } : {}),
    };
  }

  async resolveApproval(input: {
    id: string;
    status: 'approved' | 'denied' | 'cancelled' | 'executed';
    resolvedByPlatformUserId: string;
    note?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pending_approvals
       SET status = $2, resolved_by_platform_user_id = $3, resolved_at = NOW(), resolution_note = $4
       WHERE id = $1 AND status = 'pending'`,
      [input.id, input.status, input.resolvedByPlatformUserId, input.note ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getApproval(id: string): Promise<(PendingApproval & { status: string }) | undefined> {
    const result = await this.pool.query<{
      id: string;
      server_id: string;
      requested_by_platform_user_id: string;
      requested_by_name: string;
      created_at: Date;
      expires_at: Date;
      description: string;
      tool_name: string;
      tool_arguments: JsonObject;
      origin_channel_id: string;
      approval_channel_id: string | null;
      status: string;
    }>('SELECT * FROM pending_approvals WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      serverId: row.server_id,
      requestedByPlatformUserId: row.requested_by_platform_user_id,
      requestedByName: row.requested_by_name,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      description: row.description,
      toolName: row.tool_name,
      toolArguments: row.tool_arguments,
      originChannelId: row.origin_channel_id,
      ...(row.approval_channel_id ? { approvalChannelId: row.approval_channel_id } : {}),
      status: row.status,
    };
  }

  async recentActions(input: {
    serverId: string;
    limit: number;
  }): Promise<ActionRecord[]> {
    const result = await this.pool.query<{
      id: string;
      turn_id: string;
      event_id: string;
      server_id: string | null;
      actor_platform_user_id: string | null;
      tool_name: string;
      tool_arguments: JsonObject;
      result: ToolExecutionResult;
      created_at: Date;
    }>(
      `SELECT id, turn_id, event_id, server_id, actor_platform_user_id,
              tool_name, tool_arguments, result, created_at
       FROM actions
       WHERE server_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [input.serverId, input.limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      eventId: row.event_id,
      ...(row.server_id ? { serverId: row.server_id } : {}),
      ...(row.actor_platform_user_id
        ? { actorPlatformUserId: row.actor_platform_user_id }
        : {}),
      toolName: row.tool_name,
      toolArguments: row.tool_arguments,
      result: row.result,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async recordAction(input: {
    turnId: string;
    eventId: string;
    serverId?: string;
    actorPlatformUserId?: string;
    toolName: string;
    toolArguments: JsonObject;
    result: ToolExecutionResult;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO actions(id, turn_id, event_id, server_id, actor_platform_user_id, tool_name, tool_arguments, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        input.turnId,
        input.eventId,
        input.serverId ?? null,
        input.actorPlatformUserId ?? null,
        input.toolName,
        JSON.stringify(input.toolArguments),
        JSON.stringify(input.result),
      ],
    );
  }

  async markExternalEventProcessed(source: string, externalId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO processed_external_events(source, external_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [source, externalId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setRuntimeState(key: string, value: JsonObject): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_state(key, value)
       VALUES ($1,$2)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async getRuntimeState<T extends JsonObject>(key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ value: T }>(
      'SELECT value FROM runtime_state WHERE key = $1',
      [key],
    );
    return result.rows[0]?.value;
  }

  async dashboardEvents(input: {
    limit: number;
    platform?: string;
    serverId?: string;
  }): Promise<EventEnvelope[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.platform) {
      values.push(input.platform);
      clauses.push(`platform = $${values.length}`);
    }
    if (input.serverId) {
      values.push(input.serverId);
      clauses.push(`server_id = $${values.length}`);
    }
    values.push(input.limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM events ${where} ORDER BY occurred_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.payload);
  }

  async dashboardActions(input: {
    limit: number;
    serverId?: string;
  }): Promise<ActionRecord[]> {
    const values: unknown[] = [];
    let where = '';
    if (input.serverId) {
      values.push(input.serverId);
      where = `WHERE server_id = $${values.length}`;
    }
    values.push(input.limit);
    const result = await this.pool.query<{
      id: string;
      turn_id: string;
      event_id: string;
      server_id: string | null;
      actor_platform_user_id: string | null;
      tool_name: string;
      tool_arguments: JsonObject;
      result: ToolExecutionResult;
      created_at: Date;
    }>(
      `SELECT id, turn_id, event_id, server_id, actor_platform_user_id,
              tool_name, tool_arguments, result, created_at
       FROM actions ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      eventId: row.event_id,
      ...(row.server_id ? { serverId: row.server_id } : {}),
      ...(row.actor_platform_user_id ? { actorPlatformUserId: row.actor_platform_user_id } : {}),
      toolName: row.tool_name,
      toolArguments: row.tool_arguments,
      result: row.result,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async dashboardApprovals(input: {
    limit: number;
    serverId?: string;
    includeResolved?: boolean;
  }): Promise<Array<PendingApproval & { status: string; resolvedAt?: string; resolutionNote?: string }>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.serverId) {
      values.push(input.serverId);
      clauses.push(`server_id = $${values.length}`);
    }
    if (!input.includeResolved) clauses.push(`status = 'pending'`);
    values.push(input.limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{
      id: string;
      server_id: string;
      requested_by_platform_user_id: string;
      requested_by_name: string;
      created_at: Date;
      expires_at: Date;
      description: string;
      tool_name: string;
      tool_arguments: JsonObject;
      origin_channel_id: string;
      approval_channel_id: string | null;
      status: string;
      resolved_at: Date | null;
      resolution_note: string | null;
    }>(`SELECT * FROM pending_approvals ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      requestedByPlatformUserId: row.requested_by_platform_user_id,
      requestedByName: row.requested_by_name,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      description: row.description,
      toolName: row.tool_name,
      toolArguments: row.tool_arguments,
      originChannelId: row.origin_channel_id,
      ...(row.approval_channel_id ? { approvalChannelId: row.approval_channel_id } : {}),
      status: row.status,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
      ...(row.resolution_note ? { resolutionNote: row.resolution_note } : {}),
    }));
  }

  async dashboardMemories(input: { limit: number; serverId?: string }): Promise<MemoryRecord[]> {
    const values: unknown[] = [];
    let where = '';
    if (input.serverId) {
      values.push(input.serverId);
      where = `WHERE server_id = $${values.length} OR server_id IS NULL`;
    }
    values.push(input.limit);
    const result = await this.pool.query<{
      id: string;
      person_id: string | null;
      server_id: string | null;
      scope: AudienceScope;
      kind: MemoryRecord['kind'];
      content: string;
      importance: number;
      created_at: Date;
      updated_at: Date;
      expires_at: Date | null;
    }>(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
    return result.rows.map((row) => ({
      id: row.id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      ...(row.server_id ? { serverId: row.server_id } : {}),
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    }));
  }

  async dashboardIdentities(limit: number): Promise<Array<{
    platform: string;
    platformUserId: string;
    personId: string;
    displayName: string;
    username?: string;
    verified: boolean;
    updatedAt: string;
  }>> {
    const result = await this.pool.query<{
      platform: string;
      platform_user_id: string;
      person_id: string;
      display_name: string;
      username: string | null;
      verified: boolean;
      updated_at: Date;
    }>(
      `SELECT platform, platform_user_id, person_id, display_name, username, verified, updated_at
       FROM identities ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      platform: row.platform,
      platformUserId: row.platform_user_id,
      personId: row.person_id,
      displayName: row.display_name,
      ...(row.username ? { username: row.username } : {}),
      verified: row.verified,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async recordTurnFailure(input: {
    id: string;
    event: EventEnvelope;
    error: Error;
    requestId?: string;
    code?: string;
    status?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO turn_failures(
         id, event_id, platform, server_id, channel_id, actor_platform_user_id,
         error_name, error_message, error_stack, request_id, error_code, http_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.id,
        input.event.id,
        input.event.platform,
        input.event.serverId ?? null,
        input.event.channelId ?? null,
        input.event.actor.platformUserId,
        input.error.name,
        input.error.message,
        input.error.stack ?? null,
        input.requestId ?? null,
        input.code ?? null,
        input.status ?? null,
      ],
    );
  }

  async dashboardFailures(limit: number): Promise<Array<{
    id: string;
    eventId: string;
    platform: string;
    serverId?: string;
    channelId?: string;
    actorPlatformUserId?: string;
    errorName: string;
    errorMessage: string;
    errorStack?: string;
    requestId?: string;
    errorCode?: string;
    httpStatus?: number;
    createdAt: string;
    acknowledgedAt?: string;
  }>> {
    const result = await this.pool.query<{
      id: string;
      event_id: string;
      platform: string;
      server_id: string | null;
      channel_id: string | null;
      actor_platform_user_id: string | null;
      error_name: string;
      error_message: string;
      error_stack: string | null;
      request_id: string | null;
      error_code: string | null;
      http_status: number | null;
      created_at: Date;
      acknowledged_at: Date | null;
    }>('SELECT * FROM turn_failures ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      platform: row.platform,
      ...(row.server_id ? { serverId: row.server_id } : {}),
      ...(row.channel_id ? { channelId: row.channel_id } : {}),
      ...(row.actor_platform_user_id ? { actorPlatformUserId: row.actor_platform_user_id } : {}),
      errorName: row.error_name,
      errorMessage: row.error_message,
      ...(row.error_stack ? { errorStack: row.error_stack } : {}),
      ...(row.request_id ? { requestId: row.request_id } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.http_status !== null ? { httpStatus: row.http_status } : {}),
      createdAt: row.created_at.toISOString(),
      ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at.toISOString() } : {}),
    }));
  }

  async acknowledgeFailure(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE turn_failures SET acknowledged_at = NOW() WHERE id = $1 AND acknowledged_at IS NULL',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordDashboardAudit(input: {
    actor: string;
    action: string;
    details?: JsonObject;
    remoteAddress?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO dashboard_audit(id, actor, action, details, remote_address)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), input.actor, input.action, JSON.stringify(input.details ?? {}), input.remoteAddress ?? null],
    );
  }

  async dashboardStats(): Promise<Record<string, number>> {
    const result = await this.pool.query<{
      events: string;
      actions: string;
      approvals: string;
      memories: string;
      identities: string;
      failures: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM events)::text AS events,
        (SELECT COUNT(*) FROM actions)::text AS actions,
        (SELECT COUNT(*) FROM pending_approvals WHERE status = 'pending')::text AS approvals,
        (SELECT COUNT(*) FROM memories)::text AS memories,
        (SELECT COUNT(*) FROM identities)::text AS identities,
        (SELECT COUNT(*) FROM turn_failures WHERE acknowledged_at IS NULL)::text AS failures
    `);
    const row = result.rows[0];
    return {
      events: Number(row?.events ?? 0),
      actions: Number(row?.actions ?? 0),
      approvals: Number(row?.approvals ?? 0),
      memories: Number(row?.memories ?? 0),
      identities: Number(row?.identities ?? 0),
      failures: Number(row?.failures ?? 0),
    };
  }

  async recordModelUsage(input: {
    turnId: string;
    requestId?: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }): Promise<void> {
    const nano = input.model.startsWith('gpt-5.4-nano');
    const mini = input.model.startsWith('gpt-5.4-mini');
    const full = input.model.startsWith('gpt-5.4');
    const prices = nano
      ? { input: 0.2, cached: 0.02, output: 1.25 }
      : mini
      ? { input: 0.75, cached: 0.075, output: 4.5 }
      : full
        ? { input: 2.5, cached: 0.25, output: 15 }
        : { input: 0, cached: 0, output: 0 };
    const cached = Math.min(input.cachedInputTokens, input.inputTokens);
    const uncached = input.inputTokens - cached;
    const cost = (uncached * prices.input + cached * prices.cached + input.outputTokens * prices.output) / 1_000_000;
    await this.pool.query(
      `INSERT INTO model_usage(
         id, turn_id, request_id, model, input_tokens, cached_input_tokens,
         output_tokens, reasoning_tokens, input_usd_per_million,
         cached_input_usd_per_million, output_usd_per_million, estimated_cost_usd
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), input.turnId, input.requestId ?? null, input.model, input.inputTokens,
       cached, input.outputTokens, input.reasoningTokens, prices.input, prices.cached, prices.output, cost],
    );
  }

  async recordAudioUsage(input: {
    model: string;
    durationSeconds: number;
    estimatedCostUsd: number;
    platform: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audio_usage(id, model, platform, duration_seconds, estimated_cost_usd)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), input.model, input.platform, input.durationSeconds, input.estimatedCostUsd],
    );
  }

  async dashboardUsage(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      period: string; requests: string; input_tokens: string; cached_input_tokens: string;
      output_tokens: string; reasoning_tokens: string; estimated_cost_usd: string;
    }>(`
      SELECT periods.period,
             COUNT(u.id)::text AS requests,
             COALESCE(SUM(u.input_tokens), 0)::text AS input_tokens,
             COALESCE(SUM(u.cached_input_tokens), 0)::text AS cached_input_tokens,
             COALESCE(SUM(u.output_tokens), 0)::text AS output_tokens,
             COALESCE(SUM(u.reasoning_tokens), 0)::text AS reasoning_tokens,
             COALESCE(SUM(u.estimated_cost_usd), 0)::text AS estimated_cost_usd
      FROM (VALUES ('today', CURRENT_DATE::timestamptz),
                   ('sevenDays', NOW() - INTERVAL '7 days'),
                   ('thirtyDays', NOW() - INTERVAL '30 days'),
                   ('allTime', '-infinity'::timestamptz)) AS periods(period, since)
      LEFT JOIN model_usage u ON u.occurred_at >= periods.since
      GROUP BY periods.period
    `);
    const audio = await this.pool.query<{
      period: string; duration_seconds: string; estimated_cost_usd: string;
      transcription_cost_usd: string; tts_cost_usd: string;
    }>(`
      SELECT periods.period,
             COALESCE(SUM(a.duration_seconds), 0)::text AS duration_seconds,
             COALESCE(SUM(a.estimated_cost_usd), 0)::text AS estimated_cost_usd,
             COALESCE(SUM(a.estimated_cost_usd) FILTER (WHERE a.platform = 'discord_voice'), 0)::text AS transcription_cost_usd,
             COALESCE(SUM(a.estimated_cost_usd) FILTER (WHERE a.platform = 'discord_voice_tts'), 0)::text AS tts_cost_usd
      FROM (VALUES ('today', CURRENT_DATE::timestamptz),
                   ('sevenDays', NOW() - INTERVAL '7 days'),
                   ('thirtyDays', NOW() - INTERVAL '30 days'),
                   ('allTime', '-infinity'::timestamptz)) AS periods(period, since)
      LEFT JOIN audio_usage a ON a.occurred_at >= periods.since
      GROUP BY periods.period
    `);
    const modelBreakdown = await this.pool.query<{
      model: string; requests: string; input_tokens: string; cached_input_tokens: string;
      output_tokens: string; estimated_cost_usd: string;
    }>(`
      SELECT model, COUNT(*)::text AS requests,
             COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0)::text AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
             COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd
      FROM model_usage GROUP BY model ORDER BY SUM(estimated_cost_usd) DESC
    `);
    const audioByPeriod = new Map(audio.rows.map((row) => [row.period, row]));
    const periods = Object.fromEntries(result.rows.map((row) => {
      const audioRow = audioByPeriod.get(row.period);
      const textCost = Number(row.estimated_cost_usd);
      const audioCost = Number(audioRow?.estimated_cost_usd ?? 0);
      return [row.period, {
        requests: Number(row.requests),
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningTokens: Number(row.reasoning_tokens),
        textModelCostUsd: textCost,
        audioDurationSeconds: Number(audioRow?.duration_seconds ?? 0),
        audioTranscriptionCostUsd: Number(audioRow?.transcription_cost_usd ?? 0),
        audioTtsCostUsd: Number(audioRow?.tts_cost_usd ?? 0),
        audioCostUsd: audioCost,
        estimatedCostUsd: textCost + audioCost,
      }];
    }));
    return {
      model: this.config.OPENAI_MODEL,
      voiceModel: this.config.CINDER_VOICE_SOCIAL_MODEL,
      periods,
      modelBreakdown: modelBreakdown.rows.map((row) => ({
        model: row.model, requests: Number(row.requests), inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens),
        estimatedCostUsd: Number(row.estimated_cost_usd),
      })),
      pricing: {
        full: { model: this.config.OPENAI_MODEL, inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
        voice: { model: this.config.CINDER_VOICE_SOCIAL_MODEL, inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
        transcriptionUsdPerMinute: this.config.CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE,
        ttsUsdPerMinute: this.config.CINDER_VOICE_CLOUD_TTS_USD_PER_MINUTE,
      },
      note: 'Estimated OpenAI cost from exact recorded model tokens plus measured cloud STT and TTS duration. Deployment self-tests are included. Piper fallback has no API cost.',
    };
  }

  async pruneTransientData(): Promise<void> {
    const results = await Promise.all([
      this.pool.query(
        `DELETE FROM events WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [this.config.EVENT_RETENTION_DAYS],
      ),
      this.pool.query(
        `DELETE FROM actions WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [this.config.ACTION_RETENTION_DAYS],
      ),
      this.pool.query(
        `DELETE FROM processed_external_events WHERE processed_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [this.config.EXTERNAL_EVENT_RETENTION_DAYS],
      ),
      this.pool.query(
        `DELETE FROM pending_approvals WHERE status <> 'pending' AND resolved_at < NOW() - INTERVAL '30 days'`,
      ),
      this.pool.query(
        `DELETE FROM pending_approvals WHERE status = 'pending' AND expires_at < NOW() - INTERVAL '7 days'`,
      ),
      this.pool.query(
        `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
      ),
      this.pool.query(
        `DELETE FROM audio_usage WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [this.config.ACTION_RETENTION_DAYS],
      ),
    ]);
    this.logger.info({
      events: results[0].rowCount ?? 0,
      actions: results[1].rowCount ?? 0,
      externalEvents: results[2].rowCount ?? 0,
      approvals: (results[3].rowCount ?? 0) + (results[4].rowCount ?? 0),
      memories: results[5].rowCount ?? 0,
    }, 'Pruned expired Cinder data');
  }
}
