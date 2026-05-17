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
export interface HubBridgeWelcome {
    tenantId: string;
    tenantSlug: string;
    tenantDisplayName: string;
}
export interface HubBridgeHistoryQuery {
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
    includeExtractions?: boolean;
}
export interface HubBridgeHistoryMeeting {
    meetingId: string;
    title: string;
    status: 'scheduled' | 'live' | 'adjourned';
    createdAt: number;
    startedAt?: number;
    adjournedAt?: number;
    summary?: string;
    attendees?: Array<{
        peerId: string;
        displayName?: string;
        kind: 'peer' | 'human-external';
        joinedAt: number;
        leftAt?: number;
    }>;
    artefacts?: Array<{
        artefactId: string;
        label?: string;
        mime: string;
        sizeBytes: number;
        sharedBy: string;
        sharedAt: number;
        extractedText?: string;
        extractedJson?: unknown;
    }>;
    transcript?: Array<{
        id: string;
        at: number;
        from: string;
        to?: string;
        body: string;
        kind: 'brief' | 'ask' | 'reply' | 'human' | 'system';
    }>;
    transcriptLen?: number;
}
export interface HubBridgeHistoryResult {
    total: number;
    meetings: HubBridgeHistoryMeeting[];
    nextCursor?: string;
}
export interface HubBridgeMintInviteInput {
    meetingId: string;
    expiresAt: number;
    maxUses?: number;
    createdBy: string;
}
export interface HubBridgeMintedInvite {
    url: string;
    inviteToken: string;
    expiresAt: number;
}
export interface HubBridgeFetchedArtefact {
    body: Buffer;
    mime: string;
    filename: string;
}
export interface HubBridgeReadArtefactInput {
    meetingId: string;
    artefactId: string;
    pluginId?: string;
}
export interface HubBridgeReadArtefactResult {
    ok: true;
    pluginId: string;
    pluginVersion: string;
    extractedText: string;
    pageCount?: number;
    warnings?: string[];
}
export interface HubBridgeInvokePluginInput {
    pluginId: string;
    meetingId: string;
    payload: unknown;
    artefactId?: string;
}
export interface HubBridgeInvokePluginResult {
    ok: boolean;
    extractedText?: string;
    extractedJson?: unknown;
    newArtefactIds?: string[];
    summary?: string;
    warnings?: string[];
    error?: string;
}
export interface HubBridgeOpenPresentationInput {
    meetingId: string;
    artefactId: string;
    controllerPeerId: string;
}
export interface HubBridgeOpenPresentationResult {
    ok: true;
    presentationId: string;
    totalPages: number;
    currentPage: number;
    pageUrls: string[];
    title?: string;
    warnings?: string[];
}
export interface HubBridgeNavigatePresentationInput {
    meetingId: string;
    presentationId: string;
    toPage: number;
    byPeerId: string;
}
export interface HubBridgeNavigatePresentationResult {
    ok: true;
    currentPage: number;
    totalPages: number;
}
export interface HubBridgeClosePresentationInput {
    meetingId: string;
    presentationId: string;
    byPeerId: string;
}
export interface HubBridge {
    start(): Promise<void>;
    stop(): Promise<void>;
    readonly connected: boolean;
    onWelcome(listener: (welcome: HubBridgeWelcome) => void): () => void;
    fetchArtefact(meetingId: string, artefactId: string): Promise<HubBridgeFetchedArtefact>;
    mintInvite(input: HubBridgeMintInviteInput): Promise<HubBridgeMintedInvite>;
    queryHistory(input: HubBridgeHistoryQuery): Promise<HubBridgeHistoryResult>;
    readArtefactExtraction(input: HubBridgeReadArtefactInput): Promise<HubBridgeReadArtefactResult>;
    invokePlugin(input: HubBridgeInvokePluginInput): Promise<HubBridgeInvokePluginResult>;
    openPresentation(input: HubBridgeOpenPresentationInput): Promise<HubBridgeOpenPresentationResult>;
    navigatePresentation(input: HubBridgeNavigatePresentationInput): Promise<HubBridgeNavigatePresentationResult>;
    closePresentation(input: HubBridgeClosePresentationInput): Promise<{
        ok: true;
    }>;
}
//# sourceMappingURL=hub-bridge-contract.d.ts.map