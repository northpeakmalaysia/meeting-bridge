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
import type { PluginEntry } from '@swarmai/plugin-sdk';
import { ConfigSchema } from './config-schema.js';
declare const pluginEntry: PluginEntry;
export default pluginEntry;
export { pluginEntry, ConfigSchema };
export type { FetchArtefactResult, HistoryQueryInput, MintInviteInput, MintInviteResult, WelcomePayload, } from './bridge-client.js';
export type { HubBridge, HubBridgeWelcome } from './types/hub-bridge-contract.js';
//# sourceMappingURL=index.d.ts.map