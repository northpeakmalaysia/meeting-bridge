/**
 * Zero-touch enrollment client.
 *
 * On first start with no stored bridge token, POST to <hub>/bridge/enroll
 * with the shared bootstrap secret + this installation's UUID. The Hub
 * returns either:
 *   - 201 with a freshly-issued tenant + bridge token (first time), or
 *   - 200 with the existing tenant + a rotated token (re-enrollment), or
 *   - 401 / 403 / 404 with an error code (handled by callers)
 *
 * Pure HTTPS — uses the Hub's REST surface, not the bridge WSS. The
 * resulting token is what the plugin then uses to open the bridge.
 */

import { hostname as osHostname } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

export interface EnrollInput {
  /** Hub URL — usually derived from config.url (wss://) → https://. */
  hubBaseUrl: string;
  /** Shared bootstrap secret. */
  bootstrapSecret: string;
  /** Installation UUID from <workspace>/.swarmai/installation-id. */
  installationId: string;
  /** Defaults to os.hostname() — overridable for testing. */
  hostname?: string;
  /** Optional curated slug. */
  preferredSlug?: string;
}

export interface EnrollResult {
  tenantId: string;
  slug: string;
  displayName: string;
  bridgeToken: string;
  /** wss:// URL the Hub recommends — operator config.url wins. */
  bridgeUrl: string;
  reEnrolled: boolean;
}

export class EnrollmentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

/**
 * Translate a bridge WSS URL (`wss://host/bridge`) into the HTTPS origin
 * the enroll endpoint is served from (`https://host/bridge/enroll`).
 * Preserves host + port; flips scheme; ignores caller-supplied path.
 */
export function bridgeUrlToEnrollUrl(bridgeUrl: string): string {
  const u = new URL(bridgeUrl);
  const httpScheme = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${httpScheme}//${u.host}/bridge/enroll`;
}

export async function enrollWithHub(input: EnrollInput): Promise<EnrollResult> {
  const url = bridgeUrlToEnrollUrl(input.hubBaseUrl);
  const body = JSON.stringify({
    bootstrapSecret: input.bootstrapSecret,
    installationId: input.installationId,
    hostname: input.hostname ?? safeHostname(),
    firstSeen: Date.now(),
    ...(input.preferredSlug ? { preferredSlug: input.preferredSlug } : {}),
  });

  const { status, json } = await postJson(url, body);
  if (status === 200 || status === 201) {
    if (
      typeof json !== 'object' ||
      json === null ||
      typeof (json as Record<string, unknown>)['bridgeToken'] !== 'string'
    ) {
      throw new EnrollmentError(status, 'invalid_response', 'enrollment response shape invalid');
    }
    const r = json as Record<string, unknown>;
    return {
      tenantId: String(r['tenantId']),
      slug: String(r['slug']),
      displayName: String(r['displayName'] ?? r['slug']),
      bridgeToken: String(r['bridgeToken']),
      bridgeUrl: String(r['bridgeUrl'] ?? input.hubBaseUrl),
      reEnrolled: Boolean(r['reEnrolled']),
    };
  }
  const code =
    typeof json === 'object' && json !== null
      ? String((json as Record<string, unknown>)['error'] ?? `http_${status}`)
      : `http_${status}`;
  throw new EnrollmentError(status, code, `enrollment failed: ${status} ${code}`);
}

function safeHostname(): string {
  try {
    return osHostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

interface PostResult {
  status: number;
  json: unknown;
}

function postJson(url: string, body: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedJson: unknown = null;
          try {
            parsedJson = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            parsedJson = text;
          }
          resolve({ status: res.statusCode ?? 0, json: parsedJson });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
