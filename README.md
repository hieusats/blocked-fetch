# reddit-fetch (pi skill)

Fetch content from Reddit via its JSON API, even when Reddit blocks curl/bots (403), using a DuckDuckGo-hop unlock through Playwright.

Adapted for [pi](https://github.com/badlogic/pi-mammoth) from the [reddit-fetch skill](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) in [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) (© YK Sugi). Tool references changed from Claude Code's `mcp__playwright__*` to pi's MCP gateway naming.

## Install

```bash
git clone https://github.com/hieusats/reddit-fetch ~/.pi/agent/skills/reddit-fetch
```

Or clone anywhere and add it to your pi `settings.json`:

```json
{
  "skills": ["/path/to/reddit-fetch"]
}
```

Requires the [Playwright MCP server](https://github.com/microsoft/playwright-mcp) configured in pi.

## Usage

Load it with `/skill:reddit-fetch`, or just ask pi to research something on Reddit — the skill activates when accessing Reddit URLs or when Reddit returns 403/blocked errors.
