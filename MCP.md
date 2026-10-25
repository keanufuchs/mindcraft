# MCP mode: let an external agent (Claude Code) play

This fork adds a second way to run Mindcraft. Instead of the built-in LLM loop, one bot runs
as a long-lived process and exposes its commands as an [MCP](https://modelcontextprotocol.io) server.
An agent such as Claude Code connects to it, reads chat and game events and decides what to do.

```
Claude Code ──MCP (HTTP)──▶ mcp.js (Mineflayer + Mindcraft skills/modes) ──▶ Minecraft server
```

What is reused from Mindcraft: all skills (`src/agent/library`), commands and queries
(`src/agent/commands`, exposed as MCP tools), reflex modes (`src/agent/modes.js`), the action manager.
What is replaced: Prompter, History, SelfPrompter, MindServer (`src/mcp/agent.js`).

## Tools

- every non-blocked Mindcraft command/query (`collectBlocks`, `craftRecipe`, `smeltItem`, `goToPlayer`, `stats`, `inventory`, ...)
- `wait_for_events`: chat, whispers, `action_done`, behaviors, damage, death, joins, disconnects
- `status`, `chat`, `whisper`, `place_blocks`, `break_block`, `note`, `nearby_players`

Long actions keep running; a call returns after at most 25 s (or earlier when a player chats)
and the result follows as an `action_done` event.

## Protection (`src/mcp/guard.js`)

Off by default, `GUARD=on` enables it. Players are never attacked either way. When enabled, these rules are enforced in code, independent of the prompt:

- no breaking of player-made blocks (planks, glass, doors, ...) unless the bot placed them itself,
  and no breaking of any block with ≥ 4 such blocks within 5 blocks (pathfinder and collectBlock skip them too)
- no opening of chests inside player builds unless the bot placed them
- no attacking players, named mobs, or animals in/near builds; `hunting` mode is off by default
- no server commands in chat, no `newAction` (code execution), no cheat mode

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `MC_HOST`, `MC_PORT` | `127.0.0.1`, `25565` | Minecraft server |
| `MC_VERSION` | `auto` | client protocol version, e.g. `1.21.11` (server may be newer with ViaBackwards) |
| `MC_AUTH` | `offline` | `microsoft` for online-mode servers; device-code login is printed to the log once |
| `BOT_NAME` | `Claude` | offline name / Microsoft account cache key |
| `BOT_ALIASES` | – | comma-separated display names of the bot (nickname plugins), so it ignores its own chat |
| `MCP_PORT` | `3100` | MCP endpoint `http://host:3100/mcp`, health `GET /health` |
| `MCP_TOKEN` | – | required Bearer token (`MCP_NO_AUTH=1` only for local tests) |
| `DATA_DIR` | `./bots/mcp` | `state.json` (places, own blocks, notes, modes) and `auth/` (Microsoft token cache) |
| `MODES` | – | JSON overrides, e.g. `{"torch_placing": false}` |
| `BLOCKED_ACTIONS` | – | JSON list of further commands to block |
| `GUARD` | off | `on` enables the build/chest/animal protection |
| `GUARD_RADIUS`, `GUARD_MIN_COUNT` | `5`, `4` | build protection heuristic |

Docker: `Dockerfile.mcp` (data in `/data`).

## Playing with Claude Code

`claude-player/play.sh` starts a Claude Code session with **no built-in tools** (no shell, files or web),
only this MCP server, and the player instructions from `claude-player/PLAYER.md`:

```bash
MC_BOT_URL=http://localhost:3100/mcp MC_BOT_TOKEN=... ./claude-player/play.sh
```
