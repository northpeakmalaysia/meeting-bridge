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
import { EventEmitter } from 'node:events';
import type { ConfigSchemaT } from './config-schema.js';
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
    applied: Array<{
        pluginId: string;
        enabled: boolean;
        configured: boolean;
    }>;
    errors?: Array<{
        pluginId: string;
        error: string;
    }>;
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
export declare class HubBridgeClient extends EventEmitter {
    private readonly config;
    private readonly hostInfo;
    private readonly logger;
    private ws;
    private connecting;
    private connectedOnce;
    private reconnectAttempts;
    private welcome;
    private pending;
    private pendingStream;
    /**
     * Client-side keepalive. Cloudflare (and most WSS proxies) close an
     * idle WebSocket after ~100s of no frames in EITHER direction. A bridge
     * that just sits "standing by" (agent minted a share link, waiting for a
     * guest) would otherwise drop — and the Hub would report the agent as
     * offline to guests until the next reconnect. Sending a ping frame every
     * 30s keeps the connection (and the Hub's `bridgeLive` flag) alive.
     */
    private heartbeatTimer;
    private readonly heartbeatMs;
    /** Last server event id we acknowledged seeing; sent on resume. */
    private lastServerEventId;
    private installationId;
    private agentDisplayName;
    /** Cached after first resolution; cleared on hard auth failure so a
     *  follow-on connect re-runs the source (e.g. re-enroll after token
     *  rotation). */
    private resolvedToken;
    private readonly tokenSource;
    /**
     * `${meetingId}:${turnId}` → timestamp for narration clips the Hub has
     * reported finished playing (`bridge.meeting.narration-complete`). Recorded
     * unconditionally so `waitForNarration` resolves even when the signal
     * arrives BEFORE the agent calls await (common — synth + playback can beat
     * the agent's next tool call). Pruned past 5 min.
     */
    private narrationDone;
    constructor(config: ConfigSchemaT, hostInfo: {
        installationId: string;
        agentDisplayName: string;
        serverVersion: string;
        platform?: 'win32' | 'darwin' | 'linux';
        nodeVersion?: string;
        swarmaiVersion?: string;
    }, logger: {
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
    tokenSource?: () => Promise<string>);
    /**
     * Wait until the Hub reports a turn's TTS narration has finished playing
     * (or skipped, or no-audience). Lets `main` pace itself: post a turn → await
     * its narration → dispatch the next agent, so several agents don't narrate
     * over each other. Resolves immediately if the signal already arrived.
     * Always resolves (never rejects/hangs): `{ completed: false, timedOut: true }`
     * after `timeoutMs` so a lost signal can't stall the meeting.
     */
    waitForNarration(meetingId: string, turnId: string, timeoutMs?: number): Promise<{
        completed: boolean;
        timedOut?: boolean;
    }>;
    /** Force the next connect to re-resolve the token. Used after a 4401 close. */
    invalidateToken(): void;
    /**
     * Open the connection if not already open. Resolves once we've received
     * `bridge.welcome` (or rejects on hard close codes 4401/4402/4451).
     */
    ensureConnected(): Promise<WelcomePayload>;
    /**
     * Send a frame and wait for a reply with `refersToId === request.id`
     * AND `type === expectedReplyType`. Times out after `timeoutMs`.
     */
    request<TReply>(frame: Record<string, unknown> & {
        type: string;
    }, expectedReplyType: string, timeoutMs?: number): Promise<TReply>;
    /** Fire-and-forget send (no reply expected). */
    sendOneway(frame: Record<string, unknown> & {
        type: string;
    }): void;
    private startHeartbeat;
    private stopHeartbeat;
    stop(): Promise<void>;
    /** True iff the WSS is open AND we've received the `bridge.welcome`. */
    get isConnected(): boolean;
    /** Subscribe to the `bridge.welcome` event. Fires once per (re)connection. */
    onWelcome(cb: (welcome: WelcomePayload) => void): () => void;
    /** Mint a share-link invite. Single round-trip. */
    mintInvite(input: MintInviteInput): Promise<MintInviteResult>;
    /**
     * Push per-tenant plugin configuration to the Hub (provider keys, models,
     * voices, enable toggles). The Hub stores it encrypted under the tenant
     * vault and applies it on the next plugin invocation — no restart. Single
     * round-trip; resolves with the Hub's per-plugin {enabled, configured}
     * verdict. Secrets are never echoed back in the ack.
     */
    setPluginConfig(configs: PluginConfigEntry[]): Promise<PluginConfigAck>;
    /** Query the Hub-side meeting archive. Single round-trip. */
    queryHistory(input: HistoryQueryInput): Promise<{
        total: number;
        meetings: Array<Record<string, unknown>>;
        nextCursor?: string;
    }>;
    /**
     * Fetch an artefact's bytes from the Hub. The Hub answers with a
     * chunked sequence of `bridge.artefact.fetch-reply` frames
     * (`phase: 'begin' | 'chunk' | 'end' | 'error'`); we accumulate the
     * base64 chunks and resolve with the assembled buffer + metadata.
     * Hard 60s ceiling per fetch — large transfers should be paginated
     * at the application layer rather than relying on a longer ceiling.
     */
    fetchArtefact(meetingId: string, artefactId: string): Promise<FetchArtefactResult>;
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
    uploadArtefact(input: {
        meetingId: string;
        artefactId: string;
        bytes: Buffer;
        mime: string;
        label?: string;
        sharedBy: string;
    }): Promise<{
        ok: true;
        artefactId: string;
    }>;
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
    }): void;
    private connect;
}
//# sourceMappingURL=bridge-client.d.ts.map