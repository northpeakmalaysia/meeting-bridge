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
import { z } from '@swarmai/shared';
import { ConfigSchema } from './config-schema.js';
import { HubBridgeClient } from './bridge-client.js';
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
//# sourceMappingURL=index.js.map