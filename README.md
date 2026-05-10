# @swarmai/meeting-bridge

> **SwarmAI plugin** — connects the CEO Agent to a [SwarmAI Meeting Hub](https://hub.northpeak.app) so external guests can join meetings as `human-external` attendees in the operator's `MeetingRegistry`.

After the operator installs this from the Hub pane:

- Athena can mint share links via `swarm_admin.meeting.share_link`
- Guests joining via those links appear in the live meeting transcript with `kind: 'human-external'`
- Files shared by guests appear in the operator's artefact strip with `ref: 'hub://...'`
- Athena can query Hub-side history (FTS5 over transcripts + extracted artefact text) via `swarm_admin.meeting.history`
- Athena can drive live presentations via `swarm_admin.meeting.present.{open,navigate,close}`

**The CEO Agent stays private** — the bridge is a single outbound WSS to the Hub. NAT, firewalls, dynamic IPs all fine.

## Install

From the SwarmAI dashboard's Hub pane: search "Meeting Bridge", click Install, paste the bridge token + URL provided by the Hub super-admin, restart.

## Configure

```yaml
plugins:
  '@swarmai/meeting-bridge':
    config:
      url: wss://hub.example.com/bridge
      token: <vault-encrypted>
      expectedTenantSlug: acme-corp
      artefactSizeLimitMb: 50
      reconnectInitialMs: 1000
      reconnectMaxMs: 60000
```

`token` and `url` come from your Hub super-admin (one-time provisioning per tenant).

## Tools registered

| Tool | Policy | Description |
|---|---|---|
| `swarm_admin.meeting.share_link` | `master` | Mint a Hub share link for an existing meeting. |
| `swarm_admin.meeting.history` | `open` | Query Hub-side meetings + transcripts + extracted artefact text. |
| `swarm_admin.meeting.read_artefact` | `open` | Return full extracted text for a specific artefact. |
| `swarm_admin.meeting.speak` | `master` | Render text to audio via Hub TTS plugin and attach as artefact. |
| `swarm_admin.meeting.present.open` | `master` | Take control of a live presentation. |
| `swarm_admin.meeting.present.navigate` | `open` | Move presentation to a specific page (controller-only). |
| `swarm_admin.meeting.present.close` | `master` | End a live presentation. |

## Source

- Hub manifest: `packages/official/meeting-bridge/manifest.yaml` in [`swarmai-hub`](https://github.com/northpeak/swarmai-hub).
- Plugin SDK: [`@swarmai/plugin-sdk`](https://github.com/northpeak/swarmai/tree/main/packages/plugin-sdk).
- Bridge protocol: [`docs/ceo-agent-integration-guide.md`](https://github.com/northpeak/swarmai-meeting-hub/blob/main/docs/ceo-agent-integration-guide.md) in the Meeting Hub repo.

## License

MIT.
