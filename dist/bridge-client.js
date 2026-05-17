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
export class HubBridgeClient extends EventEmitter {
    config;
    hostInfo;
    logger;
    ws = null;
    connecting = false;
    connectedOnce = false;
    reconnectAttempts = 0;
    welcome = null;
    pending = new Map();
    pendingStream = new Map();
    /** Last server event id we acknowledged seeing; sent on resume. */
    lastServerEventId = null;
    installationId;
    agentDisplayName;
    /** Cached after first resolution; cleared on hard auth failure so a
     *  follow-on connect re-runs the source (e.g. re-enroll after token
     *  rotation). */
    resolvedToken = null;
    tokenSource;
    constructor(config, hostInfo, logger, 
    /**
     * Lazy token source. When omitted, falls back to `config.token`.
     * The plugin's pluginEntry wires this with an enrollment-aware
     * resolver so the bridge can self-enroll on first connect.
     * Called once per connect; cached between connects.
     */
    tokenSource) {
        super();
        this.config = config;
        this.hostInfo = hostInfo;
        this.logger = logger;
        this.installationId = hostInfo.installationId;
        this.agentDisplayName = hostInfo.agentDisplayName;
        this.tokenSource =
            tokenSource ??
                (async () => {
                    if (!config.token) {
                        throw new Error('no bridge token: provide config.token, config.bootstrapSecret, ' +
                            'or env SWARMAI_HUB_BOOTSTRAP_SECRET');
                    }
                    return config.token;
                });
    }
    /** Force the next connect to re-resolve the token. Used after a 4401 close. */
    invalidateToken() {
        this.resolvedToken = null;
    }
    /**
     * Open the connection if not already open. Resolves once we've received
     * `bridge.welcome` (or rejects on hard close codes 4401/4402/4451).
     */
    async ensureConnected() {
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
    async request(frame, expectedReplyType, timeoutMs = 30_000) {
        await this.ensureConnected();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('bridge not connected');
        }
        const id = randomUUID();
        const at = Date.now();
        const wire = { ...frame, v: 1, id, at };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`bridge timeout waiting for ${expectedReplyType}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (f) => resolve(f),
                reject,
                expectedReplyType,
                timer,
            });
            try {
                this.ws.send(JSON.stringify(wire));
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    /** Fire-and-forget send (no reply expected). */
    sendOneway(frame) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const wire = { ...frame, v: 1, id: randomUUID(), at: Date.now() };
        try {
            this.ws.send(JSON.stringify(wire));
        }
        catch {
            /* swallow */
        }
    }
    async stop() {
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
    get isConnected() {
        return this.welcome !== null && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    /** Subscribe to the `bridge.welcome` event. Fires once per (re)connection. */
    onWelcome(cb) {
        const wrap = (w) => cb(w);
        this.on('welcome', wrap);
        if (this.welcome)
            cb(this.welcome);
        return () => this.off('welcome', wrap);
    }
    /** Mint a share-link invite. Single round-trip. */
    async mintInvite(input) {
        const frame = {
            type: 'bridge.invite.mint',
            meetingId: input.meetingId,
            expiresAt: input.expiresAt,
            createdBy: input.createdBy ?? 'main',
        };
        if (input.maxUses !== undefined)
            frame['maxUses'] = input.maxUses;
        return this.request(frame, 'bridge.invite.minted');
    }
    /** Query the Hub-side meeting archive. Single round-trip. */
    async queryHistory(input) {
        return this.request({ type: 'bridge.meeting.history.query', ...input }, 'bridge.meeting.history.result');
    }
    /**
     * Fetch an artefact's bytes from the Hub. The Hub answers with a
     * chunked sequence of `bridge.artefact.fetch-reply` frames
     * (`phase: 'begin' | 'chunk' | 'end' | 'error'`); we accumulate the
     * base64 chunks and resolve with the assembled buffer + metadata.
     * Hard 60s ceiling per fetch — large transfers should be paginated
     * at the application layer rather than relying on a longer ceiling.
     */
    async fetchArtefact(meetingId, artefactId) {
        await this.ensureConnected();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('bridge not connected');
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const chunks = [];
            let mime = 'application/octet-stream';
            let filename;
            const timer = setTimeout(() => {
                this.pendingStream.delete(id);
                reject(new Error(`bridge timeout waiting for artefact ${artefactId}`));
            }, 60_000);
            this.pendingStream.set(id, {
                onFrame: (frame) => {
                    const phase = frame['phase'];
                    if (phase === 'begin') {
                        mime = frame['mime'] ?? mime;
                        filename = frame['label'] ?? `artefact-${artefactId}`;
                        return 'continue';
                    }
                    if (phase === 'chunk') {
                        const dataB64 = frame['dataB64'];
                        if (dataB64)
                            chunks.push(Buffer.from(dataB64, 'base64'));
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
                        reject(new Error(frame['errorMessage'] ?? 'fetch failed'));
                        return 'done';
                    }
                    // Unknown phase — keep listening but log it.
                    this.logger.warn('unknown fetch-reply phase', { phase, artefactId });
                    return 'continue';
                },
                onError: (err) => {
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
                this.ws.send(JSON.stringify(wire));
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingStream.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    // ---------------------------------------------------------------
    async connect() {
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
                const helloFrame = {
                    type: 'bridge.hello',
                    v: 1,
                    id: randomUUID(),
                    at: Date.now(),
                    agentInstallationId: this.installationId,
                    agentDisplayName: this.agentDisplayName,
                    serverVersion: this.hostInfo.serverVersion,
                };
                if (this.lastServerEventId)
                    helloFrame['resume'] = this.lastServerEventId;
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
            ws.on('message', (raw) => {
                let frame;
                try {
                    frame = JSON.parse(String(raw));
                }
                catch {
                    return;
                }
                const type = frame['type'];
                if (!type)
                    return;
                if (type === 'bridge.welcome') {
                    this.welcome = frame;
                    this.connectedOnce = true;
                    this.connecting = false;
                    this.reconnectAttempts = 0;
                    this.logger.info('bridge connected', {
                        tenantSlug: this.welcome.tenantSlug,
                        tenantDisplayName: this.welcome.tenantDisplayName,
                    });
                    if (this.config.expectedTenantSlug &&
                        this.welcome.tenantSlug !== this.config.expectedTenantSlug) {
                        this.logger.warn('tenant slug mismatch — bridge token may belong to a different tenant', {
                            expected: this.config.expectedTenantSlug,
                            actual: this.welcome.tenantSlug,
                        });
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
                const serverEventId = frame.serverEventId;
                if (typeof serverEventId === 'string')
                    this.lastServerEventId = serverEventId;
                // Match request/reply.
                const refersToId = frame['refersToId'];
                if (refersToId) {
                    // Streaming replies take precedence — fetchArtefact and any
                    // future multi-frame correlator register here. The handler
                    // controls when to release the slot via 'done', so chunks
                    // accumulate without each frame consuming the registration.
                    const stream = this.pendingStream.get(refersToId);
                    if (stream) {
                        if (type === 'bridge.error') {
                            this.pendingStream.delete(refersToId);
                            stream.onError(new Error(`bridge error: ${frame['code'] ?? 'unknown'} — ${frame['detail'] ?? ''}`));
                            return;
                        }
                        const verdict = stream.onFrame(frame);
                        if (verdict === 'done')
                            this.pendingStream.delete(refersToId);
                        return;
                    }
                    const pending = this.pending.get(refersToId);
                    if (pending) {
                        this.pending.delete(refersToId);
                        clearTimeout(pending.timer);
                        if (type === 'bridge.error') {
                            pending.reject(new Error(`bridge error: ${frame['code'] ?? 'unknown'} — ${frame['detail'] ?? ''}`));
                        }
                        else if (type === pending.expectedReplyType) {
                            pending.resolve(frame);
                        }
                        else {
                            pending.reject(new Error(`unexpected reply type ${type} for ${refersToId}`));
                        }
                        return;
                    }
                }
                // Forward broadcast events to interested listeners.
                this.emit(type, frame);
            });
            ws.on('close', (code, reason) => {
                const reasonStr = reason.toString('utf8');
                this.logger.warn('bridge closed', { code, reason: reasonStr });
                this.welcome = null;
                this.ws = null;
                // Hard-error close codes — never reconnect.
                if (code === 4401 || code === 4402 || code === 4451) {
                    const err = new Error(`bridge closed with hard code ${code}: ${reasonStr}`);
                    this.connecting = false;
                    this.emit('hard-error', err);
                    if (!this.connectedOnce && !helloed)
                        rejectConnect(err);
                    return;
                }
                // Soft errors — schedule reconnect.
                const delay = backoff(this.reconnectAttempts++, this.config.reconnectInitialMs ?? 1000, this.config.reconnectMaxMs ?? 60_000);
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
            ws.on('error', (err) => {
                this.logger.error('bridge ws error', { error: err.message });
                // The 'close' handler will fire next and handle reconnect.
                if (!this.connectedOnce && !helloed)
                    rejectConnect(err);
            });
        });
    }
}
function backoff(attempt, initial, max) {
    const base = Math.min(initial * Math.pow(2, attempt), max);
    const jitter = Math.random() * 0.2 * base; // ±20%
    return Math.round(base + (Math.random() < 0.5 ? -jitter : jitter));
}
//# sourceMappingURL=bridge-client.js.map