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
export declare const ConfigSchema: z.ZodObject<{
    url: z.ZodEffects<z.ZodString, string, string>;
    /** Pre-issued bridge token. Skip when using bootstrap enrollment. */
    token: z.ZodOptional<z.ZodString>;
    /**
     * Shared bootstrap secret for /bridge/enroll. Read from this config
     * field first, then process.env.SWARMAI_HUB_BOOTSTRAP_SECRET. Use the
     * env-var path for org-wide deploys so plugins.yaml stays secret-free.
     *
     * v0.5.0: all three credentials may be absent — the plugin will then
     * attempt open-enrollment against the Hub (succeeds only if the Hub
     * has HUB_BOOTSTRAP_OPEN_ENROLLMENT=true).
     */
    bootstrapSecret: z.ZodOptional<z.ZodString>;
    /** Exact slug the Hub must announce on bridge.welcome. */
    expectedTenantSlug: z.ZodOptional<z.ZodString>;
    /**
     * Prefix the announced slug must start with — useful with auto-enrolled
     * slugs like `acmecorp-laptop-7f3a91c2` where the suffix varies per
     * install but the prefix is your org marker. Either-or with
     * expectedTenantSlug; exactSlug wins when both are set.
     */
    expectedTenantSlugPrefix: z.ZodOptional<z.ZodString>;
    artefactSizeLimitMb: z.ZodDefault<z.ZodNumber>;
    artefactChunkKb: z.ZodDefault<z.ZodNumber>;
    reconnectInitialMs: z.ZodDefault<z.ZodNumber>;
    reconnectMaxMs: z.ZodDefault<z.ZodNumber>;
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
    plugins: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodUnknown, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodUnknown, "strip">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodUnknown, "strip">>>>;
    ttsEnabled: z.ZodOptional<z.ZodBoolean>;
    ttsProvider: z.ZodOptional<z.ZodString>;
    ttsApiKey: z.ZodOptional<z.ZodString>;
    ttsVoice: z.ZodOptional<z.ZodString>;
    ttsModel: z.ZodOptional<z.ZodString>;
    /**
     * Delivery-style guidance for the Hub text-to-voice plugin. Only OpenAI
     * `gpt-4o-mini-tts` honours it; ignored by tts-1/tts-1-hd and local-piper.
     * Folded into the push as the plugin's `instructions` config key.
     */
    ttsInstructions: z.ZodOptional<z.ZodString>;
    ttsAutoNarrate: z.ZodOptional<z.ZodBoolean>;
    sttEnabled: z.ZodOptional<z.ZodBoolean>;
    sttProvider: z.ZodOptional<z.ZodString>;
    sttApiKey: z.ZodOptional<z.ZodString>;
    sttLanguage: z.ZodOptional<z.ZodString>;
    sttModel: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    url: string;
    artefactSizeLimitMb: number;
    artefactChunkKb: number;
    reconnectInitialMs: number;
    reconnectMaxMs: number;
    token?: string | undefined;
    bootstrapSecret?: string | undefined;
    expectedTenantSlug?: string | undefined;
    expectedTenantSlugPrefix?: string | undefined;
    plugins?: Record<string, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodUnknown, "strip">> | undefined;
    ttsEnabled?: boolean | undefined;
    ttsProvider?: string | undefined;
    ttsApiKey?: string | undefined;
    ttsVoice?: string | undefined;
    ttsModel?: string | undefined;
    ttsInstructions?: string | undefined;
    ttsAutoNarrate?: boolean | undefined;
    sttEnabled?: boolean | undefined;
    sttProvider?: string | undefined;
    sttApiKey?: string | undefined;
    sttLanguage?: string | undefined;
    sttModel?: string | undefined;
}, {
    url: string;
    token?: string | undefined;
    bootstrapSecret?: string | undefined;
    expectedTenantSlug?: string | undefined;
    expectedTenantSlugPrefix?: string | undefined;
    artefactSizeLimitMb?: number | undefined;
    artefactChunkKb?: number | undefined;
    reconnectInitialMs?: number | undefined;
    reconnectMaxMs?: number | undefined;
    plugins?: Record<string, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodUnknown, "strip">> | undefined;
    ttsEnabled?: boolean | undefined;
    ttsProvider?: string | undefined;
    ttsApiKey?: string | undefined;
    ttsVoice?: string | undefined;
    ttsModel?: string | undefined;
    ttsInstructions?: string | undefined;
    ttsAutoNarrate?: boolean | undefined;
    sttEnabled?: boolean | undefined;
    sttProvider?: string | undefined;
    sttApiKey?: string | undefined;
    sttLanguage?: string | undefined;
    sttModel?: string | undefined;
}>;
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
export declare function classifyCredentials(cfg: ConfigSchemaT): {
    mode: CredentialMode;
    effectiveBootstrapSecret?: string;
};
//# sourceMappingURL=config-schema.d.ts.map