# @swarmai/meeting-bridge

> **SwarmAI plugin** (v0.7.0) — connects the CEO Agent to a [SwarmAI Meeting Hub](https://meeting.northpeak.app) so external guests can join meetings as `human-external` attendees in the operator's `MeetingRegistry`, fully bidirectionally.

The bridge is a single **outbound** WSS from the CEO Agent to the Hub, so the Main Agent stays private — NAT, firewalls and dynamic IPs are all fine. After the operator installs it from the dashboard Hub pane:

- **Share links** — the Main Agent (e.g. *Athena*) mints guest invite URLs + 6-digit PINs via `swarm_admin.meeting.share_link`.
- **Bidirectional chat** — guest messages arrive in the live transcript *and* trigger the agent's reasoning loop; the agent's replies are mirrored back to the Hub guest UI in real time.
- **Delivery acknowledgement + typing** — guests see their message confirmed as delivered and an "*<Agent> is typing…*" indicator while the agent drafts a reply.
- **File mirror both ways** — files the agent/operator share (`file://` in the workspace, or `data:`) are auto-uploaded to the Hub so guests can download them; files guests upload land in the operator's artefact strip with a `hub://…` ref **and** notify the agent so it can read or present them.
- **Live presentations** — the agent drives a page-synced PDF/PPTX deck for the whole room via `swarm_admin.meeting.present.{open,navigate,close}`.
- **Guest identity** — the guest's display name **and email** flow to the agent (host-side only, never re-shared to other guests) so it can email meeting minutes / follow-ups.
- **History + extraction** — the agent queries Hub-side history (FTS5 over transcripts + extracted artefact text) via `swarm_admin.meeting.history` and reads a single file's extracted text via `read_artefact`.

## Install

From the SwarmAI dashboard **Hub** pane: search "Meeting Bridge" → **Install** → set the Hub `url`, then restart.

**Zero-touch enrollment** — you usually do **not** need to paste a token:

1. **Bootstrap secret** — paste the one-time `bootstrapSecret` from your Hub super-admin; the bridge enrolls itself and persists the issued token on first connect.
2. **Open enrollment** — leave both `token` and `bootstrapSecret` blank; if the Hub super-admin enabled `HUB_BOOTSTRAP_OPEN_ENROLLMENT`, the bridge self-enrolls with no secret at all.
3. **Explicit token** — paste a pre-provisioned `token` if your Hub requires manual provisioning.

The resolved token is cached at `<workspace>/.swarmai/meeting-bridge/state.json`; a token you set by hand is never overwritten by an auto-enrolled one.

## Configure

```yaml
plugins:
  '@swarmai/meeting-bridge':
    config:
      url: wss://meeting.example.com/bridge   # required
      token: <vault-encrypted>                # optional — see enrollment above
      bootstrapSecret: <one-time-secret>      # optional — auto-enroll then discard
      expectedTenantSlug: acme-corp           # optional — warns on slug mismatch
      artefactSizeLimitMb: 50
      reconnectInitialMs: 1000
      reconnectMaxMs: 60000
```

## Tools registered

| Tool | Policy | Description |
|---|---|---|
| `swarm_admin.meeting.share_link` | `master` | Mint a Hub share link (URL + 6-digit PIN + join-page URL) for a meeting. |
| `swarm_admin.meeting.publish_to_hub` | `master` | Mirror a local meeting up to the Hub. Usually automatic — the host auto-publishes on first-live and auto-forwards turns; kept for re-publish/recovery. |
| `swarm_admin.meeting.history` | `open` | Query Hub-side meetings + transcripts + extracted artefact text (FTS5). |
| `swarm_admin.meeting.read_artefact` | `open` | Return full extracted text + JSON for a specific artefact. |
| `swarm_admin.meeting.list_plugins` | `open` | List Hub plugins available to this tenant (mime/ext filters, invocability, `configured` hint) — plan before calling `speak` / `present.open`. |
| `swarm_admin.meeting.speak` | `master` | Render text to audio via the Hub TTS plugin and attach as a meeting artefact. |
| `swarm_admin.meeting.present.open` | `master` | Open a live, page-synced presentation for a shared PDF/PPTX. Caller becomes the controller. |
| `swarm_admin.meeting.present.navigate` | `open` | Move the open presentation to a specific page (controller-only). |
| `swarm_admin.meeting.present.close` | `master` | End a live presentation. |

## Presentation workflow

Only **PDF** and **PPTX** render as slides. To present the agent's own deck:

```text
1. document_create { path: "meeting-docs/deck.pptx", format: "pptx", slides: [...] }   # pptx is native, no external tools
2. swarm_admin.meeting.share { meetingId, ref: "file://<abs>/meeting-docs/deck.pptx", label: "deck.pptx" }   # auto-mirrored to the Hub
3. swarm_admin.meeting.present.open { meetingId, artefactId }                           # become controller
4. swarm_admin.meeting.ask { kind: "brief", body: "<talk track>" } + present.navigate { toPage }   # narrate + advance
5. swarm_admin.meeting.present.close
```

To present a file a **guest** uploaded, take its `artefactId` from the room artefacts / `meeting.history` and skip to step 3. PPTX rendering needs LibreOffice on the Hub host; PDF renders via pdfjs with no external binary.

## Source

- Plugin source: `F:\Published\Pluggins\swarmai-meeting-bridge\` (ships independently of the CEO Agent monorepo).
- Hub manifest: `packages/official/meeting-bridge/manifest.yaml` in the SwarmAI Hub repo.
- Bridge protocol + integration guide: `docs/ceo-agent-integration-guide.md` in the Meeting Hub repo.
- Contract is mirrored byte-for-byte between this plugin's `src/types/hub-bridge-contract.ts` and the host's `@swarmai/plugin-sdk/services/hub-bridge.ts` — keep them aligned on every release.

## License

MIT.
