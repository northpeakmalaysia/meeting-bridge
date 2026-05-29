/**
 * WSS client used by all `swarm_admin.meeting.*` tools to talk to a
 * SwarmAI Meeting Hub. Single persistent outbound connection per CEO
 * Agent process; reconnect with exponential backoff; pending request /
 * reply matched by frame `id` ↔ `refersToId`.
 *
 * Concurrency model: tool handlers can call `request(...)` freely and
 * the client serialises outbound frames over the same socket. There is
 * no head-of-line blocking — the Hub correlates by frame id.
 *
 * Welcome state: the first incoming frame after dialing is
 * `bridge.welcome` carrying tenantId/Slug/DisplayName. The client
 * surfaces those to whatever code wants to log them but does NOT crash
 * if they look "wrong" — the operator's `expectedTenantSlug` check
 * (when configured) compares to the welcome at warn-only severity.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ConfigSchemaT } from './config-schema.js';

interface PendingReply {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  expectedReplyType: string;
  timer: NodeJS.Timeout;
}

/**
 * Multi-frame reply correlation. Used by `fetchArtefact` where the Hub
 * answers a `bridge.artefact.fetch` with a `begin → chunk* → end` series
 * (or a single `error` frame). The handler returns `'done'` to release
 * the slot or `'continue'` to keep accumulating. The bridge framework
 * never times out a stream from the client side — handlers manage their
 * own deadline.
 */
interface PendingStream {
  onFrame: (frame: Record<string, unknown>) => 'continue' | 'done';
  onError: (err: Error) => void;
}

export interface WelcomePayload {
  hubVersion: string;
  serverEventId: string;
  resumeOk: boolean;
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
}

export interface FetchArtefactResult {
  body: Buffer;
  mime: string;
  filename: string;
}

export interface PluginConfigEntry {
  pluginId: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface PluginConfigAck {
  applied: Array<{ pluginId: string; enabled: boolean; configured: boolean }>;
  errors?: Array<{ pluginId: string; error: string }>;
}

export interface HistoryQueryInput {
  meetingId?: string;
  attendeePeerId?: string;
  guestEmail?: string;
  query?: string;
  status?: 'live' | 'adjourned' | 'all';
  startedAfter?: number;
  startedBefore?: number;
  limit?: number;
  cursor?: string;
  includeTranscript?: boolean;
  includeAttendees?: boolean;
  includeArtefacts?: boolean;
}

export interface MintInviteInput {
  meetingId: string;
  expiresAt: number;
  maxUses?: number;
  createdBy?: string;
}

export interface MintInviteResult {
  inviteToken: string;
  url: string;
  /**
   * 6-digit numeric PIN paired with the URL token. Same expiresAt and
   * maxUses budget. Pair it with `joinPageUrl` for out-of-band
   * (phone / voice) handoff: "go to <joinPageUrl>, enter meeting id X,
   * PIN Y-Y-Y-Y-Y-Y". Hub returns this field from v0.2 onward; older
   * Hub builds omit it and clients should treat it as optional.
   */
  accessPin?: string;
  /** Hub's landing-page URL (`<publicUrl>/join`). Pair with accessPin. */
  joinPageUrl?: string;
  expiresAt: number;
}

export class HubBridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connecting = false;
  private connectedOnce = false;
  private reconnectAttempts = 0;
  private welcome: WelcomePayload | null = null;
  private pending = new Map<string, PendingReply>();
  private pendingStream = new Map<string, PendingStream>();
  /**
   * Client-side keepalive. Cloudflare (and most WSS proxies) close an
   * idle WebSocket after ~100s of no frames in EITHER direction. A bridge
   * that just sits "standing by" (agent minted a share link, waiting for a
   * guest) would otherwise drop — and the Hub would report the agent as
   * offline to guests until the next reconnect. Sending a ping frame every
   * 30s keeps the connection (and the Hub's `bridgeLive` flag) alive.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatMs = 30_000;
  /** Last server event id we acknowledged seeing; sent on resume. */
  private lastServerEventId: string | null = null;
  private installationId: string;
  private agentDisplayName: string;
  /** Cached after first resolution; cleared on hard auth failure so a
   *  follow-on connect re-runs the source (e.g. re-enroll after token
   *  rotation). */
  private resolvedToken: string | null = null;
  private readonly tokenSource: () => Promise<string>;
  /**
   * `${meetingId}:${turnId}` → timestamp for narration clips the Hub has
   * reported finished playing (`bridge.meeting.narration-complete`). Recorded
   * unconditionally so `waitForNarration` resolves even when the signal
   * arrives BEFORE the agent calls await (common — synth + playback can beat
   * the agent's next tool call). Pruned past 5 min.
   */
  private narrationDone = new Map<string, number>();

  constructor(
    private readonly config: ConfigSchemaT,
    private readonly hostInfo: {
      installationId: string;
      agentDisplayName: string;
      serverVersion: string;
      platform?: 'win32' | 'darwin' | 'linux';
      nodeVersion?: string;
      swarmaiVersion?: string;
    },
    private readonly logger: {
      info: (msg: string, fields?: Record<string, unknown>) => void;
      warn: (msg: string, fields?: Record<string, unknown>) => void;
      error: (msg: string, fields?: Record<string, unknown>) => void;
    },
    /**
     * Lazy token source. When omitted, falls back to `config.token`.
     * The plugin's pluginEntry wires this with an enrollment-aware
     * resolver so the bridge can self-enroll on first connect.
     * Called once per connect; cached between connects.
     */
    tokenSource?: () => Promise<string>,
  ) {
    super();
    this.installationId = hostInfo.installationId;
    this.agentDisplayName = hostInfo.agentDisplayName;
    this.tokenSource =
      tokenSource ??
      (async (): Promise<string> => {
        if (!config.token) {
          throw new Error(
            'no bridge token: provide config.token, config.bootstrapSecret, ' +
              'or env SWARMAI_HUB_BOOTSTRAP_SECRET',
          );
        }
        return config.token;
      });

    // Record narration-complete signals as they arrive (broadcast frames are
    // re-emitted by `type`). This persists the completion so a later
    // `waitForNarration` call still sees it — see the field comment.
    this.on('bridge.meeting.narration-complete', (frame: unknown) => {
      const f = frame as { meetingId?: string; turnId?: string } | null;
      if (f && typeof f.meetingId === 'string' && typeof f.turnId === 'string') {
        const now = Date.now();
        this.narrationDone.set(`${f.meetingId}:${f.turnId}`, now);
        if (this.narrationDone.size > 500) {
          for (const [k, ts] of this.narrationDone) {
            if (now - ts > 300_000) this.narrationDone.delete(k);
          }
        }
      }
    });
  }

  /**
   * Wait until the Hub reports a turn's TTS narration has finished playing
   * (or skipped, or no-audience). Lets `main` pace itself: post a turn → await
   * its narration → dispatch the next agent, so several agents don't narrate
   * over each other. Resolves immediately if the signal already arrived.
   * Always resolves (never rejects/hangs): `{ completed: false, timedOut: true }`
   * after `timeoutMs` so a lost signal can't stall the meeting.
   */
  async waitForNarration(
    meetingId: string,
    turnId: string,
    timeoutMs = 45_000,
  ): Promise<{ completed: boolean; timedOut?: boolean }> {
    const key = `${meetingId}:${turnId}`;
    if (this.narrationDone.has(key)) return { completed: true };
    return new Promise((resolve) => {
      let settled = false;
      const onFrame = (frame: unknown): void => {
        const f = frame as { meetingId?: string; turnId?: string } | null;
        if (settled || !f || f.meetingId !== meetingId || f.turnId !== turnId) return;
        settled = true;
        clearTimeout(timer);
        this.off('bridge.meeting.narration-complete', onFrame);
        resolve({ completed: true });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.off('bridge.meeting.narration-complete', onFrame);
        resolve({ completed: false, timedOut: true });
      }, timeoutMs);
      this.on('bridge.meeting.narration-complete', onFrame);
    });
  }

  /** Force the next connect to re-resolve the token. Used after a 4401 close. */
  invalidateToken(): void {
    this.resolvedToken = null;
  }

  /**
   * Open the connection if not already open. Resolves once we've received
   * `bridge.welcome` (or rejects on hard close codes 4401/4402/4451).
   */
  async ensureConnected(): Promise<WelcomePayload> {
    if (this.welcome && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.welcome;
    }
    if (this.connecting) {
      return new Promise((resolve, reject) => {
        this.once('welcome', resolve);
        this.once('hard-error', reject);
      });
    }
    this.connecting = true;
    return this.connect();
  }

  /**
   * Send a frame and wait for a reply with `refersToId === request.id`
   * AND `type === expectedReplyType`. Times out after `timeoutMs`.
   */
  async request<TReply>(
    frame: Record<string, unknown> & { type: string },
    expectedReplyType: string,
    timeoutMs = 30_000,
  ): Promise<TReply> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('bridge not connected');
    }
    const id = randomUUID();
    const at = Date.now();
    const wire = { ...frame, v: 1, id, at };
    return new Promise<TReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge timeout waiting for ${expectedReplyType}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (f) => resolve(f as unknown as TReply),
        reject,
        expectedReplyType,
        timer,
      });
      try {
        this.ws!.send(JSON.stringify(wire));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire-and-forget send (no reply expected). */
  sendOneway(frame: Record<string, unknown> & { type: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const wire = { ...frame, v: 1, id: randomUUID(), at: Date.now() };
    try {
      this.ws.send(JSON.stringify(wire));
    } catch {
      /* swallow */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* close/error handlers own reconnect */
        }
      }
    }, this.heartbeatMs);
    // Don't keep the event loop alive just for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }
    this.welcome = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge shutting down'));
    }
    this.pending.clear();
    for (const s of this.pendingStream.values()) {
      s.onError(new Error('bridge shutting down'));
    }
    this.pendingStream.clear();
  }

  // ------------------------------------------------------------------
  // Public imperative API — consumed by `createHubBridge(...)` so the
  // CEO Agent host can wire a `hubBridge` accessor into MeetingsApiDeps
  // without going through the plugin-loader path. Each method assumes
  // the bridge will be reachable; ephemeral disconnects surface as
  // promise rejections rather than hard errors.
  // ------------------------------------------------------------------

  /** True iff the WSS is open AND we've received the `bridge.welcome`. */
  get isConnected(): boolean {
    return this.welcome !== null && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to the `bridge.welcome` event. Fires once per (re)connection. */
  onWelcome(cb: (welcome: WelcomePayload) => void): () => void {
    const wrap = (w: WelcomePayload): void => cb(w);
    this.on('welcome', wrap);
    if (this.welcome) cb(this.welcome);
    return () => this.off('welcome', wrap);
  }

  /** Mint a share-link invite. Single round-trip. */
  async mintInvite(input: MintInviteInput): Promise<MintInviteResult> {
    const frame: Record<string, unknown> & { type: string } = {
      type: 'bridge.invite.mint',
      meetingId: input.meetingId,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy ?? 'main',
    };
    if (input.maxUses !== undefined) frame['maxUses'] = input.maxUses;
    return this.request<MintInviteResult>(frame, 'bridge.invite.minted');
  }

  /**
   * Push per-tenant plugin configuration to the Hub (provider keys, models,
   * voices, enable toggles). The Hub stores it encrypted under the tenant
   * vault and applies it on the next plugin invocation — no restart. Single
   * round-trip; resolves with the Hub's per-plugin {enabled, configured}
   * verdict. Secrets are never echoed back in the ack.
   */
  async setPluginConfig(configs: PluginConfigEntry[]): Promise<PluginConfigAck> {
    return this.request<PluginConfigAck>(
      { type: 'bridge.plugin.config.set', configs },
      'bridge.plugin.config.ack',
    );
  }

  /** Query the Hub-side meeting archive. Single round-trip. */
  async queryHistory(input: HistoryQueryInput): Promise<{
    total: number;
    meetings: Array<Record<string, unknown>>;
    nextCursor?: string;
  }> {
    return this.request(
      { type: 'bridge.meeting.history.query', ...input },
      'bridge.meeting.history.result',
    );
  }

  /**
   * Fetch an artefact's bytes from the Hub. The Hub answers with a
   * chunked sequence of `bridge.artefact.fetch-reply` frames
   * (`phase: 'begin' | 'chunk' | 'end' | 'error'`); we accumulate the
   * base64 chunks and resolve with the assembled buffer + metadata.
   * Hard 60s ceiling per fetch — large transfers should be paginated
   * at the application layer rather than relying on a longer ceiling.
   */
  async fetchArtefact(meetingId: string, artefactId: string): Promise<FetchArtefactResult> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('bridge not connected');
    }
    const id = randomUUID();
    return new Promise<FetchArtefactResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let mime = 'application/octet-stream';
      let filename: string | undefined;
      const timer = setTimeout(() => {
        this.pendingStream.delete(id);
        reject(new Error(`bridge timeout waiting for artefact ${artefactId}`));
      }, 60_000);
      this.pendingStream.set(id, {
        onFrame: (frame): 'continue' | 'done' => {
          const phase = frame['phase'] as string | undefined;
          if (phase === 'begin') {
            mime = (frame['mime'] as string) ?? mime;
            filename = (frame['label'] as string | undefined) ?? `artefact-${artefactId}`;
            return 'continue';
          }
          if (phase === 'chunk') {
            const dataB64 = frame['dataB64'] as string | undefined;
            if (dataB64) chunks.push(Buffer.from(dataB64, 'base64'));
            return 'continue';
          }
          if (phase === 'end') {
            clearTimeout(timer);
            resolve({
              body: Buffer.concat(chunks),
              mime,
              filename: filename ?? `artefact-${artefactId}`,
            });
            return 'done';
          }
          if (phase === 'error') {
            clearTimeout(timer);
            reject(new Error((frame['errorMessage'] as string) ?? 'fetch failed'));
            return 'done';
          }
          // Unknown phase — keep listening but log it.
          this.logger.warn('unknown fetch-reply phase', { phase, artefactId });
          return 'continue';
        },
        onError: (err): void => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const wire = {
        type: 'bridge.artefact.fetch',
        v: 1,
        id,
        at: Date.now(),
        meetingId,
        artefactId,
      };
      try {
        this.ws!.send(JSON.stringify(wire));
      } catch (err) {
        clearTimeout(timer);
        this.pendingStream.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Upload a file's bytes to the Hub (chunked). Used by the host to
   * mirror agent/operator-shared `file://` / `data:` artefacts so guests
   * can download them AND so a deck can be driven via `openPresentation`.
   * Reuses the caller's `artefactId` (the Hub's upload-begin handler
   * honours a client-supplied id), so a follow-on present.open addresses
   * the same file with no id translation.
   *
   * Wire sequence: upload-begin (await upload-ready) → upload-chunk* →
   * upload-end (await upload-acked). Bytes are sha256-checked Hub-side.
   */
  async uploadArtefact(input: {
    meetingId: string;
    artefactId: string;
    bytes: Buffer;
    mime: string;
    label?: string;
    sharedBy: string;
  }): Promise<{ ok: true; artefactId: string }> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('bridge not connected');
    }
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const beginFrame: Record<string, unknown> & { type: string } = {
      type: 'bridge.artefact.upload-begin',
      meetingId: input.meetingId,
      artefactId: input.artefactId,
      mime: input.mime,
      sizeBytes: input.bytes.byteLength,
      sharedBy: input.sharedBy,
      sha256,
    };
    if (input.label !== undefined) beginFrame['label'] = input.label;
    await this.request(beginFrame, 'bridge.artefact.upload-ready', 30_000);

    // 256 KB binary chunks → ~341 KB base64, comfortably under the Hub's
    // 2 MB per-chunk schema cap. Sent fire-and-forget in order; the WSS
    // preserves frame order and the Hub validates seq + sha256 on end.
    const CHUNK = 256 * 1024;
    let seq = 0;
    for (let off = 0; off < input.bytes.byteLength; off += CHUNK) {
      const slice = input.bytes.subarray(off, Math.min(off + CHUNK, input.bytes.byteLength));
      this.sendOneway({
        type: 'bridge.artefact.upload-chunk',
        meetingId: input.meetingId,
        artefactId: input.artefactId,
        seq,
        dataB64: slice.toString('base64'),
      });
      seq++;
      // Light backpressure so a large deck doesn't balloon the socket
      // send buffer unbounded.
      if (this.ws.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    await this.request(
      {
        type: 'bridge.artefact.upload-end',
        meetingId: input.meetingId,
        artefactId: input.artefactId,
        totalChunks: seq,
      },
      'bridge.artefact.upload-acked',
      60_000,
    );
    return { ok: true, artefactId: input.artefactId };
  }

  /**
   * Fire-and-forget composing/"typing" presence. The host calls this when
   * the main agent starts/stops drafting a reply to a guest turn; the Hub
   * fans it to guests as a transient "X is typing…" indicator.
   */
  publishTyping(input: {
    meetingId: string;
    peerId: string;
    displayName?: string;
    state: 'start' | 'stop';
  }): void {
    const frame: Record<string, unknown> & { type: string } = {
      type: 'bridge.meeting.typing',
      meetingId: input.meetingId,
      peerId: input.peerId,
      state: input.state,
    };
    if (input.displayName !== undefined) frame['displayName'] = input.displayName;
    this.sendOneway(frame);
  }

  // ---------------------------------------------------------------

  private async connect(): Promise<WelcomePayload> {
    if (!this.resolvedToken) {
      this.resolvedToken = await this.tokenSource();
    }
    const token = this.resolvedToken;
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(this.config.url, {
        headers: { authorization: `Bearer ${token}` },
      });
      this.ws = ws;

      let helloed = false;

      ws.once('open', () => {
        const helloFrame: Record<string, unknown> = {
          type: 'bridge.hello',
          v: 1,
          id: randomUUID(),
          at: Date.now(),
          agentInstallationId: this.installationId,
          agentDisplayName: this.agentDisplayName,
          serverVersion: this.hostInfo.serverVersion,
        };
        if (this.lastServerEventId) helloFrame['resume'] = this.lastServerEventId;
        if (this.hostInfo.platform || this.hostInfo.nodeVersion || this.hostInfo.swarmaiVersion) {
          helloFrame['hostInfo'] = {
            ...(this.hostInfo.platform ? { platform: this.hostInfo.platform } : {}),
            ...(this.hostInfo.nodeVersion ? { nodeVersion: this.hostInfo.nodeVersion } : {}),
            ...(this.hostInfo.swarmaiVersion
              ? { swarmaiVersion: this.hostInfo.swarmaiVersion }
              : {}),
          };
        }
        ws.send(JSON.stringify(helloFrame));
        helloed = true;
        // Start the keepalive once the socket is open. Cleared in the
        // 'close' handler + stop(). Ping failures are swallowed — the
        // 'close'/'error' handlers own reconnect.
        this.startHeartbeat();
      });

      ws.on('message', (raw: WebSocket.Data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = frame['type'] as string | undefined;
        if (!type) return;

        if (type === 'bridge.welcome') {
          this.welcome = frame as unknown as WelcomePayload;
          this.connectedOnce = true;
          this.connecting = false;
          this.reconnectAttempts = 0;
          this.logger.info('bridge connected', {
            tenantSlug: this.welcome.tenantSlug,
            tenantDisplayName: this.welcome.tenantDisplayName,
          });
          if (
            this.config.expectedTenantSlug &&
            this.welcome.tenantSlug !== this.config.expectedTenantSlug
          ) {
            this.logger.warn(
              'tenant slug mismatch — bridge token may belong to a different tenant',
              {
                expected: this.config.expectedTenantSlug,
                actual: this.welcome.tenantSlug,
              },
            );
          }
          this.emit('welcome', this.welcome);
          resolveConnect(this.welcome);
          return;
        }

        if (type === 'bridge.resume-failed') {
          this.lastServerEventId = null;
          this.logger.warn('bridge resume cursor too old; CEO Agent should re-send snapshots');
          this.emit('resume-failed');
          return;
        }

        // Track the server event id for resume.
        const serverEventId = (frame as { serverEventId?: string }).serverEventId;
        if (typeof serverEventId === 'string') this.lastServerEventId = serverEventId;

        // Match request/reply.
        const refersToId = frame['refersToId'] as string | undefined;
        if (refersToId) {
          // Streaming replies take precedence — fetchArtefact and any
          // future multi-frame correlator register here. The handler
          // controls when to release the slot via 'done', so chunks
          // accumulate without each frame consuming the registration.
          const stream = this.pendingStream.get(refersToId);
          if (stream) {
            if (type === 'bridge.error') {
              this.pendingStream.delete(refersToId);
              stream.onError(
                new Error(
                  `bridge error: ${(frame['code'] as string) ?? 'unknown'} — ${
                    (frame['detail'] as string) ?? ''
                  }`,
                ),
              );
              return;
            }
            const verdict = stream.onFrame(frame);
            if (verdict === 'done') this.pendingStream.delete(refersToId);
            return;
          }
          const pending = this.pending.get(refersToId);
          if (pending) {
            this.pending.delete(refersToId);
            clearTimeout(pending.timer);
            if (type === 'bridge.error') {
              pending.reject(
                new Error(
                  `bridge error: ${(frame['code'] as string) ?? 'unknown'} — ${
                    (frame['detail'] as string) ?? ''
                  }`,
                ),
              );
            } else if (type === pending.expectedReplyType) {
              pending.resolve(frame);
            } else {
              pending.reject(new Error(`unexpected reply type ${type} for ${refersToId}`));
            }
            return;
          }
        }

        // Forward broadcast events to interested listeners.
        this.emit(type, frame);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString('utf8');
        this.logger.warn('bridge closed', { code, reason: reasonStr });
        this.stopHeartbeat();
        this.welcome = null;
        this.ws = null;

        // Hard-error close codes — never reconnect.
        if (code === 4401 || code === 4402 || code === 4451) {
          const err = new Error(`bridge closed with hard code ${code}: ${reasonStr}`);
          this.connecting = false;
          this.emit('hard-error', err);
          if (!this.connectedOnce && !helloed) rejectConnect(err);
          return;
        }

        // Soft errors — schedule reconnect.
        const delay = backoff(
          this.reconnectAttempts++,
          this.config.reconnectInitialMs ?? 1000,
          this.config.reconnectMaxMs ?? 60_000,
        );
        this.logger.info('reconnecting', { delayMs: delay, attempt: this.reconnectAttempts });
        setTimeout(() => {
          this.connecting = true;
          this.connect().catch((err) => {
            this.logger.error('reconnect failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, delay).unref();
      });

      ws.on('error', (err: Error) => {
        this.logger.error('bridge ws error', { error: err.message });
        // The 'close' handler will fire next and handle reconnect.
        if (!this.connectedOnce && !helloed) rejectConnect(err);
      });
    });
  }
}

function backoff(attempt: number, initial: number, max: number): number {
  const base = Math.min(initial * Math.pow(2, attempt), max);
  const jitter = Math.random() * 0.2 * base; // ±20%
  return Math.round(base + (Math.random() < 0.5 ? -jitter : jitter));
}
