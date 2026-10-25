#!/usr/bin/env bash
# Starts a Claude Code session that plays Minecraft through the bot's MCP server.
# The session gets no built-in tools (no shell, no files, no web), only the Minecraft tools.
#
#   MC_BOT_URL=https://host/mcp MC_BOT_TOKEN=... ./play.sh [extra claude args]
#   MC_MODEL=opus ./play.sh        # model (default: sonnet)
set -euo pipefail
cd "$(dirname "$0")"
: "${MC_BOT_URL:?MC_BOT_URL is not set (e.g. http://localhost:3100/mcp)}"
: "${MC_BOT_TOKEN:?MC_BOT_TOKEN is not set}"
export MC_BOT_URL MC_BOT_TOKEN
# wait_for_events and long actions can take minutes
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-900000}"

exec claude \
  --model "${MC_MODEL:-sonnet}" \
  --tools "" \
  --strict-mcp-config --mcp-config mcp.json \
  --allowedTools "mcp__minecraft" \
  --append-system-prompt "$(cat PLAYER.md)" \
  "$@" \
  "${MC_START_PROMPT:-Du bist jetzt im Spiel. Verschaff dir mit status einen Überblick, begrüße kurz im Chat und spiel los.}"
