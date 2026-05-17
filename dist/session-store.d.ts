/**
 * Per-workspace state file for the meeting-bridge plugin.
 *
 * Modeled on the @swarmai/channel-whatsapp-baileys session-store pattern:
 *  - workspace-resolved base directory (honours SWARMAI_WORKSPACE env)
 *  - mode 0700 on the directory, 0600 on the state file
 *  - read-only helpers that never create the file (safe for tests)
 *  - graceful Windows fallback when chmod isn't supported
 *
 * Holds the bridge-issued token + tenant identity so subsequent boots
 * don't re-enroll. The file is owned by the plugin and never written
 * from elsewhere; the plugin loader treats it as opaque.
 */
export interface BridgeSessionState {
    /** Bridge token issued by the Hub at enrollment time. */
    token: string;
    /** Tenant UUID the token is bound to. */
    tenantId: string;
    /** Human-readable slug the Hub assigned (or the operator picked). */
    slug: string;
    /** When the token was issued. UNIX ms. */
    issuedAt: number;
    /**
     * Recorded so a future plugin upgrade can detect format changes and
     * either migrate or re-enroll. Bump alongside any breaking
     * BridgeSessionState shape change.
     */
    stateVersion: 1;
}
/**
 * Resolve the workspace root the way the WhatsApp plugin does:
 * prefer SWARMAI_WORKSPACE env, fall back to process.cwd().
 * Pure — never creates anything.
 */
export declare function resolveWorkspaceRoot(): string;
export declare function statePath(workspaceRoot?: string): string;
/**
 * Read the state file if present. Returns null when missing or unreadable
 * (treat unknowable as "no state" so the enrollment path runs).
 */
export declare function readState(workspaceRoot?: string): BridgeSessionState | null;
/**
 * Write state atomically-ish: ensure dir exists, write file, chmod 0600.
 * No locking — the plugin is single-instance per workspace by design.
 */
export declare function writeState(state: BridgeSessionState, workspaceRoot?: string): void;
//# sourceMappingURL=session-store.d.ts.map