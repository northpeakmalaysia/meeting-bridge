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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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

const DIR_NAME = 'meeting-bridge';
const FILE_NAME = 'state.json';

/**
 * Resolve the workspace root the way the WhatsApp plugin does:
 * prefer SWARMAI_WORKSPACE env, fall back to process.cwd().
 * Pure — never creates anything.
 */
export function resolveWorkspaceRoot(): string {
  return process.env['SWARMAI_WORKSPACE'] ?? process.cwd();
}

export function statePath(workspaceRoot?: string): string {
  const root = workspaceRoot ?? resolveWorkspaceRoot();
  return join(root, '.swarmai', DIR_NAME, FILE_NAME);
}

/**
 * Read the state file if present. Returns null when missing or unreadable
 * (treat unknowable as "no state" so the enrollment path runs).
 */
export function readState(workspaceRoot?: string): BridgeSessionState | null {
  const p = statePath(workspaceRoot);
  try {
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BridgeSessionState>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.slug !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      parsed.stateVersion !== 1
    ) {
      return null;
    }
    return {
      token: parsed.token,
      tenantId: parsed.tenantId,
      slug: parsed.slug,
      issuedAt: parsed.issuedAt,
      stateVersion: 1,
    };
  } catch {
    return null;
  }
}

/**
 * Write state atomically-ish: ensure dir exists, write file, chmod 0600.
 * No locking — the plugin is single-instance per workspace by design.
 */
export function writeState(state: BridgeSessionState, workspaceRoot?: string): void {
  const root = workspaceRoot ?? resolveWorkspaceRoot();
  const dir = join(root, '.swarmai', DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    safeChmod(dir, 0o700);
  }
  const path = join(dir, FILE_NAME);
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  safeChmod(path, 0o600);
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows / network shares can refuse chmod. The state file still
    // sits inside the operator's workspace dir, which itself should be
    // user-readable only via standard workspace hygiene.
  }
}
