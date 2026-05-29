/**
 * Operator-supplied config (mirrors `configSchema` in manifest.yaml).
 * Uses zod directly rather than the @swarmai/shared re-export so the
 * compiled bundle has no bare @swarmai/* runtime imports that the host
 * would need to resolve.
 *
 * v0.2.0 — `token` is now optional. Two paths to a working bridge:
 *   1. Explicit-provisioning path (legacy):
 *        Operator pastes a pre-issued `token` from
 *        POST /admin/tenants. Plugin authenticates with it directly.
 *   2. Zero-touch enrollment path:
 *        Operator (or org-wide deploy automation) sets
 *        `bootstrapSecret` (or env var SWARMAI_HUB_BOOTSTRAP_SECRET).
 *        On first start with no stored token, plugin POSTs to
 *        /bridge/enroll with the bootstrap secret + the installation's
 *        UUID and stores the returned token in
 *        <workspace>/.swarmai/meeting-bridge/state.json (mode 0600).
 *
 * v0.5.0 — open-enrollment path:
 *        All three credential fields may be absent. The plugin attempts
 *        a secret-less POST /bridge/enroll. The Hub accepts the request
 *        only when its super-admin has set HUB_BOOTSTRAP_OPEN_ENROLLMENT=true;
 *        otherwise the Hub returns 401 and the plugin surfaces a clear
 *        error to the operator. The hard-fail refine that used to reject
 *        all-blank configs at parse time is gone — the plugin reaches
 *        the enrollment attempt and the failure mode (success vs 401)
 *        becomes visible upstream instead of being hidden behind a parse
 *        error.
 */
import { z } from 'zod';

export const ConfigSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
    message: 'url must be ws:// or wss://',
  }),
  /** Pre-issued bridge token. Skip when using bootstrap enrollment. */
  token: z.string().min(20).optional(),
  /**
   * Shared bootstrap secret for /bridge/enroll. Read from this config
   * field first, then process.env.SWARMAI_HUB_BOOTSTRAP_SECRET. Use the
   * env-var path for org-wide deploys so plugins.yaml stays secret-free.
   *
   * v0.5.0: all three credentials may be absent — the plugin will then
   * attempt open-enrollment against the Hub (succeeds only if the Hub
   * has HUB_BOOTSTRAP_OPEN_ENROLLMENT=true).
   */
  bootstrapSecret: z.string().min(20).optional(),
  /** Exact slug the Hub must announce on bridge.welcome. */
  expectedTenantSlug: z.string().optional(),
  /**
   * Prefix the announced slug must start with — useful with auto-enrolled
   * slugs like `acmecorp-laptop-7f3a91c2` where the suffix varies per
   * install but the prefix is your org marker. Either-or with
   * expectedTenantSlug; exactSlug wins when both are set.
   */
  expectedTenantSlugPrefix: z.string().optional(),
  artefactSizeLimitMb: z.number().int().positive().default(50),
  artefactChunkKb: z.number().int().positive().default(256),
  reconnectInitialMs: z.number().int().nonnegative().default(1000),
  reconnectMaxMs: z.number().int().positive().default(60_000),
  /**
   * Per-Hub-plugin configuration the bridge pushes to the Hub on every
   * (re)connect via `bridge.plugin.config.set`. Keyed by Hub pluginId.
   * Each entry's `enabled` toggles the plugin for this tenant; ALL OTHER
   * keys are sent as the plugin's `config` (provider / apiKey / model /
   * voice / ...) and stored ENCRYPTED under the tenant vault on the Hub,
   * applied on the next invocation (no Hub restart).
   *
   * Example (plugins.yaml):
   *   plugins:
   *     text-to-voice: { enabled: true, provider: openai-tts, apiKey: sk-..., voice: alloy }
   *     voice-to-text: { enabled: true, provider: openai-whisper, apiKey: sk-... }
   *
   * Security: these values live in plugins.yaml in plaintext on the
   * operator's host. They travel to the Hub only over the (TLS) bridge and
   * are encrypted at rest there; they are never logged. Prefer env
   * interpolation in plugins.yaml if your loader supports it.
   */
  plugins: z
    .record(z.string(), z.object({ enabled: z.boolean().optional() }).catchall(z.unknown()))
    .optional(),
  // Flat dashboard-friendly fields for the two credential-gated Hub plugins.
  // The dashboard Configure dialog renders flat fields only (no nested
  // objects), so these mirror what `plugins['text-to-voice']` /
  // `plugins['voice-to-text']` would hold. `buildPluginConfigEntries`
  // folds them into the bridge.plugin.config.set push alongside `plugins`.
  ttsEnabled: z.boolean().optional(),
  ttsProvider: z.string().optional(),
  ttsApiKey: z.string().optional(),
  ttsVoice: z.string().optional(),
  ttsModel: z.string().optional(),
  /**
   * Delivery-style guidance for the Hub text-to-voice plugin. Only OpenAI
   * `gpt-4o-mini-tts` honours it; ignored by tts-1/tts-1-hd and local-piper.
   * Folded into the push as the plugin's `instructions` config key.
   */
  ttsInstructions: z.string().optional(),
  ttsAutoNarrate: z.boolean().optional(),
  sttEnabled: z.boolean().optional(),
  sttProvider: z.string().optional(),
  sttApiKey: z.string().optional(),
  sttLanguage: z.string().optional(),
  sttModel: z.string().optional(),
});

export type ConfigSchemaT = z.infer<typeof ConfigSchema>;

/**
 * Classify the credential state at boot. Lets the entry point pick
 * between the legacy token path, the bcrypt-gated bootstrap path, and
 * the v0.5.0 open-enrollment attempt without re-checking the same
 * three fields in multiple places.
 *
 * Reads `process.env.SWARMAI_HUB_BOOTSTRAP_SECRET` directly because the
 * env-var-only deploy pattern (no secret in plugins.yaml) is a
 * supported config — this helper hides that detail from callers.
 */
export type CredentialMode = 'token' | 'bootstrap' | 'open-enroll';

export function classifyCredentials(cfg: ConfigSchemaT): {
  mode: CredentialMode;
  effectiveBootstrapSecret?: string;
} {
  if (typeof cfg.token === 'string' && cfg.token.length > 0) {
    return { mode: 'token' };
  }
  if (typeof cfg.bootstrapSecret === 'string' && cfg.bootstrapSecret.length > 0) {
    return { mode: 'bootstrap', effectiveBootstrapSecret: cfg.bootstrapSecret };
  }
  const envSecret = process.env['SWARMAI_HUB_BOOTSTRAP_SECRET'];
  if (typeof envSecret === 'string' && envSecret.length > 0) {
    return { mode: 'bootstrap', effectiveBootstrapSecret: envSecret };
  }
  return { mode: 'open-enroll' };
}
