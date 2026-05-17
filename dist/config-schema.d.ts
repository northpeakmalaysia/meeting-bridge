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
 *   2. Zero-touch enrollment path (new):
 *        Operator (or org-wide deploy automation) sets
 *        `bootstrapSecret` (or env var SWARMAI_HUB_BOOTSTRAP_SECRET).
 *        On first start with no stored token, plugin POSTs to
 *        /bridge/enroll with the bootstrap secret + the installation's
 *        UUID and stores the returned token in
 *        <workspace>/.swarmai/meeting-bridge/state.json (mode 0600).
 *
 * At least one of {token, bootstrapSecret, env SWARMAI_HUB_BOOTSTRAP_SECRET}
 * must be present at boot — see the post-parse refine.
 */
import { z } from 'zod';
export declare const ConfigSchema: z.ZodEffects<z.ZodObject<{
    url: z.ZodEffects<z.ZodString, string, string>;
    /** Pre-issued bridge token. Skip when using bootstrap enrollment. */
    token: z.ZodOptional<z.ZodString>;
    /**
     * Shared bootstrap secret for /bridge/enroll. Read from this config
     * field first, then process.env.SWARMAI_HUB_BOOTSTRAP_SECRET. Use the
     * env-var path for org-wide deploys so plugins.yaml stays secret-free.
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
}>, {
    url: string;
    artefactSizeLimitMb: number;
    artefactChunkKb: number;
    reconnectInitialMs: number;
    reconnectMaxMs: number;
    token?: string | undefined;
    bootstrapSecret?: string | undefined;
    expectedTenantSlug?: string | undefined;
    expectedTenantSlugPrefix?: string | undefined;
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
}>;
export type ConfigSchemaT = z.infer<typeof ConfigSchema>;
//# sourceMappingURL=config-schema.d.ts.map