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
export declare class EnrollmentError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/**
 * Translate a bridge WSS URL (`wss://host/bridge`) into the HTTPS origin
 * the enroll endpoint is served from (`https://host/bridge/enroll`).
 * Preserves host + port; flips scheme; ignores caller-supplied path.
 */
export declare function bridgeUrlToEnrollUrl(bridgeUrl: string): string;
export declare function enrollWithHub(input: EnrollInput): Promise<EnrollResult>;
//# sourceMappingURL=enroll.d.ts.map