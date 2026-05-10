/**
 * Type shims for SwarmAI peer-deps so this plugin can typecheck without
 * the live `@swarmai/plugin-sdk` and `@swarmai/shared` packages installed.
 *
 * The real types are richer (see docs/PLUGIN-API.md in the SwarmAI Hub
 * repo); these shims declare only the surface this plugin actually uses.
 * When the SDK ships to npm, drop this file and add `@swarmai/plugin-sdk`
 * + `@swarmai/shared` to dependencies.
 */

declare module '@swarmai/plugin-sdk' {
  import type { ZodTypeAny, infer as ZodInfer } from 'zod';

  export interface ToolContext {
    sessionId?: string;
    agentId?: string;
    isMain?: boolean;
    currentTier?: 'heavy' | 'average' | 'simple';
  }

  export interface ToolDef<S extends ZodTypeAny = ZodTypeAny, O = unknown> {
    name: string;
    toolset: string;
    description: string;
    schema: S;
    handler: (input: ZodInfer<S>, ctx?: ToolContext) => Promise<O>;
    emoji?: string;
    policy?: 'open' | 'pair-gated' | 'master';
    requiresApproval?: boolean;
    maxResultSize?: number;
    minTier?: 'heavy' | 'average' | 'simple';
  }

  export interface PluginAPI {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool(tool: ToolDef<any, any>): void;
    /** Optional logger surface; available on some Hub versions. */
    logger?: {
      info: (msg: string, fields?: Record<string, unknown>) => void;
      warn: (msg: string, fields?: Record<string, unknown>) => void;
      error: (msg: string, fields?: Record<string, unknown>) => void;
    };
  }

  export type PluginEntry = (api: PluginAPI, config?: unknown) => void | Promise<void>;
}

declare module '@swarmai/shared' {
  // Minimal zod re-export — the real package re-exports the full zod surface.
  export { z } from 'zod';
}
