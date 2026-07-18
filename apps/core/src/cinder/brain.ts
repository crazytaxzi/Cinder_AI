import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import type { EventEnvelope, Scene } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import { buildInstructions, loadCinderProfile, sceneToModelInput } from './instructions.js';

export interface CinderTurnResult {
  turnId: string;
  text: string;
  silent: boolean;
  toolCalls: number;
  requestIds: string[];
}

export interface CinderSelfTestResult {
  ok: boolean;
  model: string;
  toolCount: number;
  requestIds: string[];
  elapsedMs: number;
  summary: string;
}

export class CinderTurnError extends Error {
  readonly errorId = randomUUID();
  readonly requestId: string | undefined;
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CinderTurnError';
    if (cause && typeof cause === 'object') {
      const candidate = cause as Record<string, unknown>;
      this.requestId = typeof candidate.request_id === 'string'
        ? candidate.request_id
        : typeof candidate.requestId === 'string'
          ? candidate.requestId
          : undefined;
      this.code = typeof candidate.code === 'string' ? candidate.code : undefined;
      this.status = typeof candidate.status === 'number' ? candidate.status : undefined;
    }
  }
}

interface RunLoopOptions {
  scene: Scene;
  instructions: string;
  initialInput: Array<Record<string, unknown>>;
  firstToolChoice?: Record<string, unknown> | 'auto' | 'none';
  maxRounds?: number;
  allowFinalTextAfterSilence?: boolean;
}

export class CinderBrain {
  private readonly openai: OpenAI;
  private instructions = '';
  private voiceInstructions = '';
  private socialInstructions = '';
  private readonly voiceAttention = new Map<string, {
    topic: string;
    engagedUsers: string[];
    lastDecision: 'silent' | 'respond' | 'escalate';
    lastCinderText: string;
    updatedAt: string;
  }>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly tools: ToolRegistry,
    private readonly usageRecorder?: { recordModelUsage(input: {
      turnId: string; requestId?: string; model: string; inputTokens: number;
      cachedInputTokens: number; outputTokens: number; reasoningTokens: number;
    }): Promise<void> },
  ) {
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.OPENAI_TIMEOUT_MS,
      maxRetries: config.OPENAI_MAX_RETRIES,
    });
  }

  async initialize(): Promise<void> {
    const profile = await loadCinderProfile(this.config.CINDER_PROFILE_PATH);
    this.instructions = buildInstructions(profile);
    this.socialInstructions = `${profile}\n\nYou are only Cinder's low-cost attention gate for ambient Discord conversation. Decide whether full Cinder should engage. Use silent when people should keep the floor. Use respond when a natural Cinder contribution is warranted. Use escalate for any platform action, moderation, administration, memory, approval, identity, Windows, capability, or tool-related request. Never write Cinder's dialogue and always return an empty text field; the full agent authors every response.`;
    this.voiceInstructions = `${profile}\n\nYou are only Cinder's low-cost attention gate in a live Discord voice room. There is no wake word. Follow the room like a person and decide whether full Cinder should engage, but do not author his dialogue. Use silent when humans should keep the floor, respond when a natural contribution is warranted, and escalate for tool work, capability questions, moderation, administration, memory, or complex reasoning. Always return an empty text field; the full agent authors every spoken response.`;
    this.tools.assertSchemasValid();
  }

  getOpenAIClient(): OpenAI {
    return this.openai;
  }

  async startupSelfTest(): Promise<CinderSelfTestResult> {
    const started = Date.now();
    this.tools.assertSchemasValid();
    const current: EventEnvelope = {
      id: `startup-self-test:${randomUUID()}`,
      platform: 'windows',
      occurredAt: new Date().toISOString(),
      actor: {
        platform: 'system',
        platformUserId: 'cinder-startup-self-test',
        displayName: 'Cinder startup self-test',
        roles: [],
        isBot: true,
      },
      text: 'Run the full-tool startup self-test.',
      mentions: [],
      attachments: [],
      metadata: { verified: true, startupSelfTest: true },
    };
    const scene: Scene = {
      current,
      recentEvents: [],
      relevantMemories: [],
      pendingApprovals: [],
      recentActions: [],
      activeVoiceParticipants: [],
    };

    const result = await this.runLoop({
      scene,
      instructions: [
        'This is Cinder startup verification.',
        'First call stay_silent with reason exactly "startup full-tool schema verification".',
        'After the tool output, respond with exactly SELF_TEST_OK and nothing else.',
      ].join(' '),
      initialInput: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Verify the complete real tool set now.' }],
      }],
      firstToolChoice: { type: 'function', name: 'stay_silent' },
      maxRounds: 3,
      allowFinalTextAfterSilence: true,
    });

    const ok = result.toolCalls === 1 && result.text.trim() === 'SELF_TEST_OK';
    if (!ok) {
      throw new CinderTurnError(
        `Full-tool startup self-test returned an unexpected result: tools=${result.toolCalls}, text=${JSON.stringify(result.text)}`,
      );
    }

    return {
      ok: true,
      model: this.config.OPENAI_MODEL,
      toolCount: this.tools.toolNames().length,
      requestIds: result.requestIds,
      elapsedMs: Date.now() - started,
      summary: `OpenAI accepted all ${this.tools.toolNames().length} real tools and completed a full tool-output round trip.`,
    };
  }

  async takeVerificationTurn(input: {
    scene: Scene;
    instructions: string;
    firstToolChoice?: Record<string, unknown> | 'auto' | 'none';
    maxRounds?: number;
  }): Promise<CinderTurnResult> {
    return this.runLoop({
      scene: input.scene,
      instructions: input.instructions,
      initialInput: [{
        role: 'user',
        content: [{ type: 'input_text', text: sceneToModelInput(input.scene) }],
      }],
      ...(input.firstToolChoice ? { firstToolChoice: input.firstToolChoice } : {}),
      ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
    });
  }

  async takeTurn(scene: Scene): Promise<CinderTurnResult> {
    const content: Array<Record<string, unknown>> = [
      { type: 'input_text', text: sceneToModelInput(scene) },
    ];
    for (const attachment of scene.current.attachments) {
      if (attachment.contentType?.startsWith('image/')) {
        content.push({ type: 'input_image', image_url: attachment.url, detail: 'auto' });
      }
    }

    return this.runLoop({
      scene,
      instructions: this.instructions,
      initialInput: [{ role: 'user', content }],
    });
  }

  async takeVoiceTurn(scene: Scene): Promise<CinderTurnResult> {
    const startedAt = Date.now();
    const turnId = randomUUID();
    const key = `${scene.current.serverId ?? 'voice'}:${scene.current.voiceChannelId ?? scene.current.channelId ?? 'room'}`;
    const attention = this.voiceAttention.get(key);
    const recentVoice = scene.recentEvents
      .filter((event) => event.platform === 'discord_voice')
      .slice(-this.config.CINDER_VOICE_CONTEXT_EVENT_LIMIT)
      .map((event) => ({ at: event.occurredAt, speaker: event.actor.displayName, text: event.text }));
    const compactScene = {
      current: {
        at: scene.current.occurredAt,
        speaker: scene.current.actor.displayName,
        text: scene.current.text,
        overlapAtStart: scene.current.metadata.overlapAtStart === true,
      },
      recentVoice,
      participants: scene.activeVoiceParticipants.map((person) => person.displayName),
      memories: scene.relevantMemories.slice(0, 4).map((memory) => memory.content),
      attention: attention ?? null,
    };
    const response = await this.createResponseWithRateLimitRetry({
      model: this.config.CINDER_VOICE_SOCIAL_MODEL,
      instructions: this.voiceInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(compactScene) }] }],
      tools: [],
      tool_choice: 'none',
      store: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 220,
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'voice_attention_decision',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['silent', 'respond', 'escalate'] },
              text: { type: 'string' },
              topic: { type: 'string' },
              engaged_users: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['decision', 'text', 'topic', 'engaged_users', 'reason'],
            additionalProperties: false,
          },
        },
      },
    }, turnId, 0);
    const requestId = this.requestIdFrom(response);
    await this.recordUsage(turnId, requestId, this.config.CINDER_VOICE_SOCIAL_MODEL, response);
    let decision: {
      decision: 'silent' | 'respond' | 'escalate'; text: string; topic: string;
      engaged_users: string[]; reason: string;
    };
    try {
      decision = JSON.parse(response.output_text) as typeof decision;
      if (!['silent', 'respond', 'escalate'].includes(decision.decision)) throw new Error('Invalid voice decision.');
    } catch (error) {
      this.logger.warn({ err: error, turnId, output: response.output_text }, 'Voice attention response was invalid; escalating safely');
      return this.takeTurn(scene);
    }
    this.voiceAttention.set(key, {
      topic: decision.topic.slice(0, 200),
      engagedUsers: decision.engaged_users.slice(0, 12),
      lastDecision: decision.decision,
      lastCinderText: decision.decision === 'respond' ? decision.text.slice(0, this.config.CINDER_VOICE_MAX_REPLY_CHARACTERS) : '',
      updatedAt: new Date().toISOString(),
    });
    if (decision.decision !== 'silent') {
      this.logger.info({ turnId, eventId: scene.current.id, decision: decision.decision, reason: decision.reason }, 'Voice attention gate engaged full Cinder agent');
      const result = await this.takeTurn(scene);
      this.voiceAttention.set(key, {
        topic: decision.topic.slice(0, 200),
        engagedUsers: decision.engaged_users.slice(0, 12),
        lastDecision: decision.decision,
        lastCinderText: result.text.slice(0, this.config.CINDER_VOICE_MAX_REPLY_CHARACTERS),
        updatedAt: new Date().toISOString(),
      });
      return result;
    }
    const text = '';
    this.logger.info({
      turnId, eventId: scene.current.id, platform: scene.current.platform,
      silent: decision.decision === 'silent', toolCalls: 0,
      requestIds: requestId ? [requestId] : [], responseLength: text.length,
      elapsedMs: Date.now() - startedAt, voiceSocialModel: this.config.CINDER_VOICE_SOCIAL_MODEL,
      topic: decision.topic,
    }, 'Cinder completed compact voice attention turn');
    return {
      turnId,
      text,
      silent: decision.decision === 'silent',
      toolCalls: 0,
      requestIds: requestId ? [requestId] : [],
    };
  }

  async takeSocialTurn(scene: Scene): Promise<CinderTurnResult> {
    if (scene.current.metadata.urgentModeration === true) return this.takeTurn(scene);
    if (
      scene.current.platform === 'twitch_chat'
      || scene.current.metadata.directMention === true
      || scene.current.metadata.replyToCinder === true
    ) return this.takeTurn(scene);
    const startedAt = Date.now();
    const turnId = randomUUID();
    const recent = scene.recentEvents
      .filter((event) => event.platform === scene.current.platform)
      .slice(-this.config.CINDER_SOCIAL_CONTEXT_EVENT_LIMIT)
      .map((event) => ({
        at: event.occurredAt,
        speaker: event.actor.displayName,
        text: event.text,
        cinderGenerated: event.metadata.cinderGenerated === true,
      }));
    const compactScene = {
      platform: scene.current.platform,
      current: {
        at: scene.current.occurredAt,
        speaker: scene.current.actor.displayName,
        roles: scene.current.actor.roles,
        isOwner: scene.current.actor.isGuildOwner === true,
        text: scene.current.text,
        directMention: scene.current.metadata.directMention === true,
        replyToCinder: scene.current.metadata.replyToCinder === true,
        replyTo: scene.current.replyTo
          ? { author: scene.current.replyTo.authorName, excerpt: scene.current.replyTo.excerpt }
          : null,
      },
      recent,
      memories: scene.relevantMemories.slice(0, 4).map((memory) => memory.content),
      pendingApprovalCount: scene.pendingApprovals.length,
    };
    const response = await this.createResponseWithRateLimitRetry({
      model: this.config.CINDER_SOCIAL_MODEL,
      instructions: this.socialInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(compactScene) }] }],
      tools: [], tool_choice: 'none', store: false,
      reasoning: { effort: 'none' }, max_output_tokens: 240,
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema', name: 'social_attention_decision', strict: true,
          schema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['silent', 'respond', 'escalate'] },
              text: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['decision', 'text', 'reason'], additionalProperties: false,
          },
        },
      },
    }, turnId, 0);
    const requestId = this.requestIdFrom(response);
    await this.recordUsage(turnId, requestId, this.config.CINDER_SOCIAL_MODEL, response);
    let decision: { decision: 'silent' | 'respond' | 'escalate'; text: string; reason: string };
    try {
      decision = JSON.parse(response.output_text) as typeof decision;
      if (!['silent', 'respond', 'escalate'].includes(decision.decision)) throw new Error('Invalid social decision.');
    } catch (error) {
      this.logger.warn({ err: error, turnId, output: response.output_text }, 'Social attention response was invalid; escalating safely');
      return this.takeTurn(scene);
    }
    if (decision.decision !== 'silent') {
      this.logger.info({ turnId, eventId: scene.current.id, decision: decision.decision, reason: decision.reason }, 'Social attention gate engaged full Cinder agent');
      return this.takeTurn(scene);
    }
    const text = '';
    this.logger.info({
      turnId, eventId: scene.current.id, platform: scene.current.platform,
      silent: decision.decision === 'silent', toolCalls: 0,
      requestIds: requestId ? [requestId] : [], responseLength: text.length,
      elapsedMs: Date.now() - startedAt, socialModel: this.config.CINDER_SOCIAL_MODEL,
    }, 'Cinder completed compact social attention turn');
    return {
      turnId, text, silent: decision.decision === 'silent', toolCalls: 0,
      requestIds: requestId ? [requestId] : [],
    };
  }

  private async recordUsage(turnId: string, requestId: string | undefined, model: string, response: OpenAIResponse): Promise<void> {
    const usage = (response as unknown as { usage?: {
      input_tokens?: number; output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    } }).usage;
    if (!usage || !this.usageRecorder) return;
    await this.usageRecorder.recordModelUsage({
      turnId,
      ...(requestId ? { requestId } : {}),
      model,
      inputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    }).catch((error) => this.logger.warn({ err: error, requestId, turnId }, 'Failed to record model usage'));
  }

  private async createResponseWithRateLimitRetry(
    payload: Record<string, unknown>,
    turnId: string,
    round: number,
  ): Promise<OpenAIResponse> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.openai.responses.create(payload as never) as OpenAIResponse;
      } catch (error) {
        const candidate = error as { status?: number; message?: string; headers?: { get?(name: string): string | null } };
        if (candidate.status !== 429 || attempt === 3) throw error;
        const messageSeconds = candidate.message?.match(/try again in\s+([0-9.]+)s/i)?.[1];
        const headerSeconds = candidate.headers?.get?.('retry-after');
        const seconds = Number(messageSeconds ?? headerSeconds ?? 2 ** attempt);
        const waitMs = Math.min(30_000, Math.max(1_000, Math.ceil((Number.isFinite(seconds) ? seconds : 2 ** attempt) * 1_000) + 350));
        this.logger.warn({ turnId, round, attempt: attempt + 1, waitMs }, 'OpenAI TPM limit reached; safely delaying queued turn');
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw new Error('Unreachable rate-limit retry state.');
  }

  private async runLoop(options: RunLoopOptions): Promise<CinderTurnResult> {
    const startedAt = Date.now();
    const turnId = randomUUID();
    const input = [...options.initialInput];
    const requestIds: string[] = [];
    let silent = false;
    let toolCalls = 0;
    let finalText = '';
    const maxRounds = options.maxRounds ?? this.config.CINDER_MAX_TOOL_ROUNDS;

    for (let round = 0; round < maxRounds; round += 1) {
      try {
        const response = await this.createResponseWithRateLimitRetry({
          model: this.config.OPENAI_MODEL,
          instructions: options.instructions,
          input: input as never,
          tools: (typeof this.tools.definitionsForScene === 'function'
            ? this.tools.definitionsForScene(options.scene)
            : this.tools.definitions()) as never,
          tool_choice: round === 0 ? (options.firstToolChoice ?? 'auto') : 'auto',
          parallel_tool_calls: false,
          store: false,
          reasoning: { effort: this.config.OPENAI_REASONING_EFFORT },
          max_output_tokens: this.config.CINDER_MAX_OUTPUT_TOKENS,
        }, turnId, round);

        const requestId = this.requestIdFrom(response);
        if (requestId) requestIds.push(requestId);
        const usage = (response as unknown as { usage?: {
          input_tokens?: number; output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
          output_tokens_details?: { reasoning_tokens?: number };
        } }).usage;
        if (usage && this.usageRecorder) {
          await this.usageRecorder.recordModelUsage({
            turnId,
            ...(requestId ? { requestId } : {}),
            model: this.config.OPENAI_MODEL,
            inputTokens: usage.input_tokens ?? 0,
            cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
          }).catch((error) => this.logger.warn({ err: error, requestId, turnId }, 'Failed to record model usage'));
        }

        if ((response as { status?: string }).status === 'incomplete') {
          const details = JSON.stringify((response as { incomplete_details?: unknown }).incomplete_details ?? {});
          throw new CinderTurnError(`OpenAI returned an incomplete response: ${details}`);
        }

        const output = response.output as unknown as Array<Record<string, unknown>>;
        input.push(...output);
        const calls = output.filter((item) => item.type === 'function_call');

        if (calls.length === 0) {
          finalText = response.output_text.trim();
          break;
        }

        for (const rawCall of calls) {
          const call = rawCall as {
            type: 'function_call';
            name?: string;
            arguments?: string;
            call_id?: string;
          };
          if (!call.name || !call.call_id) {
            throw new CinderTurnError(`OpenAI returned a malformed function call: ${JSON.stringify(rawCall)}`);
          }

          toolCalls += 1;
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(call.arguments ?? '{}') as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('Tool arguments were not a JSON object.');
            }
            args = parsed as Record<string, unknown>;
          } catch (error) {
            const result = {
              ok: false,
              summary: 'The tool arguments were not valid JSON.',
              errorCode: 'INVALID_TOOL_ARGUMENTS',
            };
            input.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(result),
            });
            this.logger.warn({ err: error, tool: call.name, callId: call.call_id }, 'Model produced invalid tool arguments');
            continue;
          }

          const result = await this.tools.execute(call.name, args, {
            currentEvent: options.scene.current,
            scene: options.scene,
            cinderTurnId: turnId,
          });

          if (call.name === 'stay_silent' && result.ok) silent = true;

          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result),
          });
        }
        if (silent && !options.allowFinalTextAfterSilence) break;
      } catch (error) {
        if (error instanceof CinderTurnError) throw error;
        const wrapped = new CinderTurnError(
          error instanceof Error ? error.message : String(error),
          error,
        );
        this.logger.error({
          err: error,
          errorId: wrapped.errorId,
          requestId: wrapped.requestId,
          code: wrapped.code,
          status: wrapped.status,
          turnId,
          round,
          eventId: options.scene.current.id,
        }, 'OpenAI cognitive turn failed');
        throw wrapped;
      }
    }

    if (!silent && !finalText) {
      throw new CinderTurnError(
        `Cinder exhausted ${maxRounds} tool rounds without producing a final response.`,
      );
    }

    if (finalText.length > this.config.CINDER_MAX_REPLY_CHARACTERS) {
      finalText = `${finalText.slice(0, this.config.CINDER_MAX_REPLY_CHARACTERS - 1)}…`;
    }
    if (silent && !options.allowFinalTextAfterSilence) finalText = '';

    this.logger.info({
      turnId,
      eventId: options.scene.current.id,
      platform: options.scene.current.platform,
      silent,
      toolCalls,
      requestIds,
      responseLength: finalText.length,
      elapsedMs: Date.now() - startedAt,
    }, 'Cinder completed cognitive turn');

    return { turnId, text: finalText, silent, toolCalls, requestIds };
  }

  private requestIdFrom(response: unknown): string | undefined {
    if (!response || typeof response !== 'object') return undefined;
    const candidate = response as Record<string, unknown>;
    return typeof candidate._request_id === 'string'
      ? candidate._request_id
      : typeof candidate.request_id === 'string'
        ? candidate.request_id
        : undefined;
  }
}
