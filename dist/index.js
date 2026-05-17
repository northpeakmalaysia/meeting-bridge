/**
 * @swarmai/meeting-bridge — SwarmAI plugin entrypoint.
 *
 * Registers the `swarm_admin.meeting.*` family of tools that proxy to a
 * SwarmAI Meeting Hub. The plugin holds a single persistent WSS to the
 * Hub; tool handlers send request frames and await replies.
 *
 * Wire-up:
 *   1. `pluginEntry(api, rawConfig)` is called by the SwarmAI plugin
 *      loader at boot.
 *   2. Config is validated with zod (clear errors on operator typo).
 *   3. The bridge client is constructed lazily — first tool call opens
 *      the WSS.
 *   4. Each tool returns a typed JSON object matching the Hub reply.
 *
 * Why pluggable: this lives outside the CEO Agent monorepo so the Hub
 * integration can ship + version independently. Operators install (or
 * upgrade) from the SwarmAI Hub pane without rebuilding the CEO Agent.
 */
import { z } from 'zod';
import { ConfigSchema } from './config-schema.js';
import { HubBridgeClient, } from './bridge-client.js';
const PLUGIN_ID = '@swarmai/meeting-bridge';
const PLUGIN_VERSION = '0.1.0';
/**
 * Identity loader: the CEO Agent stores `agentInstallationId` in
 * `<workspace>/.swarmai/installation-id`. We can't import the host's
 * private packages from a plugin, so we read the file ourselves at
 * boot. Falls back to a process-stable random UUID if absent so the
 * plugin doesn't refuse to load on an out-of-the-box install (the Hub
 * connect will then close 4402 — operator runs `swarmai hub-id` and
 * pastes it into the installation-id file).
 */
function loadInstallationId() {
    try {
        // Lazy require to keep this side-effect-free at module load.
        // Using node:fs directly because plugins can't reach into host code.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('node:path');
        const candidate = path.join(process.cwd(), '.swarmai', 'installation-id');
        if (fs.existsSync(candidate)) {
            const text = fs.readFileSync(candidate, 'utf8').trim();
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
                return text;
            }
        }
    }
    catch {
        // ignore
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto');
    return crypto.randomUUID();
}
function makeLogger(api) {
    const anyApi = api;
    if (anyApi.logger)
        return anyApi.logger;
    if (anyApi.log)
        return anyApi.log;
    return {
        info: (m, f) => console.log(`[meeting-bridge] ${m}`, f ?? ''),
        warn: (m, f) => console.warn(`[meeting-bridge] ${m}`, f ?? ''),
        error: (m, f) => console.error(`[meeting-bridge] ${m}`, f ?? ''),
    };
}
const pluginEntry = (api, rawConfig) => {
    const config = ConfigSchema.parse(rawConfig ?? {});
    const logger = makeLogger(api);
    const bridge = new HubBridgeClient(config, {
        installationId: loadInstallationId(),
        agentDisplayName: 'Athena',
        serverVersion: PLUGIN_VERSION,
        platform: process.platform === 'win32' || process.platform === 'darwin'
            ? process.platform
            : 'linux',
        nodeVersion: process.versions.node,
        swarmaiVersion: PLUGIN_VERSION,
    }, logger);
    // Open the connection eagerly in the background so the first tool call
    // doesn't pay the bcrypt-auth latency. Failures don't block boot.
    void bridge.ensureConnected().catch((err) => {
        logger.error('initial bridge connect failed', { error: err.message });
    });
    // -------------------------------------------------------------------
    // Service registration — host-side consumers (e.g. the artefact-
    // download branch in `apps/server/src/api/meetings.ts`) read this
    // via `pluginRegistry.getService('meeting-bridge')`. The service
    // contract lives in `@swarmai/plugin-sdk/services/hub-bridge` and
    // is shape-equivalent to the imperative API our `createHubBridge`
    // factory exposes, plus the presentation + invokePlugin methods
    // that the agent tools below also use directly.
    // -------------------------------------------------------------------
    const service = buildHubBridgeService(bridge);
    const apiWithService = api;
    if (typeof apiWithService.registerService === 'function') {
        apiWithService.registerService('meeting-bridge', service);
        logger.info('meeting-bridge service registered on host');
    }
    else {
        logger.warn('host PluginAPI does not expose registerService — meeting-bridge service unavailable to host consumers (older swarmai-server build?)');
    }
    // -------------------------------------------------------------------
    // Tool registrations
    // -------------------------------------------------------------------
    for (const tool of [
        buildShareLinkTool(bridge),
        buildHistoryTool(bridge),
        buildReadArtefactTool(bridge),
        buildSpeakTool(bridge),
        buildPresentOpenTool(bridge),
        buildPresentNavigateTool(bridge),
        buildPresentCloseTool(bridge),
    ]) {
        api.registerTool(tool);
    }
};
export default pluginEntry;
export { pluginEntry, ConfigSchema };
// =====================================================================
// Tool builders
// =====================================================================
function buildShareLinkTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        expiresAtMsEpoch: z.number().int().positive(),
        maxUses: z.number().int().nonnegative().optional(),
        createdBy: z.string().min(1).default('main'),
    });
    return {
        name: 'swarm_admin.meeting.share_link',
        toolset: 'swarm_admin.meeting',
        description: 'Mint a Hub share link for an existing meeting. Returns { url, inviteToken, expiresAt }.',
        schema: Input,
        policy: 'master',
        emoji: '🔗',
        async handler(input) {
            const reply = await bridge.request({
                type: 'bridge.invite.mint',
                meetingId: input.meetingId,
                expiresAt: input.expiresAtMsEpoch,
                ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
                createdBy: input.createdBy,
            }, 'bridge.invite.minted');
            return {
                url: reply.url,
                inviteToken: reply.inviteToken,
                expiresAt: reply.expiresAt,
            };
        },
    };
}
function buildHistoryTool(bridge) {
    const Input = z.object({
        meetingId: z.string().optional(),
        attendeePeerId: z.string().optional(),
        guestEmail: z.string().email().optional(),
        query: z.string().max(2000).optional(),
        status: z.enum(['live', 'adjourned', 'all']).optional(),
        startedAfter: z.number().optional(),
        startedBefore: z.number().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        includeTranscript: z.boolean().optional(),
        includeAttendees: z.boolean().optional(),
        includeArtefacts: z.boolean().optional(),
    });
    return {
        name: 'swarm_admin.meeting.history',
        toolset: 'swarm_admin.meeting',
        description: 'Query Hub-side past meetings. Supports FTS5 over transcripts and extracted artefact text.',
        schema: Input,
        policy: 'open',
        emoji: '📜',
        async handler(input) {
            return bridge.request({ type: 'bridge.meeting.history.query', ...input }, 'bridge.meeting.history.result');
        },
    };
}
function buildReadArtefactTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        artefactId: z.string().min(1),
    });
    return {
        name: 'swarm_admin.meeting.read_artefact',
        toolset: 'swarm_admin.meeting',
        description: 'Return full extracted text + JSON for a specific artefact in a meeting.',
        schema: Input,
        policy: 'open',
        emoji: '📖',
        async handler(input) {
            // Reuse history.query with includeExtractions: true scoped to one meeting.
            const reply = await bridge.request({
                type: 'bridge.meeting.history.query',
                meetingId: input.meetingId,
                includeAttendees: false,
                includeArtefacts: true,
                includeTranscript: false,
                includeExtractions: true,
                limit: 1,
            }, 'bridge.meeting.history.result');
            const meeting = reply.meetings[0];
            const artefact = meeting?.artefacts?.find((a) => a.artefactId === input.artefactId);
            if (!artefact) {
                return {
                    ok: false,
                    code: 'artefact-not-found',
                    error: `artefact ${input.artefactId} not found in meeting ${input.meetingId}`,
                };
            }
            return {
                ok: true,
                artefactId: artefact.artefactId,
                label: artefact.label,
                mime: artefact.mime,
                sizeBytes: artefact.sizeBytes,
                extractions: artefact.extractions ?? [],
            };
        },
    };
}
function buildSpeakTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        text: z.string().min(1).max(8000),
        voice: z.string().optional(),
        label: z.string().optional(),
    });
    return {
        name: 'swarm_admin.meeting.speak',
        toolset: 'swarm_admin.meeting',
        description: 'Render text to audio via the Hub TTS plugin and attach as a meeting artefact.',
        schema: Input,
        policy: 'master',
        emoji: '🔊',
        async handler(input) {
            const reply = await bridge.request({
                type: 'bridge.plugin.invoke',
                meetingId: input.meetingId,
                pluginId: 'text-to-voice',
                payload: {
                    text: input.text,
                    ...(input.voice ? { voice: input.voice } : {}),
                    ...(input.label ? { label: input.label } : {}),
                },
            }, 'bridge.plugin.invoke-result');
            return {
                ok: true,
                summary: reply.summary ?? null,
                warnings: reply.warnings ?? [],
                artefactIds: reply.newArtefactIds ?? [],
            };
        },
    };
}
function buildPresentOpenTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        artefactId: z.string().min(1),
        controllerPeerId: z.string().min(1).default('main'),
    });
    return {
        name: 'swarm_admin.meeting.present.open',
        toolset: 'swarm_admin.meeting.present',
        description: 'Open a live presentation for an artefact. Caller becomes the page controller.',
        schema: Input,
        policy: 'master',
        emoji: '🎬',
        async handler(input) {
            return bridge.request({ type: 'bridge.presentation.open', ...input }, 'bridge.presentation.opened');
        },
    };
}
function buildPresentNavigateTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        artefactId: z.string().min(1),
        presentationId: z.string().min(1),
        toPage: z.number().int().positive(),
        byPeerId: z.string().min(1).default('main'),
    });
    return {
        name: 'swarm_admin.meeting.present.navigate',
        toolset: 'swarm_admin.meeting.present',
        description: 'Move an open presentation to a specific page (controller-only).',
        schema: Input,
        policy: 'open',
        emoji: '⏭️',
        async handler(input) {
            return bridge.request({ type: 'bridge.presentation.navigate', ...input }, 'bridge.presentation.state-changed');
        },
    };
}
function buildPresentCloseTool(bridge) {
    const Input = z.object({
        meetingId: z.string().min(1),
        artefactId: z.string().min(1),
        presentationId: z.string().min(1),
        byPeerId: z.string().min(1).default('main'),
    });
    return {
        name: 'swarm_admin.meeting.present.close',
        toolset: 'swarm_admin.meeting.present',
        description: 'End a live presentation session.',
        schema: Input,
        policy: 'master',
        emoji: '⏹️',
        async handler(input) {
            return bridge.request({ type: 'bridge.presentation.close', ...input }, 'bridge.presentation.state-changed');
        },
    };
}
void PLUGIN_ID;
// =====================================================================
// Service contract impl — wraps HubBridgeClient with the methods the
// host's ServiceRegistry consumers expect. Some methods reuse the
// public helpers on HubBridgeClient (mintInvite/queryHistory/
// fetchArtefact/onWelcome); the rest issue inline `bridge.request(...)`
// calls because the tool builders below already follow that shape and
// duplicating the inline pattern keeps the wire surface single-sourced
// in this file.
// =====================================================================
function buildHubBridgeService(bridge) {
    return {
        start: async () => {
            await bridge.ensureConnected();
        },
        stop: () => bridge.stop(),
        get connected() {
            return bridge.isConnected;
        },
        onWelcome(listener) {
            return bridge.onWelcome((w) => {
                listener({
                    tenantId: w.tenantId,
                    tenantSlug: w.tenantSlug,
                    tenantDisplayName: w.tenantDisplayName,
                });
            });
        },
        fetchArtefact: (meetingId, artefactId) => bridge.fetchArtefact(meetingId, artefactId),
        mintInvite: (input) => bridge.mintInvite({
            meetingId: input.meetingId,
            expiresAt: input.expiresAt,
            createdBy: input.createdBy,
            ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
        }),
        queryHistory: async (input) => {
            // HubBridgeClient.queryHistory returns the wire shape with
            // `meetings: Array<Record<string, unknown>>`; the canonical
            // contract types it more precisely. Cast through `unknown`
            // because both sides agree on the Hub's reply shape but TS
            // can't infer that from the wire-level placeholder.
            const r = await bridge.queryHistory(input);
            return r;
        },
        readArtefactExtraction: async (input) => {
            // Reuses the history.query path with includeExtractions so the Hub
            // returns the artefact's full extracted text in one round trip.
            const r = await bridge.queryHistory({
                meetingId: input.meetingId,
                includeAttendees: false,
                includeTranscript: false,
                includeArtefacts: true,
                includeExtractions: true,
                limit: 1,
            });
            const meeting = r.meetings[0];
            const artefacts = meeting?.['artefacts'] ?? [];
            const artefact = artefacts.find((a) => a.artefactId === input.artefactId);
            const extraction = artefact?.extractions?.find((e) => input.pluginId === undefined || e.pluginId === input.pluginId);
            if (!artefact || !extraction) {
                throw new Error(`artefact ${input.artefactId} (plugin ${input.pluginId ?? 'any'}) not found in meeting ${input.meetingId}`);
            }
            return {
                ok: true,
                pluginId: extraction.pluginId,
                pluginVersion: extraction.pluginVersion,
                extractedText: extraction.extractedText ?? '',
                ...(extraction.pageCount !== undefined ? { pageCount: extraction.pageCount } : {}),
                ...(extraction.warnings !== undefined ? { warnings: extraction.warnings } : {}),
            };
        },
        invokePlugin: async (input) => {
            const reply = await bridge.request({
                type: 'bridge.plugin.invoke',
                pluginId: input.pluginId,
                meetingId: input.meetingId,
                payload: input.payload,
                ...(input.artefactId !== undefined ? { artefactId: input.artefactId } : {}),
            }, 'bridge.plugin.invoke-result');
            return reply;
        },
        openPresentation: async (input) => {
            return bridge.request({
                type: 'bridge.presentation.open',
                meetingId: input.meetingId,
                artefactId: input.artefactId,
                controllerPeerId: input.controllerPeerId,
            }, 'bridge.presentation.opened');
        },
        navigatePresentation: async (input) => {
            return bridge.request({
                type: 'bridge.presentation.navigate',
                meetingId: input.meetingId,
                presentationId: input.presentationId,
                toPage: input.toPage,
                byPeerId: input.byPeerId,
            }, 'bridge.presentation.state-changed');
        },
        closePresentation: async (input) => {
            await bridge.request({
                type: 'bridge.presentation.close',
                meetingId: input.meetingId,
                presentationId: input.presentationId,
                byPeerId: input.byPeerId,
            }, 'bridge.presentation.state-changed');
            return { ok: true };
        },
    };
}
//# sourceMappingURL=index.js.map