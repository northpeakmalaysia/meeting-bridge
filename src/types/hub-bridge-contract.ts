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

/**
 * Per-tenant snapshot of one plugin installed on the Hub. The agent
 * uses this to gate capability-driven planning ("Hub has presentation-
 * layout, I can call openPresentation"; "Hub does not have
 * text-to-voice, don't offer voice generation"). Mirrors the Hub-side
 * `PluginListPluginInfo` exactly — keep byte-equivalent on both sides.
 */
export interface HubBridgePluginInfo {
  pluginId: string;
  version: string;
  description?: string;
  enabled: boolean;
  handles: string[];
  mimeTypes: string[];
  fileExtensions: string[];
  supportsInvoke: boolean;
  isBuiltin: boolean;
  configured?: boolean;
  lastError?: string;
}

export interface HubBridgePluginListResult {
  hubVersion: string;
  plugins: HubBridgePluginInfo[];
}

export interface HubBridgePluginConfigEntry {
  pluginId: string;
  /** Omit to leave the current enable flag unchanged. */
  enabled?: boolean;
  /** Provider/apiKey/model/voice/... ; OMIT to keep the stored config (toggle-only). */
  config?: Record<string, unknown>;
}

export interface HubBridgePluginConfigResult {
  applied: Array<{ pluginId: string; enabled: boolean; configured: boolean }>;
  errors?: Array<{ pluginId: string; error: string }>;
}

export interface HubBridgePluginListInput {
  /** Optional — reserved for per-meeting overlays. Today the Hub ignores it. */
  meetingId?: string;
}

/**
 * Inbound frames the Hub fans out to the bridge. Each event in `HubBridge`
 * (`onGuestTurn`, `onGuestJoined`, etc.) hands one of these to its listener.
 * The shape mirrors the Hub's wire frame minus the envelope (`v`, `id`,
 * `at`, `type`, `serverEventId`) which the host doesn't need to act on.
 */
export interface HubBridgeGuestTurnFrame {
  meetingId: string;
  /** Guest peerId, format `guest:<short>-<slug>`. */
  peerId: string;
  body: string;
}

export interface HubBridgeGuestJoinedFrame {
  meetingId: string;
  peerId: string;
  guestId: string;
  displayName: string;
  email: string;
  previouslyJoined: boolean;
  firstSeenAt: number;
  ipHash: string;
  userAgent: string;
}

export interface HubBridgeGuestLeftFrame {
  meetingId: string;
  peerId: string;
  reason: 'normal' | 'timeout' | 'kicked' | 'meeting-adjourned' | 'error';
}

export interface HubBridgeArtefactSharedFrame {
  meetingId: string;
  artefactId: string;
  ref: string;
  label: string;
  mime: string;
  sizeBytes: number;
  sharedBy: string;
}

/**
 * v0.6.0 outbound-publish inputs. The host calls these from its
 * `meetingRegistry.onChange` subscription so the local meeting room and
 * the Hub-side guest UI stay in sync. All four are fire-and-forget — the
 * Hub's handlers are idempotent and there is no ack.
 */
export interface HubBridgePublishMeetingOpenedInput {
  meetingId: string;
  title: string;
  status: 'scheduled' | 'live';
  attendees: Array<{
    peerId: string;
    displayName?: string;
    kind: 'peer' | 'human-external';
  }>;
  scheduledStart?: number;
  scheduledEnd?: number;
}

export interface HubBridgePublishTurnInput {
  meetingId: string;
  turnId: string;
  at: number;
  fromPeer: string;
  toPeer?: string;
  kind: 'human' | 'brief' | 'ask' | 'reply' | 'system';
  body: string;
  viaBus?: boolean;
  replyToTurnId?: string;
}

export interface HubBridgePublishAttendeeChangedInput {
  meetingId: string;
  change: 'invited' | 'uninvited';
  attendee: {
    peerId: string;
    displayName?: string;
    kind: 'peer' | 'human-external';
  };
}

export interface HubBridgePublishMeetingAdjournedInput {
  meetingId: string;
  adjournedAt: number;
  summary?: string;
}

/**
 * v0.7.0 — upload an agent/operator-shared file's bytes to the Hub
 * (chunked) so guests can download it and so it can be presented. Reuse
 * the local artefactId so `openPresentation({ artefactId })` addresses
 * the same file.
 */
export interface HubBridgeUploadArtefactInput {
  meetingId: string;
  artefactId: string;
  bytes: Buffer;
  mime: string;
  label?: string;
  sharedBy: string;
}

export interface HubBridgeUploadArtefactResult {
  ok: true;
  artefactId: string;
}

/** v0.7.0 — transient composing/"typing" presence fanned to guests. */
export interface HubBridgePublishTypingInput {
  meetingId: string;
  peerId: string;
  displayName?: string;
  state: 'start' | 'stop';
}

export interface HubBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly connected: boolean;
  onWelcome(listener: (welcome: HubBridgeWelcome) => void): () => void;
  /**
   * Subscribe to guest chat turns arriving over the bridge. Host typically
   * calls `meetingRegistry.appendTurn(meetingId, { from: peerId, body,
   * kind: 'human' })` so Athena's `notifyMainOnHumanTurn` hook fires.
   * Returns an unsubscribe function.
   */
  onGuestTurn(listener: (frame: HubBridgeGuestTurnFrame) => void): () => void;
  /** Subscribe to guest-join notifications (after their WS opens on the Hub). */
  onGuestJoined(listener: (frame: HubBridgeGuestJoinedFrame) => void): () => void;
  /** Subscribe to guest-disconnect notifications. */
  onGuestLeft(listener: (frame: HubBridgeGuestLeftFrame) => void): () => void;
  /** Subscribe to artefact-shared notifications. */
  onArtefactShared(listener: (frame: HubBridgeArtefactSharedFrame) => void): () => void;
  fetchArtefact(meetingId: string, artefactId: string): Promise<HubBridgeFetchedArtefact>;
  mintInvite(input: HubBridgeMintInviteInput): Promise<HubBridgeMintedInvite>;
  queryHistory(input: HubBridgeHistoryQuery): Promise<HubBridgeHistoryResult>;
  readArtefactExtraction(
    input: HubBridgeReadArtefactInput,
  ): Promise<HubBridgeReadArtefactResult>;
  invokePlugin(input: HubBridgeInvokePluginInput): Promise<HubBridgeInvokePluginResult>;
  openPresentation(
    input: HubBridgeOpenPresentationInput,
  ): Promise<HubBridgeOpenPresentationResult>;
  navigatePresentation(
    input: HubBridgeNavigatePresentationInput,
  ): Promise<HubBridgeNavigatePresentationResult>;
  closePresentation(input: HubBridgeClosePresentationInput): Promise<{ ok: true }>;
  /**
   * v0.6.0 — capability introspection. Asks the Hub which plugins are
   * loaded + enabled for the current tenant. Returns a list with one
   * entry per plugin including mime/extension filters, supportsInvoke,
   * and a `configured` hint for credential-gated plugins. Use this to
   * plan agent behaviour without round-tripping a failed invoke.
   */
  listPlugins(input?: HubBridgePluginListInput): Promise<HubBridgePluginListResult>;
  /**
   * v0.8.0 — push per-tenant plugin config (provider keys, models, voices,
   * enable toggles) to the Hub. Stored ENCRYPTED under the tenant vault;
   * applies on the next invocation (no restart). The bridge auto-pushes the
   * operator's `config.plugins` on every (re)connect; this method is for
   * explicit / runtime pushes (e.g. the `set_plugin_config` tool). Omit an
   * entry's `config` to toggle `enabled` only. Secrets are never echoed back.
   */
  setPluginConfig(
    configs: HubBridgePluginConfigEntry[],
  ): Promise<HubBridgePluginConfigResult>;
  /**
   * v0.6.0 outbound publish — mirror local meeting state up to the Hub so
   * the guest UI stays live. The host wires these to its
   * `meetingRegistry.onChange` subscription. All fire-and-forget; the
   * Hub's handlers are idempotent.
   *
   * `publishMeetingOpened` upserts the meeting (same wire frame as the
   * `publish_to_hub` tool — call it on first-live so guests can join).
   * `publishTurn` is the one that fixes the "agent's replies never reach
   * the Hub" gap. `publishAttendeeChanged` / `publishMeetingAdjourned`
   * keep the roster + lifecycle in sync.
   */
  publishMeetingOpened(input: HubBridgePublishMeetingOpenedInput): void;
  publishTurn(input: HubBridgePublishTurnInput): void;
  publishAttendeeChanged(input: HubBridgePublishAttendeeChangedInput): void;
  publishMeetingAdjourned(input: HubBridgePublishMeetingAdjournedInput): void;

  /** v0.7.0 — upload a shared file's bytes to the Hub (chunked). */
  uploadArtefact(
    input: HubBridgeUploadArtefactInput,
  ): Promise<HubBridgeUploadArtefactResult>;

  /** v0.7.0 — emit a transient composing/"typing" indicator to guests. */
  publishTyping(input: HubBridgePublishTypingInput): void;
}
