import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';
import prism from 'prism-media';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type {
  Client,
  Guild,
  GuildMember,
  VoiceBasedChannel,
} from 'discord.js';
import type { EventEnvelope, ToolExecutionResult } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import { pcmToWav } from './wav.js';
import { pcmHasSpeechEnergy, sanitizeVoiceTranscript } from './input-quality.js';
import { shouldRecoverVoiceReceive } from './receive-recovery.js';

const execFileAsync = promisify(execFile);

interface VoiceSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  speakingUsers: Set<string>;
  idleTimer?: NodeJS.Timeout;
  speechInterrupted: boolean;
  interruptionTimers: Map<string, NodeJS.Timeout>;
}

export function transformImpVoice(audio: Buffer, speed: number, pitch: number): prism.FFmpeg {
  const tempo = speed / pitch;
  const transformed = new prism.FFmpeg({
    args: [
      '-analyzeduration', '0', '-loglevel', 'error', '-i', 'pipe:0',
      '-af', `asetrate=48000*${pitch},aresample=48000,atempo=${tempo}`,
      '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-f', 'ogg',
    ],
  });
  Readable.from([audio]).pipe(transformed);
  return transformed;
}

export function wavDurationSeconds(wav: Buffer): number | undefined {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  const byteRate = wav.readUInt32LE(28);
  if (!byteRate) return undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (name === 'data') {
      // Streaming WAV responses commonly use 0xFFFFFFFF as an unknown data
      // length. The bytes actually present in the response are authoritative.
      const available = Math.max(0, wav.length - (offset + 8));
      return Math.min(size, available) / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

export class VoiceManager {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly captures = new Set<string>();
  private readonly receiveRecoveries = new Set<string>();
  private readonly lastReceiveRecoveryAt = new Map<string, number>();
  private readonly openai: OpenAI;
  private localTranscriptionTail: Promise<void> = Promise.resolve();
  private piperWorker: ChildProcessWithoutNullStreams | undefined;
  private readonly piperRequests = new Map<string, {
    resolve: (audio: Buffer) => void;
    reject: (error: Error) => void;
    outputPath: string;
    directory: string;
  }>();

  constructor(
    private readonly client: Client,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly emitEvent: (event: EventEnvelope) => Promise<void>,
    private readonly audioUsageRecorder?: { recordAudioUsage(input: {
      model: string; durationSeconds: number; estimatedCostUsd: number; platform: string;
    }): Promise<void> },
  ) {
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.OPENAI_TIMEOUT_MS,
      maxRetries: config.OPENAI_MAX_RETRIES,
    });
  }

  activeParticipants(serverId?: string): Array<{ userId: string; displayName: string; speaking: boolean; roles: string[] }> {
    if (!serverId) return [];
    const session = this.sessions.get(serverId);
    const guild = this.client.guilds.cache.get(serverId);
    if (!session || !guild) return [];
    const channel = guild.channels.cache.get(session.channelId);
    if (!channel?.isVoiceBased()) return [];

    return [...channel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({
        userId: member.id,
        displayName: member.displayName,
        speaking: session.speakingUsers.has(member.id),
        roles: member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.name),
      }));
  }

  isActive(serverId?: string): boolean {
    return Boolean(serverId && this.sessions.has(serverId));
  }

  async join(guild: Guild, channel: VoiceBasedChannel): Promise<ToolExecutionResult> {
    await this.leave(guild.id);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      // Cinder consumes speech for transcription. The current discord.js DAVE
      // receive path has produced sender-specific undecodable Opus payloads in
      // production, so use the stable non-DAVE transport unless explicitly enabled.
      daveEncryption: this.config.DISCORD_VOICE_DAVE_ENCRYPTION,
      decryptionFailureTolerance: this.config.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE,
      debug: this.config.LOG_LEVEL === 'debug' || this.config.LOG_LEVEL === 'trace',
    });

    if (this.config.LOG_LEVEL === 'debug' || this.config.LOG_LEVEL === 'trace') {
      connection.on('debug', (message) => {
        this.logger.debug({ guildId: guild.id, voiceDebug: message }, 'Discord voice connection debug');
      });
    }

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: guild.id,
      channelId: channel.id,
      connection,
      player,
      speakingUsers: new Set(),
      speechInterrupted: false,
      interruptionTimers: new Map(),
    };
    this.sessions.set(guild.id, session);

    connection.receiver.speaking.on('start', (userId) => {
      if (userId === this.client.user?.id) return;

      // Cinder does not yield or begin processing another utterance while
      // his current spoken reply is still playing.
      if (player.state.status === AudioPlayerStatus.Playing) {
        this.resetIdleTimer(session);
        this.logger.debug(
          { guildId: guild.id, userId },
          'Ignored incoming voice while Cinder was speaking',
        );
        return;
      }

      session.speakingUsers.add(userId);
      this.resetIdleTimer(session);
      void this.captureUtterance(guild, session, userId);
    });

    connection.receiver.speaking.on('end', (userId) => {
      session.speakingUsers.delete(userId);
      const interruptionTimer = session.interruptionTimers.get(userId);
      if (interruptionTimer) clearTimeout(interruptionTimer);
      session.interruptionTimers.delete(userId);
      this.resetIdleTimer(session);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await this.leave(guild.id);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    this.resetIdleTimer(session);
    this.logger.info({
      guildId: guild.id,
      channelId: channel.id,
      daveEncryption: this.config.DISCORD_VOICE_DAVE_ENCRYPTION,
      decryptionFailureTolerance: this.config.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE,
    }, 'Discord voice receiver ready');
    return { ok: true, summary: `Joined voice channel ${channel.name}.`, data: { channelId: channel.id } };
  }

  async leave(guildId: string): Promise<ToolExecutionResult> {
    const session = this.sessions.get(guildId);
    const connection = session?.connection ?? getVoiceConnection(guildId);
    if (!connection) return { ok: true, summary: 'Cinder was not in voice.' };

    if (session?.idleTimer) clearTimeout(session.idleTimer);
    if (session) this.clearInterruptionTimers(session);
    session?.player.stop(true);
    connection.destroy();
    this.sessions.delete(guildId);
    return { ok: true, summary: 'Left voice chat.' };
  }

  async stop(): Promise<void> {
    this.piperWorker?.kill('SIGTERM');
    this.piperWorker = undefined;
    for (const pending of this.piperRequests.values()) pending.reject(new Error('Piper worker stopped.'));
    this.piperRequests.clear();
  }

  async speak(guildId: string, text: string): Promise<ToolExecutionResult> {
    const session = this.sessions.get(guildId);
    if (!session) return { ok: false, summary: 'Cinder is not in a voice channel.', errorCode: 'NOT_IN_VOICE' };
    if (session.speakingUsers.size > 0) {
      await this.waitForFloor(session, 5_000);
    }

    const synthesisStartedAt = Date.now();
    let synthesisSource: 'cloud' | 'local' = 'local';
    let audio: Buffer;
    if (this.config.CINDER_VOICE_CLOUD_TTS) {
      try {
        audio = await this.synthesizeWithOpenAI(text);
        synthesisSource = 'cloud';
        const measuredDuration = wavDurationSeconds(audio);
        const plausibleMaximum = Math.max(30, text.length / 3);
        const durationSeconds = measuredDuration !== undefined && measuredDuration <= plausibleMaximum
          ? measuredDuration
          : Math.max(0.5, text.length / 15);
        await this.audioUsageRecorder?.recordAudioUsage({
          model: this.config.OPENAI_TTS_MODEL,
          durationSeconds,
          estimatedCostUsd: durationSeconds / 60 * this.config.CINDER_VOICE_CLOUD_TTS_USD_PER_MINUTE,
          platform: 'discord_voice_tts',
        }).catch((error) => this.logger.warn({ err: error }, 'Failed to record voice synthesis usage'));
      } catch (error) {
        this.logger.warn({ err: error, guildId }, 'Cloud voice synthesis failed; using local Piper fallback');
        audio = await this.synthesizeWithPersistentPiper(text);
      }
    } else {
      audio = await this.synthesizeWithPersistentPiper(text);
    }
    const transformed = transformImpVoice(
      audio,
      this.config.CINDER_VOICE_SPEED,
      this.config.CINDER_VOICE_PITCH,
    );
    const resource = createAudioResource(transformed, {
      inputType: StreamType.OggOpus,
      silencePaddingFrames: this.config.DISCORD_VOICE_SILENCE_PADDING_FRAMES,
    });
    this.clearInterruptionTimers(session);
    session.speechInterrupted = false;
    session.player.play(resource);
    this.logger.info({ guildId, characters: text.length, synthesisSource, elapsedMs: Date.now() - synthesisStartedAt }, 'Voice reply synthesized and playback started');
    this.resetIdleTimer(session);
    try {
      await entersState(session.player, AudioPlayerStatus.Idle, 120_000);
    } catch (error) {
      this.logger.warn({ err: error, guildId }, 'Voice playback did not complete cleanly');
      return { ok: false, summary: 'Voice playback failed before completion.', errorCode: 'VOICE_PLAYBACK_FAILED', retryable: true };
    }
    return session.speechInterrupted
      ? { ok: true, summary: 'Cinder yielded when someone interrupted the voice response.', data: { interrupted: true } }
      : { ok: true, summary: 'Spoke in voice chat.' };
  }

  private async synthesizeWithPersistentPiper(text: string): Promise<Buffer> {
    this.ensurePiperWorker();
    const directory = await mkdtemp(join(tmpdir(), 'cinder-piper-'));
    const outputPath = join(directory, 'speech.wav');
    const id = randomUUID();
    return new Promise<Buffer>((requestResolve, requestReject) => {
      const timeout = setTimeout(() => {
        this.piperRequests.delete(id);
        void rm(directory, { recursive: true, force: true });
        requestReject(new Error('Persistent Piper synthesis timed out.'));
      }, 120_000);
      this.piperRequests.set(id, {
        outputPath,
        directory,
        resolve: (audio) => { clearTimeout(timeout); requestResolve(audio); },
        reject: (error) => { clearTimeout(timeout); requestReject(error); },
      });
      this.piperWorker!.stdin.write(`${JSON.stringify({ id, text, outputPath })}\n`);
    });
  }

  private async synthesizeWithOpenAI(text: string): Promise<Buffer> {
    const response = await this.openai.audio.speech.create({
      model: this.config.OPENAI_TTS_MODEL,
      voice: this.config.OPENAI_TTS_VOICE,
      input: text,
      instructions: this.config.OPENAI_TTS_INSTRUCTIONS,
      response_format: 'wav',
    });
    return Buffer.from(await response.arrayBuffer());
  }

  private ensurePiperWorker(): void {
    if (this.piperWorker && !this.piperWorker.killed) return;
    const worker = spawn(this.config.LOCAL_PIPER_PYTHON, [
      resolve(this.config.LOCAL_PIPER_WORKER),
      '--model', this.config.LOCAL_PIPER_MODEL,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.piperWorker = worker;
    createInterface({ input: worker.stdout }).on('line', (line) => {
      let message: { id?: string; ok?: boolean; error?: string };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (!message.id) return;
      const pending = this.piperRequests.get(message.id);
      if (!pending) return;
      this.piperRequests.delete(message.id);
      if (!message.ok) {
        pending.reject(new Error(message.error ?? 'Piper synthesis failed.'));
        void rm(pending.directory, { recursive: true, force: true });
        return;
      }
      void readFile(pending.outputPath)
        .then((audio) => pending.resolve(audio))
        .catch((error: unknown) => pending.reject(error instanceof Error ? error : new Error(String(error))))
        .finally(() => rm(pending.directory, { recursive: true, force: true }));
    });
    worker.stderr.on('data', (chunk: Buffer) => this.logger.debug({ output: chunk.toString().trim() }, 'Piper worker output'));
    worker.on('exit', (code, signal) => {
      if (this.piperWorker === worker) this.piperWorker = undefined;
      const error = new Error(`Piper worker exited (${code ?? signal ?? 'unknown'}).`);
      for (const pending of this.piperRequests.values()) pending.reject(error);
      this.piperRequests.clear();
      this.logger.warn({ code, signal }, 'Persistent Piper worker exited');
    });
  }

  private clearInterruptionTimers(session: VoiceSession): void {
    for (const timer of session.interruptionTimers.values()) clearTimeout(timer);
    session.interruptionTimers.clear();
  }

  private async waitForFloor(session: VoiceSession, maxMs: number): Promise<void> {
    const started = Date.now();
    while (session.speakingUsers.size > 0 && Date.now() - started < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  private resetIdleTimer(session: VoiceSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.leave(session.guildId).catch((error) => {
        this.logger.error({ err: error, guildId: session.guildId }, 'Failed to leave idle voice session');
      });
    }, this.config.DISCORD_VOICE_IDLE_MINUTES * 60_000);
  }

  private async recoverVoiceReceive(
    guild: Guild,
    session: VoiceSession,
    userId: string,
    corruptPackets: number,
    fallbackPackets: number,
  ): Promise<void> {
    if (this.sessions.get(guild.id) !== session || this.receiveRecoveries.has(guild.id)) return;
    const channel = guild.channels.cache.get(session.channelId);
    if (!channel?.isVoiceBased()) return;

    this.receiveRecoveries.add(guild.id);
    this.lastReceiveRecoveryAt.set(guild.id, Date.now());
    try {
      this.logger.warn({
        guildId: guild.id,
        channelId: session.channelId,
        userId,
        corruptPackets,
        fallbackPackets,
      }, 'Rebuilding Discord voice session after repeated receive decode failures');
      await this.leave(guild.id);
      await new Promise((resolve) => setTimeout(resolve, 750));
      const result = await this.join(guild, channel);
      if (!result.ok) throw new Error(result.summary);
      this.logger.info({ guildId: guild.id, channelId: channel.id, userId }, 'Discord voice receive session rebuilt');
    } catch (error) {
      this.logger.error({ err: error, guildId: guild.id, channelId: session.channelId, userId }, 'Discord voice receive recovery failed');
    } finally {
      this.receiveRecoveries.delete(guild.id);
    }
  }

  private async captureUtterance(guild: Guild, session: VoiceSession, userId: string): Promise<void> {
    const key = `${guild.id}:${userId}`;
    if (this.captures.has(key)) return;
    this.captures.add(key);

    try {
      const member = await guild.members.fetch(userId);
      const opusStream = session.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.config.CINDER_VOICE_SPEECH_END_MS },
      });
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
      const chunks: Buffer[] = [];
      let total = 0;
      let corruptPackets = 0;
      let fallbackPackets = 0;
      const maxBytes = 48_000 * 2 * 2 * this.config.DISCORD_VOICE_MAX_UTTERANCE_SECONDS;

      decoder.on('decoderFallback', (error: unknown, packetLength: number) => {
        fallbackPackets += 1;
        this.logger.warn({
          err: error,
          guildId: guild.id,
          userId,
          packetLength,
          fallbackPackets,
        }, 'Native Opus decode failed; switched this utterance to the JavaScript decoder');
      });
      decoder.on('decoderRecovered', (packetLength: number) => {
        this.logger.debug({ guildId: guild.id, userId, packetLength }, 'Native Opus decoder recovered during utterance');
      });
      decoder.on('corruptPacket', (error: unknown, packetLength: number) => {
        corruptPackets += 1;
        this.logger.warn({
          err: error,
          guildId: guild.id,
          userId,
          packetLength,
          corruptPackets,
        }, 'Dropped a Discord voice packet rejected by both Opus decoders');
      });

      const completion = new Promise<void>((resolve, reject) => {
        decoder.on('data', (chunk: Buffer) => {
          if (total >= maxBytes) {
            opusStream.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        decoder.once('end', resolve);
        decoder.once('close', resolve);
        decoder.once('error', reject);
        opusStream.once('error', reject);
      });

      opusStream.pipe(decoder);
      await completion;
      const pcm = Buffer.concat(chunks);
      const now = Date.now();
      const lastRecoveryAt = this.lastReceiveRecoveryAt.get(guild.id) ?? 0;
      if (shouldRecoverVoiceReceive({
        corruptPackets,
        decodedBytes: pcm.length,
        lastRecoveryAt,
        now,
        cooldownMs: this.config.DISCORD_VOICE_RECEIVE_RECOVERY_COOLDOWN_MS,
      })) {
        await this.recoverVoiceReceive(guild, session, userId, corruptPackets, fallbackPackets);
        return;
      }

      if (!pcmHasSpeechEnergy(pcm)) {
        this.logger.debug({
          guildId: guild.id,
          userId,
          total,
          corruptPackets,
          fallbackPackets,
        }, 'Discarded silence or a receiver noise fragment before transcription');
        return;
      }

      const wav = pcmToWav(pcm);
      const durationSeconds = total / (48_000 * 2 * 2);
      const transcriptionStartedAt = Date.now();
      let transcriptionSource: 'cloud' | 'local' = 'local';
      let text = '';
      let cloudFailed = false;
      if (this.config.CINDER_VOICE_CLOUD_TRANSCRIPTION) {
        try {
          const rawText = await this.transcribeWithOpenAI(wav);
          text = sanitizeVoiceTranscript(rawText) ?? '';
          transcriptionSource = 'cloud';
          await this.audioUsageRecorder?.recordAudioUsage({
            model: this.config.OPENAI_TRANSCRIBE_MODEL,
            durationSeconds,
            estimatedCostUsd: durationSeconds / 60 * this.config.CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE,
            platform: 'discord_voice',
          }).catch((error) => this.logger.warn({ err: error }, 'Failed to record voice transcription usage'));
          if (!text) {
            this.logger.warn({ guildId: guild.id, userId, rawText }, 'Discarded an invalid or prompt-leaking cloud voice transcript');
            return;
          }
        } catch (error) {
          cloudFailed = true;
          this.logger.warn({ err: error, guildId: guild.id, userId }, 'Cloud voice transcription failed; using local fallback');
        }
      }
      if (!this.config.CINDER_VOICE_CLOUD_TRANSCRIPTION || cloudFailed) {
        text = sanitizeVoiceTranscript(await this.transcribeLocally(wav)) ?? '';
        transcriptionSource = 'local';
      }
      if (!text) return;

      // A leave/reconnect may have invalidated this receiver while STT was in flight.
      if (this.sessions.get(guild.id) !== session) return;

      this.logger.info({
        guildId: guild.id,
        userId,
        transcriptionSource,
        durationSeconds,
        elapsedMs: Date.now() - transcriptionStartedAt,
        characters: text.length,
        corruptPackets,
        fallbackPackets,
      }, 'Voice utterance transcribed');
      await this.emitEvent(this.buildVoiceEvent(guild, session, member, text, transcriptionSource));
    } catch (error) {
      this.logger.error({ err: error, guildId: guild.id, userId }, 'Voice transcription failed');
    } finally {
      this.captures.delete(key);
    }
  }

  private async transcribeWithOpenAI(wav: Buffer): Promise<string> {
    const result = await this.openai.audio.transcriptions.create({
      file: await toFile(wav, 'discord-voice.wav', { type: 'audio/wav' }),
      model: this.config.OPENAI_TRANSCRIBE_MODEL,
      language: 'en',
      response_format: 'json',
    });
    return result.text.trim();
  }

  private async transcribeLocally(wav: Buffer): Promise<string> {
    const job = this.localTranscriptionTail.then(() => this.runLocalTranscription(wav));
    this.localTranscriptionTail = job.then(() => undefined, () => undefined);
    return job;
  }

  private async runLocalTranscription(wav: Buffer): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'cinder-voice-'));
    const sourcePath = join(directory, 'source.wav');
    const inputPath = join(directory, 'input.wav');
    try {
      await writeFile(sourcePath, wav);
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', inputPath,
      ], { timeout: 30_000 });
      await execFileAsync(this.config.LOCAL_WHISPER_BINARY, [
        '--model', this.config.LOCAL_WHISPER_MODEL,
        '--file', inputPath,
        '--threads', String(this.config.LOCAL_WHISPER_THREADS),
        '--language', 'en', '--no-gpu', '--best-of', '1', '--beam-size', '1',
        '--no-timestamps', '--output-txt',
      ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      return (await readFile(`${inputPath}.txt`, 'utf8')).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private buildVoiceEvent(
    guild: Guild,
    session: VoiceSession,
    member: GuildMember,
    text: string,
    transcriptionSource: 'cloud' | 'local',
  ): EventEnvelope {
    return {
      id: `discord-voice:${guild.id}:${member.id}:${randomUUID()}`,
      platform: 'discord_voice',
      occurredAt: new Date().toISOString(),
      serverId: guild.id,
      channelId: session.channelId,
      ...(guild.channels.cache.get(session.channelId)?.name
        ? { channelName: guild.channels.cache.get(session.channelId)!.name }
        : {}),
      voiceChannelId: session.channelId,
      actor: {
        platform: 'discord',
        platformUserId: member.id,
        displayName: member.displayName,
        username: member.user.username,
        roles: member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.name),
        isBot: member.user.bot,
        isGuildOwner: member.id === guild.ownerId,
      },
      text,
      mentions: [],
      attachments: [],
      metadata: {
        verified: true,
        source: 'discord_voice_receiver',
        speakerUserId: member.id,
        speakerDisplayName: member.displayName,
        transcriptionSource,
        transcriptionAccepted: true,
        overlapAtStart: session.speakingUsers.size > 1,
      },
    };
  }
}
