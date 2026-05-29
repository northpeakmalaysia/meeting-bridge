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
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import type { PluginAPI, PluginEntry, ToolDef } from '@swarmai/plugin-sdk';
import { ConfigSchema, type ConfigSchemaT } from './config-schema.js';
import {
  HubBridgeClient,
  type FetchArtefactResult,
  type HistoryQueryInput,
  type MintInviteInput,
  type MintInviteResult,
  type WelcomePayload,
} from './bridge-client.js';
import { readState, writeState, type BridgeSessionState } from './session-store.js';
import { enrollWithHub, EnrollmentError } from './enroll.js';
import type {
  HubBridge,
  HubBridgeArtefactSharedFrame,
  HubBridgeClosePresentationInput,
  HubBridgeFetchedArtefact,
  HubBridgeGuestJoinedFrame,
  HubBridgeGuestLeftFrame,
  HubBridgeGuestTurnFrame,
  HubBridgeHistoryQuery,
  HubBridgeHistoryResult,
  HubBridgeInvokePluginInput,
  HubBridgeInvokePluginResult,
  HubBridgeMintInviteInput,
  HubBridgeMintedInvite,
  HubBridgeNavigatePresentationInput,
  HubBridgeNavigatePresentationResult,
  HubBridgeOpenPresentationInput,
  HubBridgeOpenPresentationResult,
  HubBridgePluginConfigEntry,
  HubBridgePluginConfigResult,
  HubBridgePluginListInput,
  HubBridgePluginListResult,
  HubBridgePublishMeetingOpenedInput,
  HubBridgePublishTurnInput,
  HubBridgePublishAttendeeChangedInput,
  HubBridgePublishMeetingAdjournedInput,
  HubBridgeUploadArtefactInput,
  HubBridgeUploadArtefactResult,
  HubBridgePublishTypingInput,
  HubBridgeReadArtefactInput,
  HubBridgeReadArtefactResult,
  HubBridgeWelcome,
} from './types/hub-bridge-contract.js';

/**
 * Host shape after the ServiceRegistry seam landed. The bridge plugin
 * targets `@swarmai/plugin-sdk >= 0.5.0` per peerDeps; in 0.6.x the
 * SDK exposes `registerService` directly on PluginAPI. We narrow with
 * a cast at the call site rather than bumping the peerDep floor —
 * older hosts log a clean warning and skip service registration.
 */
type PluginAPIWithService = PluginAPI & {
  registerService?: <K extends 'meeting-bridge'>(
    serviceId: K,
    impl: K extends 'meeting-bridge' ? HubBridge : object,
  ) => void;
};

const PLUGIN_ID = '@swarmai/meeting-bridge';
const PLUGIN_VERSION = '0.8.7';

type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * Identity loader: read (and on first boot, write) the plugin's
 * `agentInstallationId` from `<root>/.swarmai/installation-id`.
 *
 * `<root>` resolves to `process.env.SWARMAI_WORKSPACE ?? process.cwd()` —
 * matching the convention `writeState()` uses for `state.json`, so the
 * two files live side-by-side under the agent's workspace instead of
 * the cwd, which on bundled `npm install -g` deployments is the package
 * install dir (often read-only on managed hosts).
 *
 * Persistence on first generation is essential: the Hub binds each
 * tenant to a single `installationId` and rejects subsequent WSS
 * connects with close 4402 if `bridge.hello.agentInstallationId` doesn't
 * match the binding. Generating a fresh random UUID per boot — the
 * pre-fix behaviour — produced a tenant on first connect and a 4402 on
 * every subsequent restart, with `state.json`'s token still pointing at
 * the original (now orphaned) tenant.
 */
function loadInstallationId(): string {
  // Use ESM imports (top-of-file) — NOT `require`. The plugin builds as
  // ESM (`"type": "module"`, tsconfig `module: ESNext`), so a bare
  // `require('node:fs')` throws "require is not defined" when the host
  // imports the compiled dist. (Bit us on 2026-05-20 in the bundled
  // distribution where the gateway is ESM.)
  const root = process.env['SWARMAI_WORKSPACE'] ?? process.cwd();
  const candidate = nodePath.join(root, '.swarmai', 'installation-id');
  try {
    if (nodeFs.existsSync(candidate)) {
      const text = nodeFs.readFileSync(candidate, 'utf8').trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
        return text;
      }
    }
  } catch {
    // ignore — fall through to generate + persist
  }
  const id = nodeRandomUUID();
  // Best-effort persist. Mirrors `writeState()`'s permission model
  // (0o600). If the directory is unwritable we still return the id —
  // the plugin works for the current process but will re-enroll a
  // fresh tenant on next boot (operator sees that as another row in
  // the Hub registry, not a crash).
  try {
    const dir = nodePath.dirname(candidate);
    if (!nodeFs.existsSync(dir)) nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(candidate, id, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // ignore
  }
  return id;
}

function makeLogger(api: PluginAPI): Logger {
  const anyApi = api as unknown as {
    logger?: Logger;
    log?: Logger;
  };
  if (anyApi.logger) return anyApi.logger;
  if (anyApi.log) return anyApi.log;
  return {
    info: (m, f) => console.log(`[meeting-bridge] ${m}`, f ?? ''),
    warn: (m, f) => console.warn(`[meeting-bridge] ${m}`, f ?? ''),
    error: (m, f) => console.error(`[meeting-bridge] ${m}`, f ?? ''),
  };
}

/**
 * Translate the operator's `config.plugins` map into `bridge.plugin.config.set`
 * entries. Splits `enabled` out from the rest of each entry — the remaining
 * keys (provider / apiKey / model / voice / ...) become the plugin's `config`
 * object. An entry with only `enabled` sends no `config` (toggle-only, which
 * the Hub treats as "preserve the stored key"). Never logs the values.
 */
function buildPluginConfigEntries(config: ConfigSchemaT): HubBridgePluginConfigEntry[] {
  const byId = new Map<string, HubBridgePluginConfigEntry>();

  // Merge an entry into the map; later calls override earlier config keys.
  const upsert = (
    pluginId: string,
    enabled: boolean | undefined,
    cfg: Record<string, unknown>,
  ): void => {
    const prev = byId.get(pluginId);
    const mergedConfig = { ...(prev?.config ?? {}), ...cfg };
    const entry: HubBridgePluginConfigEntry = { pluginId };
    const eff = enabled ?? prev?.enabled;
    if (typeof eff === 'boolean') entry.enabled = eff;
    if (Object.keys(mergedConfig).length > 0) entry.config = mergedConfig;
    byId.set(pluginId, entry);
  };

  // 1. Nested `plugins` map — power users / arbitrary plugins via plugins.yaml.
  if (config.plugins) {
    for (const [pluginId, raw] of Object.entries(config.plugins)) {
      const { enabled, ...rest } = raw as { enabled?: boolean } & Record<string, unknown>;
      upsert(pluginId, typeof enabled === 'boolean' ? enabled : undefined, rest);
    }
  }

  // 2. Flat dashboard fields for the two credential-gated plugins. These
  //    override the nested map on overlapping keys (the dashboard is the
  //    primary path). Empty strings are dropped so a blank field doesn't
  //    overwrite a stored value with "".
  const prune = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

  const ttsCfg = prune({
    provider: config.ttsProvider,
    apiKey: config.ttsApiKey,
    voice: config.ttsVoice,
    model: config.ttsModel,
    instructions: config.ttsInstructions,
    autoNarrateTurns: config.ttsAutoNarrate,
  });
  if (config.ttsEnabled !== undefined || Object.keys(ttsCfg).length > 0) {
    upsert('text-to-voice', config.ttsEnabled, ttsCfg);
  }

  const sttCfg = prune({
    provider: config.sttProvider,
    apiKey: config.sttApiKey,
    language: config.sttLanguage,
    model: config.sttModel,
  });
  if (config.sttEnabled !== undefined || Object.keys(sttCfg).length > 0) {
    upsert('voice-to-text', config.sttEnabled, sttCfg);
  }

  return [...byId.values()];
}

const pluginEntry: PluginEntry = (api: PluginAPI, rawConfig?: unknown) => {
  const config: ConfigSchemaT = ConfigSchema.parse(rawConfig ?? {});
  const logger = makeLogger(api);
  const installationId = loadInstallationId();

  // Token resolution priority — lazy, runs on first ensureConnected:
  //   1. State file at <workspace>/.swarmai/meeting-bridge/state.json
  //   2. config.token (legacy explicit-provisioning path)
  //   3. POST /bridge/enroll WITH bootstrap secret (config first, env fallback)
  //   4. POST /bridge/enroll WITHOUT bootstrap secret (v0.5.0 open-enroll)
  //
  // Each tier short-circuits the next. State is persisted only after a
  // successful enrollment, so a manually-configured token in plugins.yaml
  // is never overwritten with an auto-enrolled one. The open-enroll tier
  // exists so an operator can leave the form fields blank in the dashboard
  // and still get a working bridge — provided the Hub super-admin enabled
  // HUB_BOOTSTRAP_OPEN_ENROLLMENT. If the Hub rejects (`401
  // enrollment_disabled`), the error message tells the operator exactly
  // what knob is missing.
  const tokenSource = async (): Promise<string> => {
    const stored = readState();
    if (stored?.token) {
      logger.info('using stored bridge token', {
        tenantId: stored.tenantId,
        slug: stored.slug,
        issuedAt: new Date(stored.issuedAt).toISOString(),
      });
      return stored.token;
    }
    if (config.token) {
      logger.info('using config-supplied bridge token (explicit-provisioning path)');
      return config.token;
    }
    const bootstrap =
      config.bootstrapSecret ?? process.env['SWARMAI_HUB_BOOTSTRAP_SECRET'];
    const enrollMode = bootstrap ? 'bootstrap-secret' : 'open-enrollment';
    logger.info('no stored token — running enrollment against Hub', {
      installationId,
      mode: enrollMode,
    });
    try {
      const result = await enrollWithHub({
        hubBaseUrl: config.url,
        ...(bootstrap ? { bootstrapSecret: bootstrap } : {}),
        installationId,
      });
      const session: BridgeSessionState = {
        token: result.bridgeToken,
        tenantId: result.tenantId,
        slug: result.slug,
        issuedAt: Date.now(),
        stateVersion: 1,
      };
      writeState(session);
      logger.info('bridge enrolled with Hub', {
        tenantId: result.tenantId,
        slug: result.slug,
        reEnrolled: result.reEnrolled,
        mode: enrollMode,
      });
      return result.bridgeToken;
    } catch (err) {
      if (err instanceof EnrollmentError) {
        logger.error('enrollment rejected by Hub', { status: err.status, code: err.code });
        // Turn the Hub's machine-readable code into an operator-facing
        // message. The most common no-creds failure is `enrollment_disabled`
        // (open enroll is off on the Hub); pointing at the exact env var
        // saves the operator a documentation dive.
        if (err.code === 'enrollment_disabled') {
          throw new Error(
            'Hub refused open enrollment: this Hub does not allow secret-less ' +
              'enrollment. Provide a bridge token or bootstrap secret in the ' +
              'plugin config — or ask the Hub super-admin to set ' +
              'HUB_BOOTSTRAP_OPEN_ENROLLMENT=true on the Hub.',
          );
        }
        if (err.code === 'unauthorized') {
          throw new Error(
            'Hub rejected the bootstrap secret. Verify the secret in the ' +
              'plugin config matches what the Hub super-admin configured for ' +
              'HUB_BOOTSTRAP_SECRET_HASH.',
          );
        }
        if (err.code === 'not_found') {
          throw new Error(
            'Hub returned 404 on /bridge/enroll — enrollment is not enabled on ' +
              'this Hub at all. Ask the Hub super-admin to set ' +
              'HUB_BOOTSTRAP_ENABLED=true.',
          );
        }
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const bridge = new HubBridgeClient(
    config,
    {
      installationId,
      agentDisplayName: 'Athena',
      serverVersion: PLUGIN_VERSION,
      platform: process.platform === 'win32' || process.platform === 'darwin'
        ? process.platform
        : 'linux',
      nodeVersion: process.versions.node,
      swarmaiVersion: PLUGIN_VERSION,
    },
    logger,
    tokenSource,
  );

  // Open the connection eagerly in the background so the first tool call
  // doesn't pay the bcrypt-auth latency. Failures don't block boot.
  void bridge.ensureConnected().catch((err: Error) => {
    logger.error('initial bridge connect failed', { error: err.message });
  });

  // Push the operator-configured plugin settings (provider keys, models,
  // enable toggles) to the Hub on every (re)connect. The Hub stores them
  // encrypted per-tenant and applies them on the next plugin invocation —
  // no Hub restart, no Hub-side admin step. onWelcome fires once per
  // (re)connection; the push is idempotent so re-pushing after a reconnect
  // is safe. Fire-and-forget: a failed push is logged and retried on the
  // next reconnect rather than blocking anything.
  const pluginConfigs = buildPluginConfigEntries(config);
  if (pluginConfigs.length > 0) {
    const pushedIds = pluginConfigs.map((p) => p.pluginId);
    bridge.onWelcome(() => {
      bridge
        .setPluginConfig(pluginConfigs)
        .then((ack) => {
          // The Hub acks at the transport level even when individual plugins
          // fail to apply (e.g. a vault-decrypt error because the Hub master
          // key rotated, or a pluginId the Hub doesn't load). Previously those
          // per-plugin failures were logged at INFO and easy to miss — a
          // pushed-but-never-applied config looked like success. Now we treat
          // ANY per-plugin error, OR a pushed plugin the Hub neither applied
          // nor errored on (almost always "not loaded on this Hub"), as a LOUD,
          // actionable failure. `applied` carries only {pluginId, enabled,
          // configured} — never secrets.
          const errors = ack.errors ?? [];
          const appliedIds = new Set((ack.applied ?? []).map((a) => a.pluginId));
          const erroredIds = new Set(errors.map((e) => e.pluginId));
          const notRecognisedByHub = pushedIds.filter(
            (id) => !appliedIds.has(id) && !erroredIds.has(id),
          );

          if (errors.length === 0 && notRecognisedByHub.length === 0) {
            logger.info('pushed plugin config to Hub', { applied: ack.applied });
            return;
          }

          logger.error(
            'plugin config push had failures — some settings did NOT apply on the Hub',
            {
              applied: ack.applied ?? [],
              errors,
              notRecognisedByHub,
              hint:
                'If an error mentions auth/decrypt/authenticate, the Hub master key likely ' +
                'rotated and the tenant vault is undecryptable — re-key the tenant on the Hub. ' +
                'If a pluginId is notRecognisedByHub, confirm it matches a Hub built-in ' +
                '(e.g. text-to-voice, voice-to-text, presentation-layout).',
            },
          );
        })
        .catch((err: Error) => {
          logger.warn('plugin config push failed (will retry on next reconnect)', {
            error: err.message,
          });
        });
    });
    logger.info('plugin config push armed', { pluginIds: pushedIds });
  }

  // -------------------------------------------------------------------
  // Service registration — host-side consumers (e.g. the artefact-
  // download branch in `apps/server/src/api/meetings.ts`) read this
  // via `pluginRegistry.getService('meeting-bridge')`. The service
  // contract lives in `@swarmai/plugin-sdk/services/hub-bridge` and
  // is shape-equivalent to the imperative API our `createHubBridge`
  // factory exposes, plus the presentation + invokePlugin methods
  // that the agent tools below also use directly.
  // -------------------------------------------------------------------
  const service: HubBridge = buildHubBridgeService(bridge);
  const apiWithService = api as PluginAPIWithService;
  if (typeof apiWithService.registerService === 'function') {
    apiWithService.registerService('meeting-bridge', service);
    logger.info('meeting-bridge service registered on host');
  } else {
    logger.warn(
      'host PluginAPI does not expose registerService — meeting-bridge service unavailable to host consumers (older swarmai-server build?)',
    );
  }

  // -------------------------------------------------------------------
  // Tool registrations
  // -------------------------------------------------------------------
  for (const tool of [
    buildPublishToHubTool(bridge),
    buildShareLinkTool(bridge),
    buildHistoryTool(bridge),
    buildReadArtefactTool(bridge),
    buildSpeakTool(bridge),
    buildAwaitNarrationTool(bridge),
    buildMeetingPlaybookTool(),
    buildPresentOpenTool(bridge),
    buildPresentNavigateTool(bridge),
    buildPresentCloseTool(bridge),
    buildListPluginsTool(bridge),
    buildSetPluginConfigTool(bridge),
  ]) {
    api.registerTool(tool);
  }
};

export default pluginEntry;
export { pluginEntry, ConfigSchema };

// =====================================================================
// Re-exports — minimal surface the CEO Agent host inspects via the
// service-registry path. The canonical contract lives in
// `@swarmai/plugin-sdk/services/hub-bridge` on the host side; this
// plugin's local mirror is in `src/types/hub-bridge-contract.ts`.
// =====================================================================

export type {
  FetchArtefactResult,
  HistoryQueryInput,
  MintInviteInput,
  MintInviteResult,
  WelcomePayload,
} from './bridge-client.js';
export type { HubBridge, HubBridgeWelcome } from './types/hub-bridge-contract.js';

// =====================================================================
// Tool builders
// =====================================================================

/**
 * `swarm_admin.meeting.publish_to_hub` — mirror a locally-created meeting
 * up to the Hub so the Hub's tenant DB has a row keyed by `meetingId`.
 *
 * This is a prerequisite for any Hub-side operation against that meeting
 * (share_link, history queries on the new id, presentation control, etc.).
 * The CEO Agent's built-in `swarm_admin.meeting.create` writes only to the
 * workspace's local `meetings.sqlite` — it does not reach the Hub. Without
 * this publish step the Hub responds with `meeting-not-found` ("call
 * bridge.meeting.opened first") on the first mint attempt.
 *
 * Wire frame: `bridge.meeting.opened` (fire-and-forget, no ack). The Hub's
 * handler is idempotent — calling this tool twice on the same meetingId is
 * a no-op upsert on the Hub side.
 *
 * Agent flow:
 *   1. swarm_admin.meeting.create({title, attendees})  → meetingId (LOCAL)
 *   2. swarm_admin.meeting.publish_to_hub({meetingId, title, status,
 *                                          attendees})  ← THIS TOOL
 *   3. swarm_admin.meeting.share_link({meetingId, expiresAtMsEpoch})
 *      → returns { url, accessPin, joinPageUrl }
 */
function buildPublishToHubTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    meetingId: z.string().min(1).max(200),
    title: z.string().min(1).max(400),
    status: z.enum(['scheduled', 'live']).default('live'),
    attendees: z.array(
      z.object({
        peerId: z.string().min(1).max(200),
        displayName: z.string().max(120).optional(),
        kind: z.enum(['peer', 'human-external']).default('peer'),
      }),
    ),
    scheduledStart: z.number().int().nonnegative().optional(),
    scheduledEnd: z.number().int().positive().optional(),
    isRecorded: z.boolean().optional(),
  });
  return {
    name: 'swarm_admin.meeting.publish_to_hub',
    toolset: 'swarm_admin.meeting',
    description:
      'Mirror a locally-created meeting up to the Hub. Required between ' +
      'meeting.create (local-only) and meeting.share_link (Hub-side): the ' +
      'Hub needs a row keyed by meetingId before it can mint invites or ' +
      'serve guest joins. Idempotent — safe to call repeatedly. ' +
      '\n\n' +
      'IMPORTANT: `attendees` is an array of OBJECTS, not strings. Each ' +
      'entry is `{ peerId: "<id>", displayName?: "<name>", kind?: "peer" }`. ' +
      'Do NOT pass `["frontend-lead", "backend-lead"]` — that fails schema ' +
      'validation. Pass `[{ peerId: "frontend-lead" }, { peerId: ' +
      '"backend-lead" }]`. Use `kind: "human-external"` only for Hub guests; ' +
      'AI peers are `kind: "peer"` (the default). ' +
      '\n\n' +
      'Note: as of host v0.6.0 the CEO Agent AUTO-publishes a meeting to the ' +
      'Hub the moment it goes live AND auto-forwards every transcript turn, ' +
      'so you usually do NOT need to call this by hand — it exists for ' +
      're-publishing after a Hub-side data loss or for meetings created ' +
      'before the bridge connected. Fire-and-forget; returns immediately.',
    schema: Input,
    policy: 'master',
    emoji: '📡',
    async handler(input) {
      bridge.sendOneway({
        type: 'bridge.meeting.opened',
        meetingId: input.meetingId,
        title: input.title,
        status: input.status,
        attendees: input.attendees,
        ...(input.scheduledStart !== undefined
          ? { scheduledStart: input.scheduledStart }
          : {}),
        ...(input.scheduledEnd !== undefined
          ? { scheduledEnd: input.scheduledEnd }
          : {}),
        ...(input.isRecorded !== undefined ? { isRecorded: input.isRecorded } : {}),
      });
      return {
        ok: true,
        meetingId: input.meetingId,
        mirroredAt: Date.now(),
        note:
          'bridge.meeting.opened sent (fire-and-forget). Hub upsert is ' +
          'idempotent; meeting is now share_link-ready.',
      };
    },
  };
}

function buildShareLinkTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    meetingId: z.string().min(1),
    expiresAtMsEpoch: z.number().int().positive(),
    // Default 100 — a shared link should let the whole team / multiple
    // guests (and re-opens) through. Only narrow it on explicit request.
    maxUses: z.number().int().nonnegative().default(100),
    createdBy: z.string().min(1).default('main'),
  });
  return {
    name: 'swarm_admin.meeting.share_link',
    toolset: 'swarm_admin.meeting',
    description:
      'Required to share a meeting with external (non-staff) attendees. ' +
      'Returns a clickable URL AND a 6-digit accessPin + joinPageUrl for ' +
      'phone/voice handoff. Use accessPin when reading credentials over a ' +
      'call ("go to <joinPageUrl>, meeting <id>, PIN <pin>"). Same expiry ' +
      'and maxUses budget apply to both URL and PIN. ' +
      '\n\n' +
      '`maxUses` is the number of joins the link allows and DEFAULTS TO 100 — ' +
      'leave it unset for the normal "share with the team" case so people can ' +
      'join (and re-open the page) without hitting `invite_exhausted`. Pass a ' +
      'small value (e.g. 1) ONLY when the operator explicitly asks for a ' +
      'single-use / restricted link, or `0` for unlimited. Note: each page ' +
      'open consumes one use, so single-use links break on a refresh.',
    schema: Input,
    policy: 'master',
    emoji: '🔗',
    async handler(input) {
      const reply = await bridge.request<{
        inviteToken: string;
        url: string;
        accessPin?: string;
        joinPageUrl?: string;
        expiresAt: number;
      }>(
        {
          type: 'bridge.invite.mint',
          meetingId: input.meetingId,
          expiresAt: input.expiresAtMsEpoch,
          ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
          createdBy: input.createdBy,
        },
        'bridge.invite.minted',
      );
      const accessPinFormatted = reply.accessPin
        ? `${reply.accessPin.slice(0, 3)}-${reply.accessPin.slice(3)}`
        : undefined;
      return {
        url: reply.url,
        inviteToken: reply.inviteToken,
        expiresAt: reply.expiresAt,
        ...(reply.accessPin ? { accessPin: reply.accessPin } : {}),
        ...(accessPinFormatted ? { accessPinFormatted } : {}),
        ...(reply.joinPageUrl ? { joinPageUrl: reply.joinPageUrl } : {}),
      };
    },
  };
}

function buildHistoryTool(bridge: HubBridgeClient): ToolDef {
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
    description:
      'Query Hub-side past meetings. Supports FTS5 over transcripts and extracted artefact text.',
    schema: Input,
    policy: 'open',
    emoji: '📜',
    async handler(input) {
      return bridge.request(
        { type: 'bridge.meeting.history.query', ...input },
        'bridge.meeting.history.result',
      );
    },
  };
}

function buildReadArtefactTool(bridge: HubBridgeClient): ToolDef {
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
      const reply = await bridge.request<{
        meetings: Array<{
          artefacts?: Array<{
            artefactId: string;
            label?: string;
            mime: string;
            sizeBytes: number;
            extractions?: Array<{
              pluginId: string;
              pluginVersion: string;
              extractedText?: string;
              extractedJson?: unknown;
              pageCount?: number;
            }>;
          }>;
        }>;
      }>(
        {
          type: 'bridge.meeting.history.query',
          meetingId: input.meetingId,
          includeAttendees: false,
          includeArtefacts: true,
          includeTranscript: false,
          includeExtractions: true,
          limit: 1,
        },
        'bridge.meeting.history.result',
      );
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

function buildSpeakTool(bridge: HubBridgeClient): ToolDef {
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
      const reply = await bridge.request<{
        summary?: string;
        warnings?: string[];
        newArtefactIds?: string[];
      }>(
        {
          type: 'bridge.plugin.invoke',
          meetingId: input.meetingId,
          pluginId: 'text-to-voice',
          payload: {
            text: input.text,
            ...(input.voice ? { voice: input.voice } : {}),
            ...(input.label ? { label: input.label } : {}),
          },
        },
        'bridge.plugin.invoke-result',
      );
      return {
        ok: true,
        summary: reply.summary ?? null,
        warnings: reply.warnings ?? [],
        artefactIds: reply.newArtefactIds ?? [],
      };
    },
  };
}

/**
 * Self-contained operating playbook for the Meeting Hub features. Lives in the
 * plugin (versioned with it) so the guidance auto-updates on upgrade — no
 * per-install persona edits. Surfaced via `swarm_admin.meeting.playbook` so the
 * agent can load best-practice patterns just-in-time when it runs a meeting.
 */
const MEETING_PLAYBOOK: Record<string, string> = {
  pacing:
    'PACING A MULTI-AGENT MEETING (when text-to-voice narration is ON):\n' +
    '- Narrated turns are spoken to guests one clip at a time; firing all agents at once stacks the voices and lags the audio behind the chat.\n' +
    '- Pace yourself: (1) dispatch/post ONE speaker\'s turn and keep its turnId, (2) call swarm_admin.meeting.await_narration { meetingId, turnId }, (3) when it returns (completed OR timedOut), dispatch the next speaker.\n' +
    '- await_narration always returns within timeoutMs (default 45s) and resolves instantly if the clip already finished — never block on it; if timedOut, just proceed.\n' +
    '- Skip this loop when narration is OFF or no external guests have joined (nothing to pace for).',
  voice:
    'VOICE / NARRATION:\n' +
    '- Check swarm_admin.meeting.list_plugins → is text-to-voice enabled? Only narrate when it is.\n' +
    '- The Hub cleans markdown/paths before speaking (so "---" and "F:\\path" are not read literally) — you can write normal formatted turns.\n' +
    '- Tone is set on the Hub (gpt-4o-mini-tts honours the operator\'s tone instructions). Keep turns conversational; avoid dumping raw tables/JSON into a narrated turn.\n' +
    '- swarm_admin.meeting.speak renders a specific bit of text to audio on demand (separate from auto-narrate).',
  sharing:
    'SHARING FILES:\n' +
    '- Use swarm_admin.meeting.share { meetingId, ref, label }. Prefer file:// refs you WROTE inside the workspace (e.g. via write_file under <workspace>/meeting-docs/).\n' +
    '- Out-of-workspace file:// paths are now auto-staged into the workspace by the share tool, but writing in-workspace from the start is cleaner.\n' +
    '- Always pass a label with a real filename + extension so the guest download saves correctly.\n' +
    '- Shared PDFs/PPTX can then be presented live (see presentation).',
  presentation:
    'LIVE PRESENTATIONS (PDF / PPTX):\n' +
    '- Share the deck first, then swarm_admin.meeting.present.open { meetingId, artefactId } to become controller and push synced slides to guests.\n' +
    '- present.navigate { presentationId, toPage } moves everyone; present.close ends it.\n' +
    '- Build a deck on the fly with document_create { format: "pptx" | "pdf" }, share it, then present.',
};

function buildMeetingPlaybookTool(): ToolDef {
  const topics = Object.keys(MEETING_PLAYBOOK);
  const Input = z.object({
    topic: z
      .enum(['all', ...topics] as [string, ...string[]])
      .optional()
      .describe(`Which guidance to load. Omit or "all" for the full playbook. One of: ${topics.join(', ')}.`),
  });
  return {
    name: 'swarm_admin.meeting.playbook',
    toolset: 'swarm_admin.meeting',
    description:
      'Load the current best-practice playbook for running meetings on the Meeting Hub — how to ' +
      'PACE multi-agent meetings (await_narration), use VOICE narration, SHARE files, and drive ' +
      'PRESENTATIONS. Call this when you start facilitating a meeting (especially with voice on) ' +
      'so you follow the latest patterns. Read-only; returns guidance text. Pairs with ' +
      'meeting.list_plugins (which capabilities are enabled) — this tool tells you how to use them well.',
    schema: Input,
    policy: 'open',
    emoji: '📖',
    async handler(input) {
      const topic = input.topic ?? 'all';
      const sections =
        topic === 'all' ? topics : topics.filter((t) => t === topic);
      const playbook = sections.map((t) => MEETING_PLAYBOOK[t]).join('\n\n');
      return { ok: true, topic, topics, playbook };
    },
  };
}

function buildAwaitNarrationTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    meetingId: z.string().min(1),
    turnId: z
      .string()
      .min(1)
      .describe("The turnId of the turn whose narration to wait for (from the turn you just posted)."),
    timeoutMs: z.number().int().positive().max(180_000).optional(),
  });
  return {
    name: 'swarm_admin.meeting.await_narration',
    toolset: 'swarm_admin.meeting',
    description:
      "Wait until a meeting turn's spoken narration (text-to-voice) has finished playing for " +
      'guests before continuing. Use this to PACE a multi-agent meeting so replies are heard one ' +
      'at a time instead of all at once:\n' +
      '  1. dispatch/post a turn (e.g. a lead presents),\n' +
      "  2. call await_narration with that turn's `turnId`,\n" +
      '  3. only then dispatch the next agent.\n' +
      'Resolves immediately if narration already finished, and ALWAYS returns within `timeoutMs` ' +
      '(default 45000): `{ ok, completed: true }` when the clip played or was skipped, or ' +
      '`{ ok, completed: false, timedOut: true }` if no signal arrived (just proceed). ' +
      'Safe when auto-narrate is off or there are no guests — it returns quickly; ignore the result. ' +
      'Only meaningful when the room has text-to-voice enabled (see meeting.list_plugins).',
    schema: Input,
    policy: 'open',
    emoji: '⏳',
    async handler(input) {
      const res = await bridge.waitForNarration(
        input.meetingId,
        input.turnId,
        input.timeoutMs ?? 45_000,
      );
      return { ok: true, ...res };
    },
  };
}

function buildPresentOpenTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    meetingId: z.string().min(1),
    artefactId: z.string().min(1),
    controllerPeerId: z.string().min(1).default('main'),
  });
  return {
    name: 'swarm_admin.meeting.present.open',
    toolset: 'swarm_admin.meeting.present',
    description:
      'Drive a LIVE, page-synchronised presentation for the whole room — operator AND Hub guests ' +
      'see the same slide in real time while you advance pages. This is the REAL presentation ' +
      'feature; do NOT fake it by writing a markdown file and calling it a deck.\n\n' +
      'PREREQUISITE: `artefactId` must reference a PDF or PPTX ALREADY shared into this meeting. ' +
      'Only .pdf and .pptx render — .md / .txt / .docx are NOT presentable.\n\n' +
      'FULL WORKFLOW to present YOUR OWN deck:\n' +
      '  1. Build it: `document_create { path: "meeting-docs/<name>.pptx", format: "pptx", slides: [...] }` ' +
      '(PPTX is generated natively — no external tools). `format: "pdf"` also works.\n' +
      '  2. Share it: `swarm_admin.meeting.share { meetingId, ref: "file://<absolute-path>", label: "<name>.pptx" }` ' +
      '— the host auto-mirrors the bytes to the Hub and returns an `artefactId`.\n' +
      '  3. Open: `swarm_admin.meeting.present.open { meetingId, artefactId }` — you become the controller.\n' +
      '  4. Narrate + advance: one `swarm_admin.meeting.ask { kind:"brief", body:"<talk track for this slide>" }` ' +
      'per slide, calling `present.navigate { ..., toPage }` between them.\n' +
      '  5. End with `present.close`.\n\n' +
      'To present a file a GUEST uploaded, get its artefactId from the room artefacts / ' +
      '`swarm_admin.meeting.history` and skip to step 3. Confirm the Hub has the renderer first via ' +
      '`swarm_admin.meeting.list_plugins` (look for `presentation-layout`). ' +
      'Returns { presentationId, totalPages, currentPage, pageUrls }.',
    schema: Input,
    policy: 'master',
    emoji: '🎬',
    async handler(input) {
      return bridge.request(
        { type: 'bridge.presentation.open', ...input },
        'bridge.presentation.opened',
      );
    },
  };
}

function buildPresentNavigateTool(bridge: HubBridgeClient): ToolDef {
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
      return bridge.request(
        { type: 'bridge.presentation.navigate', ...input },
        'bridge.presentation.state-changed',
      );
    },
  };
}

function buildPresentCloseTool(bridge: HubBridgeClient): ToolDef {
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
      return bridge.request(
        { type: 'bridge.presentation.close', ...input },
        'bridge.presentation.state-changed',
      );
    },
  };
}

/**
 * `swarm_admin.meeting.list_plugins` — capability introspection.
 *
 * Asks the connected Meeting Hub which plugins it has loaded for this
 * tenant and what each one supports (file types, invocability, whether
 * credential-gated plugins are configured). Lets Athena plan around
 * Hub capabilities ("the Hub does not have text-to-voice — I'll skip
 * voice generation") rather than discovering by failure.
 *
 * Wire frame: `bridge.plugin.list.query` (v0.6.0 of the bridge contract).
 * Single round-trip; Hub answers with `bridge.plugin.list.result`.
 *
 * Policy `open` — read-only, no side effects, safe for any peer to call.
 */
function buildListPluginsTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    meetingId: z.string().min(1).max(200).optional(),
  });
  return {
    name: 'swarm_admin.meeting.list_plugins',
    toolset: 'swarm_admin.meeting',
    description:
      'List Meeting Hub plugins available to this tenant, with mime/extension ' +
      'filters, invocability, and a configured hint for credential-gated ' +
      'plugins. Use this to plan around Hub capabilities before calling ' +
      'meeting.speak / present.open / etc.',
    schema: Input,
    policy: 'open',
    emoji: '🔌',
    async handler(input) {
      const frame: Record<string, unknown> & { type: string } = {
        type: 'bridge.plugin.list.query',
      };
      if (input.meetingId !== undefined) frame['meetingId'] = input.meetingId;
      const reply = await bridge.request<HubBridgePluginListResult>(
        frame,
        'bridge.plugin.list.result',
      );
      return {
        ok: true,
        hubVersion: reply.hubVersion,
        plugins: reply.plugins,
      };
    },
  };
}

/**
 * `swarm_admin.meeting.set_plugin_config` — push per-tenant plugin config to
 * the Hub at runtime (provider API keys, models, voices, enable toggles).
 *
 * The bridge already auto-pushes the operator's `config.plugins` on connect;
 * this tool exists for explicit/runtime changes (e.g. the operator hands
 * Athena a key, or flips a plugin on for one meeting). The Hub stores config
 * ENCRYPTED under the tenant vault and applies it on the next invocation.
 *
 * Wire frame: `bridge.plugin.config.set` → `bridge.plugin.config.ack`.
 * Policy `master` — it writes credentials, so it's not `open`.
 */
function buildSetPluginConfigTool(bridge: HubBridgeClient): ToolDef {
  const Input = z.object({
    configs: z
      .array(
        z.object({
          pluginId: z.string().min(1).max(120),
          enabled: z.boolean().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(50),
  });
  return {
    name: 'swarm_admin.meeting.set_plugin_config',
    toolset: 'swarm_admin.meeting',
    description:
      'Configure Meeting Hub plugins for this tenant: push provider API keys, ' +
      'models, voices, and enable/disable toggles to the connected Hub. Stored ' +
      'ENCRYPTED on the Hub and applied on the next invocation — no restart. ' +
      'Use to set up voice-to-text / text-to-voice (e.g. ' +
      '`{ pluginId: "text-to-voice", enabled: true, config: { provider: ' +
      '"openai-tts", apiKey: "sk-...", voice: "alloy" } }`). Omit `config` on ' +
      'an entry to toggle `enabled` only — the Hub keeps the stored key. ' +
      'Returns the per-plugin { enabled, configured } verdict; secrets are ' +
      'never echoed back.',
    schema: Input,
    policy: 'master',
    emoji: '🔧',
    async handler(input) {
      const ack = await bridge.setPluginConfig(input.configs);
      return {
        ok: true,
        applied: ack.applied,
        ...(ack.errors ? { errors: ack.errors } : {}),
      };
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

/**
 * v0.4.1 — Helper used by the `onGuest*` / `onArtefactShared` service
 * methods to subscribe to one inbound frame type on the bridge's
 * EventEmitter and return a typed unsubscribe function. `HubBridgeClient`
 * `.emit(type, frame)` once per inbound frame (see bridge-client.ts), so
 * we just register the listener directly.
 */
function subscribeBridgeFrame(
  bridge: HubBridgeClient,
  frameType: string,
  listener: (rawFrame: Record<string, unknown>) => void,
): () => void {
  const wrapped = (frame: unknown): void => {
    if (typeof frame === 'object' && frame !== null) {
      listener(frame as Record<string, unknown>);
    }
  };
  bridge.on(frameType, wrapped);
  return (): void => {
    bridge.off(frameType, wrapped);
  };
}

function buildHubBridgeService(bridge: HubBridgeClient): HubBridge {
  return {
    start: async (): Promise<void> => {
      await bridge.ensureConnected();
    },
    stop: () => bridge.stop(),
    get connected(): boolean {
      return bridge.isConnected;
    },
    onWelcome(listener: (welcome: HubBridgeWelcome) => void): () => void {
      return bridge.onWelcome((w: WelcomePayload) => {
        listener({
          tenantId: w.tenantId,
          tenantSlug: w.tenantSlug,
          tenantDisplayName: w.tenantDisplayName,
        });
      });
    },
    onGuestTurn(listener: (frame: HubBridgeGuestTurnFrame) => void): () => void {
      return subscribeBridgeFrame(bridge, 'bridge.guest.turn', (raw) => {
        const f = raw as { meetingId?: unknown; peerId?: unknown; body?: unknown };
        if (typeof f.meetingId !== 'string' || typeof f.peerId !== 'string' || typeof f.body !== 'string') {
          return;
        }
        listener({ meetingId: f.meetingId, peerId: f.peerId, body: f.body });
      });
    },
    onGuestJoined(listener: (frame: HubBridgeGuestJoinedFrame) => void): () => void {
      return subscribeBridgeFrame(bridge, 'bridge.guest.joined', (raw) => {
        const f = raw as Record<string, unknown>;
        if (
          typeof f['meetingId'] !== 'string' ||
          typeof f['peerId'] !== 'string' ||
          typeof f['guestId'] !== 'string' ||
          typeof f['displayName'] !== 'string'
        ) {
          return;
        }
        listener({
          meetingId: f['meetingId'],
          peerId: f['peerId'],
          guestId: f['guestId'],
          displayName: f['displayName'],
          email: typeof f['email'] === 'string' ? f['email'] : '',
          previouslyJoined: f['previouslyJoined'] === true,
          firstSeenAt: typeof f['firstSeenAt'] === 'number' ? f['firstSeenAt'] : 0,
          ipHash: typeof f['ipHash'] === 'string' ? f['ipHash'] : '',
          userAgent: typeof f['userAgent'] === 'string' ? f['userAgent'] : '',
        });
      });
    },
    onGuestLeft(listener: (frame: HubBridgeGuestLeftFrame) => void): () => void {
      return subscribeBridgeFrame(bridge, 'bridge.guest.left', (raw) => {
        const f = raw as { meetingId?: unknown; peerId?: unknown; reason?: unknown };
        if (typeof f.meetingId !== 'string' || typeof f.peerId !== 'string') return;
        const reason = typeof f.reason === 'string' ? f.reason : 'normal';
        listener({
          meetingId: f.meetingId,
          peerId: f.peerId,
          reason: reason as HubBridgeGuestLeftFrame['reason'],
        });
      });
    },
    onArtefactShared(listener: (frame: HubBridgeArtefactSharedFrame) => void): () => void {
      return subscribeBridgeFrame(bridge, 'bridge.artefact.shared', (raw) => {
        const f = raw as Record<string, unknown>;
        if (
          typeof f['meetingId'] !== 'string' ||
          typeof f['artefactId'] !== 'string' ||
          typeof f['mime'] !== 'string'
        ) {
          return;
        }
        listener({
          meetingId: f['meetingId'],
          artefactId: f['artefactId'],
          ref: typeof f['ref'] === 'string' ? f['ref'] : '',
          label: typeof f['label'] === 'string' ? f['label'] : '',
          mime: f['mime'],
          sizeBytes: typeof f['sizeBytes'] === 'number' ? f['sizeBytes'] : 0,
          sharedBy: typeof f['sharedBy'] === 'string' ? f['sharedBy'] : '',
        });
      });
    },
    fetchArtefact: (meetingId, artefactId): Promise<HubBridgeFetchedArtefact> =>
      bridge.fetchArtefact(meetingId, artefactId),
    mintInvite: (input: HubBridgeMintInviteInput): Promise<HubBridgeMintedInvite> =>
      bridge.mintInvite({
        meetingId: input.meetingId,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      }),
    queryHistory: async (input: HubBridgeHistoryQuery): Promise<HubBridgeHistoryResult> => {
      // HubBridgeClient.queryHistory returns the wire shape with
      // `meetings: Array<Record<string, unknown>>`; the canonical
      // contract types it more precisely. Cast through `unknown`
      // because both sides agree on the Hub's reply shape but TS
      // can't infer that from the wire-level placeholder.
      const r = await bridge.queryHistory(input);
      return r as unknown as HubBridgeHistoryResult;
    },
    readArtefactExtraction: async (
      input: HubBridgeReadArtefactInput,
    ): Promise<HubBridgeReadArtefactResult> => {
      // Reuses the history.query path with includeExtractions so the Hub
      // returns the artefact's full extracted text in one round trip.
      const r = await bridge.queryHistory({
        meetingId: input.meetingId,
        includeAttendees: false,
        includeTranscript: false,
        includeArtefacts: true,
        includeExtractions: true,
        limit: 1,
      } as HistoryQueryInput);
      const meeting = (r as unknown as { meetings: Array<Record<string, unknown>> }).meetings[0];
      const artefacts = (meeting?.['artefacts'] as
        | Array<{
            artefactId: string;
            extractions?: Array<{
              pluginId: string;
              pluginVersion: string;
              extractedText?: string;
              pageCount?: number;
              warnings?: string[];
            }>;
          }>
        | undefined) ?? [];
      const artefact = artefacts.find((a) => a.artefactId === input.artefactId);
      const extraction = artefact?.extractions?.find(
        (e) => input.pluginId === undefined || e.pluginId === input.pluginId,
      );
      if (!artefact || !extraction) {
        throw new Error(
          `artefact ${input.artefactId} (plugin ${input.pluginId ?? 'any'}) not found in meeting ${input.meetingId}`,
        );
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
    invokePlugin: async (
      input: HubBridgeInvokePluginInput,
    ): Promise<HubBridgeInvokePluginResult> => {
      const reply = await bridge.request<HubBridgeInvokePluginResult>(
        {
          type: 'bridge.plugin.invoke',
          pluginId: input.pluginId,
          meetingId: input.meetingId,
          payload: input.payload,
          ...(input.artefactId !== undefined ? { artefactId: input.artefactId } : {}),
        },
        'bridge.plugin.invoke-result',
      );
      return reply;
    },
    openPresentation: async (
      input: HubBridgeOpenPresentationInput,
    ): Promise<HubBridgeOpenPresentationResult> => {
      return bridge.request<HubBridgeOpenPresentationResult>(
        {
          type: 'bridge.presentation.open',
          meetingId: input.meetingId,
          artefactId: input.artefactId,
          controllerPeerId: input.controllerPeerId,
        },
        'bridge.presentation.opened',
      );
    },
    navigatePresentation: async (
      input: HubBridgeNavigatePresentationInput,
    ): Promise<HubBridgeNavigatePresentationResult> => {
      return bridge.request<HubBridgeNavigatePresentationResult>(
        {
          type: 'bridge.presentation.navigate',
          meetingId: input.meetingId,
          presentationId: input.presentationId,
          toPage: input.toPage,
          byPeerId: input.byPeerId,
        },
        'bridge.presentation.state-changed',
      );
    },
    closePresentation: async (
      input: HubBridgeClosePresentationInput,
    ): Promise<{ ok: true }> => {
      await bridge.request(
        {
          type: 'bridge.presentation.close',
          meetingId: input.meetingId,
          presentationId: input.presentationId,
          byPeerId: input.byPeerId,
        },
        'bridge.presentation.state-changed',
      );
      return { ok: true };
    },
    listPlugins: async (
      input?: HubBridgePluginListInput,
    ): Promise<HubBridgePluginListResult> => {
      const frame: Record<string, unknown> & { type: string } = {
        type: 'bridge.plugin.list.query',
      };
      if (input?.meetingId !== undefined) frame['meetingId'] = input.meetingId;
      const reply = await bridge.request<HubBridgePluginListResult>(
        frame,
        'bridge.plugin.list.result',
      );
      return reply;
    },
    setPluginConfig: (
      configs: HubBridgePluginConfigEntry[],
    ): Promise<HubBridgePluginConfigResult> => bridge.setPluginConfig(configs),
    // v0.6.0 outbound publish — fire-and-forget mirrors of local meeting
    // state. `sendOneway` no-ops when the WSS isn't open, so the host
    // doesn't need a connected() guard before every call (but it should
    // still check to avoid building frames pointlessly).
    publishMeetingOpened: (input: HubBridgePublishMeetingOpenedInput): void => {
      bridge.sendOneway({
        type: 'bridge.meeting.opened',
        meetingId: input.meetingId,
        title: input.title,
        status: input.status,
        attendees: input.attendees,
        ...(input.scheduledStart !== undefined ? { scheduledStart: input.scheduledStart } : {}),
        ...(input.scheduledEnd !== undefined ? { scheduledEnd: input.scheduledEnd } : {}),
      });
    },
    publishTurn: (input: HubBridgePublishTurnInput): void => {
      bridge.sendOneway({
        type: 'bridge.meeting.turn-appended',
        meetingId: input.meetingId,
        turn: {
          turnId: input.turnId,
          at: input.at,
          fromPeer: input.fromPeer,
          ...(input.toPeer !== undefined ? { toPeer: input.toPeer } : {}),
          kind: input.kind,
          body: input.body,
          ...(input.viaBus !== undefined ? { viaBus: input.viaBus } : {}),
          ...(input.replyToTurnId !== undefined ? { replyToTurnId: input.replyToTurnId } : {}),
        },
      });
    },
    publishAttendeeChanged: (input: HubBridgePublishAttendeeChangedInput): void => {
      bridge.sendOneway({
        type: 'bridge.meeting.attendee-changed',
        meetingId: input.meetingId,
        change: input.change,
        attendee: input.attendee,
      });
    },
    publishMeetingAdjourned: (input: HubBridgePublishMeetingAdjournedInput): void => {
      bridge.sendOneway({
        type: 'bridge.meeting.adjourned',
        meetingId: input.meetingId,
        adjournedAt: input.adjournedAt,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
    },
    // v0.7.0 — mirror shared file bytes up to the Hub (chunked, awaited).
    uploadArtefact: (
      input: HubBridgeUploadArtefactInput,
    ): Promise<HubBridgeUploadArtefactResult> =>
      bridge.uploadArtefact({
        meetingId: input.meetingId,
        artefactId: input.artefactId,
        bytes: input.bytes,
        mime: input.mime,
        sharedBy: input.sharedBy,
        ...(input.label !== undefined ? { label: input.label } : {}),
      }),
    // v0.7.0 — transient composing/"typing" presence fanned to guests.
    publishTyping: (input: HubBridgePublishTypingInput): void => {
      bridge.publishTyping({
        meetingId: input.meetingId,
        peerId: input.peerId,
        state: input.state,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      });
    },
  };
}
