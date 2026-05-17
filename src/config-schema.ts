/**
 * Operator-supplied config (mirrors `configSchema` in manifest.yaml).
 * Uses zod directly rather than the @swarmai/shared re-export so the
 * compiled bundle has no bare @swarmai/* runtime imports that the host
 * would need to resolve.
 */
import { z } from 'zod';

export const ConfigSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
    message: 'url must be ws:// or wss://',
  }),
  token: z.string().min(20),
  expectedTenantSlug: z.string().optional(),
  artefactSizeLimitMb: z.number().int().positive().default(50),
  artefactChunkKb: z.number().int().positive().default(256),
  reconnectInitialMs: z.number().int().nonnegative().default(1000),
  reconnectMaxMs: z.number().int().positive().default(60_000),
});

export type ConfigSchemaT = z.infer<typeof ConfigSchema>;
