// Entry point for MCP mode: one bot, no built-in LLM. An external agent (e.g. Claude Code)
// controls it through the MCP server. Configuration via environment variables, see MCP.md.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import path from 'path';
import baseSettings from './settings.js';
import { setSettings } from './src/agent/settings.js';

const env = process.env;
const dataDir = env.DATA_DIR || './bots/mcp';
mkdirSync(path.join(dataDir, 'auth'), { recursive: true });

const defaults = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));

setSettings({
    ...baseSettings,
    host: env.MC_HOST || '127.0.0.1',
    port: Number(env.MC_PORT || 25565),
    auth: env.MC_AUTH || 'offline',
    minecraft_version: env.MC_VERSION || 'auto',
    bot_name: env.BOT_NAME || 'Claude',
    bot_aliases: (env.BOT_ALIASES || '').split(',').map(a => a.trim()).filter(Boolean),
    bot_options: { profilesFolder: path.resolve(dataDir, 'auth') },
    mcp_port: Number(env.MCP_PORT || 3100),
    mcp_token: env.MCP_TOKEN || '',
    spawn_timeout: Number(env.SPAWN_TIMEOUT || 60),
    // no built-in LLM, no code execution, no narration spam
    allow_insecure_coding: false,
    allow_vision: false,
    speak: false,
    render_bot_view: false,
    narrate_behavior: false,
    chat_ingame: true,
    language: 'en',
    only_chat_with: [],
    blocked_actions: [
        '!newAction', '!restart', '!clearChat', '!stfu', '!goal', '!endGoal',
        '!startConversation', '!endConversation', '!attackPlayer', '!lookAtPlayer', '!lookAtPosition',
        '!checkBlueprint', '!checkBlueprintLevel', '!getBlueprint', '!getBlueprintLevel', '!help',
        ...JSON.parse(env.BLOCKED_ACTIONS || '[]'),
    ],
    // reflexes; hunting is off so the bot does not raid other players' animal farms
    modes: { ...defaults.modes, hunting: false, cheat: false, ...JSON.parse(env.MODES || '{}') },
    // fixed operator commands (teleport to a player, time, weather, flying) for an OP bot account
    op_tools: env.OP_TOOLS === 'on',
    immortal: env.IMMORTAL === 'on', // keep Resistance V on the bot (needs OP), see optools.js
    op_worlds: (env.OP_WORLDS || 'world').split(',').map(w => w.trim()).filter(Boolean),
    guard: { enabled: env.GUARD === 'on', radius: Number(env.GUARD_RADIUS || 5), minCount: Number(env.GUARD_MIN_COUNT || 4) },
});

if (!env.MCP_TOKEN && env.MCP_NO_AUTH !== '1') {
    console.error('MCP_TOKEN is not set. Set it, or MCP_NO_AUTH=1 for local tests only.');
    process.exit(2);
}

// persistent state: saved places, blocks the bot placed itself, notes, mode switches
const stateFile = path.join(dataDir, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
function saveState() {
    const { dirty, ...data } = state;
    writeFileSync(stateFile + '.tmp', JSON.stringify(data));
    renameSync(stateFile + '.tmp', stateFile);
    state.dirty = false;
}
setInterval(() => { if (state.dirty) saveState(); }, 30000);

// modules read settings at import time, so import them after setSettings()
const { McpAgent } = await import('./src/mcp/agent.js');
const { startMcpServer } = await import('./src/mcp/server.js');

const agent = new McpAgent(state, saveState);
startMcpServer(agent);
agent.connect();

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        try { agent.persist(); } catch (err) { console.error(err); }
        process.exit(0);
    });
}
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
