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
    /** Last server event id we acknowledged seeing; sent on resume. */
    private lastServerEventId;
    private installationId;
    private agentDisplayName;
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
    });
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
    private connect;
}
//# sourceMappingURL=bridge-client.d.ts.map