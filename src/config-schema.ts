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

export const ConfigSchema = z
  .object({
    url: z.string().url().refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
      message: 'url must be ws:// or wss://',
    }),
    /** Pre-issued bridge token. Skip when using bootstrap enrollment. */
    token: z.string().min(20).optional(),
    /**
     * Shared bootstrap secret for /bridge/enroll. Read from this config
     * field first, then process.env.SWARMAI_HUB_BOOTSTRAP_SECRET. Use the
     * env-var path for org-wide deploys so plugins.yaml stays secret-free.
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
  })
  .superRefine((cfg, ctx) => {
    const hasToken = typeof cfg.token === 'string' && cfg.token.length > 0;
    const hasBootstrap = typeof cfg.bootstrapSecret === 'string' && cfg.bootstrapSecret.length > 0;
    const hasEnvBootstrap = typeof process.env['SWARMAI_HUB_BOOTSTRAP_SECRET'] === 'string';
    if (!hasToken && !hasBootstrap && !hasEnvBootstrap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must provide one of: config.token, config.bootstrapSecret, ' +
          'or env SWARMAI_HUB_BOOTSTRAP_SECRET',
        path: ['token'],
      });
    }
  });

export type ConfigSchemaT = z.infer<typeof ConfigSchema>;
