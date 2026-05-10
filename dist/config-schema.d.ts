/**
 * Operator-supplied config (mirrors `configSchema` in manifest.yaml).
 * Validated with @swarmai/shared's zod re-export at runtime.
 */
import { z } from '@swarmai/shared';
export declare const ConfigSchema: z.ZodObject<{
    url: z.ZodEffects<z.ZodString, string, string>;
    token: z.ZodString;
    expectedTenantSlug: z.ZodOptional<z.ZodString>;
    artefactSizeLimitMb: z.ZodDefault<z.ZodNumber>;
    artefactChunkKb: z.ZodDefault<z.ZodNumber>;
    reconnectInitialMs: z.ZodDefault<z.ZodNumber>;
    reconnectMaxMs: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    url: string;
    token: string;
    artefactSizeLimitMb: number;
    artefactChunkKb: number;
    reconnectInitialMs: number;
    reconnectMaxMs: number;
    expectedTenantSlug?: string | undefined;
}, {
    url: string;
    token: string;
    expectedTenantSlug?: string | undefined;
    artefactSizeLimitMb?: number | undefined;
    artefactChunkKb?: number | undefined;
    reconnectInitialMs?: number | undefined;
    reconnectMaxMs?: number | undefined;
}>;
export type ConfigSchemaT = z.infer<typeof ConfigSchema>;
//# sourceMappingURL=config-schema.d.ts.map