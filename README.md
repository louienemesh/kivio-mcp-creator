# @kivio/mcp-creator

MCP server for the KiVio creator surface. Drive your KiVio Studio from
Claude Code (or any Model Context Protocol client): upload videos,
manage series, respond to commission requests, see earnings, request
admin deletion.

> KiVio is an ad-free short-form AI-cartoon platform for kids. Creators
> earn direct coins from paying parents (70/30 split, no ad lottery).
> This package lets you drive the creator half of the economy from your
> terminal / AI coding environment instead of the web dashboard.

---

## Install

```bash
npm install -g @kivio/mcp-creator
```

Verify:

```bash
kivio-mcp status
# > Not linked.
```

## Link your creator account

1. Open <https://kidsaivideo.com/creator/dashboard> and sign in.
2. Scroll to **Link external tools**, click **Generate link code**.
3. Copy the code (looks like `MCP-ABC-234-DEF`, valid 10 minutes).
4. In your terminal:

   ```bash
   kivio-mcp link MCP-ABC-234-DEF
   ```

   Expected output:
   ```
   Linked as Astroludo (astro@example.com).
   Token saved to /Users/you/.kivio/token.json.
   ```

The token is a 90-day KiVio creator session. Rotate anytime via
`kivio-mcp unlink` + mint a new code in Studio.

## Wire into Claude Code

Add to `~/.claude/mcp.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "kivio": {
      "command": "kivio-mcp"
    }
  }
}
```

Restart Claude Code. In any session you can now say:

> "Upload the mp4 at ~/renders/ep3.mp4 as episode 3 of my Rocket
> Baker series, title 'The Rising Dough'."

Claude will call `kivio.upload_video` and the moderation pipeline
starts. Status rolls into `kivio.list_videos` within seconds.

## Available tools

| Tool | What it does |
|------|--------------|
| `kivio.link_account`           | Pair this install via a one-time code from Studio |
| `kivio.whoami`                 | Linked creator profile + wallet |
| `kivio.list_series`            | Your series |
| `kivio.list_videos`            | Your uploads (filter by series or state) |
| `kivio.get_earnings`           | Available / pending / lifetime earnings |
| `kivio.create_series`          | New series (title + planned episodes + bucket flags) |
| `kivio.upload_video`           | Presign → PUT to S3 → register, in one call |
| `kivio.replace_video`          | Swap bytes on a SAFE_LIVE video, keep unlocks |
| `kivio.list_commissions`       | Open commissions (filter by status) |
| `kivio.get_commission`         | One commission + last 20 chat messages |
| `kivio.accept_commission`      | Accept a proposal, debit the parent, start the 14-day deliver window |
| `kivio.counter_commission`     | Counter the offered price |
| `kivio.reject_commission`      | Decline (terminal) |
| `kivio.deliver_commission`     | Attach a video to a commission (must sit in a `PUBLIC_COMMISSION` or `PRIVATE_COMMISSION` series) |
| `kivio.reply_in_thread`        | DM reply (server-side contact-info scrubber runs on every message) |
| `kivio.request_video_deletion` | Submit a SAFE_LIVE video for admin removal |

## Environment overrides

- `KIVIO_API_BASE` — base URL for the KiVio API. Defaults to
  `https://api.kidsaivideo.com`. Point at a local dev server for
  testing.

## CLI commands (outside MCP)

```bash
kivio-mcp link <code>    # link this install to a creator account
kivio-mcp status         # show who's linked
kivio-mcp unlink         # clear the stored token
kivio-mcp                # run the MCP server over stdio (Claude Code invokes this)
```

## Security

- Token stored at `~/.kivio/token.json` with mode `0600`.
- Each tool call authenticates with the stored bearer token.
- The web Studio **Link external tools** panel shows the mint
  timestamp of every active token; revoke there if a device is lost.
- Contact info (email, phone, URLs, social handles, messenger app
  names) is scrubbed server-side from every DM reply before it's
  stored, regardless of which tool wrote the message.

## License

UNLICENSED. Use only with a KiVio creator account.
