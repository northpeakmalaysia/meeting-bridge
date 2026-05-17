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
    /** Last server event id we acknowledged seeing; sent on resume. */
    private lastServerEventId;
    private installationId;
    private agentDisplayName;
    /** Cached after first resolution; cleared on hard auth failure so a
     *  follow-on connect re-runs the source (e.g. re-enroll after token
     *  rotation). */
    private resolvedToken;
    private readonly tokenSource;
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
    stop(): Promise<void>;
    /** True iff the WSS is open AND we've received the `bridge.welcome`. */
    get isConnected(): boolean;
    /** Subscribe to the `bridge.welcome` event. Fires once per (re)connection. */
    onWelcome(cb: (welcome: WelcomePayload) => void): () => void;
    /** Mint a share-link invite. Single round-trip. */
    mintInvite(input: MintInviteInput): Promise<MintInviteResult>;
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
    private connect;
}
//# sourceMappingURL=bridge-client.d.ts.map