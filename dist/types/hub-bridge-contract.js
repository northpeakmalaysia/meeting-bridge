/**
 * Local mirror of `@swarmai/plugin-sdk/services/hub-bridge.ts`.
 *
 * The bridge plugin targets `@swarmai/plugin-sdk >= 0.5.0` per peerDeps,
 * but the `HubBridge` service contract was added in 0.6.x. Mirroring
 * the shape here lets the plugin typecheck against the older floor
 * while still implementing the new contract correctly — at runtime the
 * host's newer SDK reads our impl via `pluginRegistry.getService(
 * 'meeting-bridge')` and the structural types align.
 *
 * Keep this file byte-for-byte equivalent to the canonical contract in
 * `packages/plugin-sdk/src/services/hub-bridge.ts` (CEO Agent monorepo).
 * Drift will surface as runtime shape mismatches; verify with a
 * grep-diff before each plugin release.
 */
export {};
//# sourceMappingURL=hub-bridge-contract.js.map