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

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ConfigSchemaT } from './config-schema.js';

interface PendingReply {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  expectedReplyType: string;
  timer: NodeJS.Timeout;
}

export interface WelcomePayload {
  hubVersion: string;
  serverEventId: string;
  resumeOk: boolean;
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
}

export class HubBridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connecting = false;
  private connectedOnce = false;
  private reconnectAttempts = 0;
  private welcome: WelcomePayload | null = null;
  private pending = new Map<string, PendingReply>();
  /** Last server event id we acknowledged seeing; sent on resume. */
  private lastServerEventId: string | null = null;
  private installationId: string;
  private agentDisplayName: string;

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
  ) {
    super();
    this.installationId = hostInfo.installationId;
    this.agentDisplayName = hostInfo.agentDisplayName;
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

  async stop(): Promise<void> {
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
  }

  // ---------------------------------------------------------------

  private connect(): Promise<WelcomePayload> {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(this.config.url, {
        headers: { authorization: `Bearer ${this.config.token}` },
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
