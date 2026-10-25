// MCP server (Streamable HTTP, stateless) that exposes the bot to an external controller.
//
// Tools:
// - every Mindcraft command/query that is not blocked (collectBlocks, craftRecipe, goToPlayer, ...)
// - wait_for_events, status, chat, whisper, place_blocks, break_block, notes
//
// Long actions keep running in the bot. A tool call waits up to ACTION_WAIT_MS for the result,
// then returns and the result arrives later as an `action_done` event.

import express from 'express';
import { timingSafeEqual } from 'crypto';
import Vec3 from 'vec3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { actionsList } from '../agent/commands/actions.js';
import { queryList } from '../agent/commands/queries.js';
import { executeCommand } from '../agent/commands/index.js';
import * as skills from '../agent/library/skills.js';
import * as world from '../agent/library/world.js';
import settings from '../agent/settings.js';
import { formatEvent } from './events.js';
import { splitChat } from './agent.js';
import { opTools } from './optools.js';

const ACTION_WAIT_MS = 25000;
const MAX_WAIT_S = 600;

const TYPE_MAP = {
    int: 'integer', float: 'number', boolean: 'boolean',
    string: 'string', BlockName: 'string', ItemName: 'string', BlockOrItemName: 'string',
};
const TYPE_HINT = { BlockName: ' (block name, e.g. oak_log)', ItemName: ' (item name, e.g. iron_pickaxe)', BlockOrItemName: ' (block or item name)' };

export function startMcpServer(agent) {
    const commands = [...queryList, ...actionsList].filter(c => !agent.blocked_actions.includes(c.name));
    const commandTools = commands.map(c => ({
        name: c.name.substring(1),
        description: c.description + (actionsList.includes(c) ? ' [action]' : ' [query]'),
        inputSchema: commandSchema(c),
        command: c,
    }));
    const tools = [...customTools(), ...(settings.op_tools ? opTools(awaitAction) : []), ...commandTools];
    const byName = new Map(tools.map(t => [t.name, t]));

    function newServer() {
        const server = new Server({ name: 'mindcraft-bot', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (req) => {
            const tool = byName.get(req.params.name);
            if (!tool) return text(`Unknown tool ${req.params.name}`, true);
            const args = req.params.arguments || {};
            try {
                if (tool.run) return text(await tool.run(agent, args));
                return text(await runCommand(agent, tool.command, args));
            } catch (err) {
                console.error(`tool ${tool.name} failed:`, err);
                return text(`Error: ${err.message || err}`, true);
            }
        });
        return server;
    }

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    app.get('/health', (_req, res) => {
        res.json({ connected: agent.connected, name: agent.name, server: `${settings.host}:${settings.port}`, action: agent.actions.currentActionLabel || null });
    });

    app.use('/mcp', (req, res, next) => {
        if (!checkToken(req.headers.authorization)) {
            res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
            return;
        }
        next();
    });

    app.post('/mcp', async (req, res) => {
        const server = newServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error('MCP request failed:', err);
            if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
        }
    });
    const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    app.get('/mcp', notAllowed);
    app.delete('/mcp', notAllowed);

    const port = settings.mcp_port;
    app.listen(port, '0.0.0.0', () => console.log(`MCP server listening on :${port}/mcp (${tools.length} tools)`));
}

function checkToken(header) {
    const token = settings.mcp_token;
    if (!token) return true; // only allowed when explicitly started without token (see mcp.js)
    const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

function text(t, isError = false) {
    return { content: [{ type: 'text', text: String(t ?? '') || '(no output)' }], isError };
}

function commandSchema(command) {
    const properties = {};
    const required = [];
    for (const [name, p] of Object.entries(command.params || {})) {
        const prop = { type: TYPE_MAP[p.type] || 'string', description: p.description + (TYPE_HINT[p.type] || '') };
        if (p.domain && (prop.type === 'number' || prop.type === 'integer')) {
            const [lo, hi, ends = '[)'] = p.domain;
            if (Number.isFinite(lo)) prop[ends[0] === '[' ? 'minimum' : 'exclusiveMinimum'] = lo;
            if (Number.isFinite(hi) && hi < Number.MAX_SAFE_INTEGER) prop[ends[1] === ']' ? 'maximum' : 'exclusiveMaximum'] = hi;
        }
        properties[name] = prop;
        required.push(name);
    }
    return { type: 'object', properties, required };
}

function requireConnected(agent) {
    if (!agent.connected) throw new Error('Bot is not connected to the Minecraft server right now. Call wait_for_events and try again later.');
}

// Build the "!command(arg, ...)" string Mindcraft parses, so its own validation (block names, ranges) applies.
async function runCommand(agent, command, args) {
    requireConnected(agent);
    const parts = Object.entries(command.params || {}).map(([name, p]) => {
        const v = args[name];
        if (v === undefined || v === null) throw new Error(`Missing parameter ${name}`);
        if (TYPE_MAP[p.type] === 'string') {
            const s = String(v);
            if (s.includes('"')) throw new Error(`Parameter ${name} must not contain double quotes`);
            return `"${s}"`;
        }
        if (p.type === 'boolean') return v === true || v === 'true' ? 'true' : 'false';
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`Parameter ${name} must be a number`);
        return String(n);
    });
    if (command.name === '!setMode' && args.mode_name === 'cheat') throw new Error('cheat mode is not available on this server.');
    const message = parts.length ? `${command.name}(${parts.join(', ')})` : command.name;

    const promise = executeCommand(agent, message);
    if (!actionsList.includes(command)) {
        const res = await promise;
        if (command.name === '!setMode') agent.persist();
        return res;
    }
    return awaitAction(agent, command.name.substring(1), promise);
}

async function awaitAction(agent, label, promise) {
    let finished = false;
    let result;
    const done = promise.then(r => { finished = true; result = r; }, err => { finished = true; result = `Error: ${err.message || err}`; });
    const urgent = agent.events.waitFor('urgent', ACTION_WAIT_MS);
    await Promise.race([done, urgent]);
    if (finished) {
        agent.persist();
        return result === undefined ? `${label}: interrupted.` : `${label} finished. ${result || ''}`.trim();
    }
    done.then(() => {
        agent.persist();
        agent.events.push({ type: 'action_done', text: `${label}: ${result === undefined ? 'interrupted' : (result || 'finished').replace(/\s+/g, ' ').trim()}` });
    });
    const pending = agent.events.items.length;
    return `${label} is still running in the background. Its result arrives as an 'action_done' event via wait_for_events.` +
        (pending ? ` ${pending} new event(s) are waiting.` : '') +
        ' Starting another action interrupts this one.';
}

function query(agent, name) {
    const q = queryList.find(c => c.name === name);
    try { return q.perform(agent); } catch (err) { return `${name} failed: ${err.message}`; }
}

function shortStatus(agent) {
    if (!agent.connected) return 'Bot: not connected.';
    const b = agent.bot;
    const p = b.entity.position;
    const action = agent.actions.currentActionLabel || 'idle';
    return `Bot: pos ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} in ${b.game.dimension} (${b.game.gameMode}) | health ${Math.round(b.health)}/20 | food ${Math.round(b.food)}/20 | ${action}`;
}

function customTools() {
    return [
        {
            name: 'wait_for_events',
            description: 'Wait for things that happen in the game: chat and whispers from players, finished or interrupted actions (action_done), automatic behaviors, damage/low health, death, players joining, disconnects. Returns immediately if events are already queued, otherwise waits up to timeout_seconds. Call this in a loop whenever you are not doing anything else.',
            inputSchema: {
                type: 'object',
                properties: { timeout_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_S, description: 'How long to wait for the first event (default 60).' } },
            },
            run: async (agent, { timeout_seconds = 60 }) => {
                const wait = Math.min(Math.max(Number(timeout_seconds) || 0, 0), MAX_WAIT_S) * 1000;
                const { items, dropped } = await agent.events.take(wait);
                const lines = items.map(formatEvent);
                if (dropped) lines.unshift(`(${dropped} older events were dropped)`);
                if (!lines.length) lines.push('No new events.');
                lines.push(shortStatus(agent));
                return lines.join('\n');
            },
        },
        {
            name: 'status',
            description: 'Full overview: position, health, hunger, time, inventory, nearby blocks and entities, players online, current action, active modes, saved places and your notes.',
            inputSchema: { type: 'object', properties: {} },
            run: async (agent) => {
                const out = [];
                if (agent.connected) {
                    out.push(query(agent, '!stats'), query(agent, '!inventory'), query(agent, '!nearbyBlocks'), query(agent, '!entities'));
                    out.push(`Players online: ${Object.keys(agent.bot.players).filter(n => n !== agent.name).join(', ') || 'none'}`);
                    out.push(`Current action: ${agent.actions.currentActionLabel || 'none'}`);
                } else {
                    out.push('Bot is not connected.');
                }
                out.push(`Saved places: ${agent.memory_bank.getKeys() || 'none'}`);
                const notes = Object.entries(agent.state.notes || {});
                out.push('Notes:' + (notes.length ? notes.map(([k, v]) => `\n- ${k}: ${v}`).join('') : ' none'));
                return out.join('\n');
            },
        },
        {
            name: 'chat',
            description: 'Say something in the public chat. Keep it short (one or two sentences). Commands starting with / are not allowed.',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
            run: async (agent, { message }) => {
                requireConnected(agent);
                const msg = String(message || '').trim();
                if (!msg) throw new Error('Empty message');
                if (msg.startsWith('/')) throw new Error('Server commands are not allowed.');
                const parts = splitChat(msg).slice(0, 3);
                for (const p of parts) agent.bot.chat(p);
                return `Sent (${parts.length} line(s)).`;
            },
        },
        {
            name: 'whisper',
            description: 'Send a private message to one player.',
            inputSchema: { type: 'object', properties: { player: { type: 'string' }, message: { type: 'string' } }, required: ['player', 'message'] },
            run: async (agent, { player, message }) => {
                requireConnected(agent);
                if (!/^[A-Za-z0-9_]{1,16}$/.test(String(player))) throw new Error('Invalid player name');
                const parts = splitChat(String(message || ''), 200).slice(0, 3);
                for (const p of parts) agent.bot.whisper(player, p);
                return `Whispered to ${player}.`;
            },
        },
        {
            name: 'place_blocks',
            description: 'Build something: place a list of blocks at absolute coordinates, bottom layer first. Blocks must be in the inventory. Each block needs an adjacent block to build off. Blocks other players built are never removed. Use for small builds (huts, walls, pillars, bridges).',
            inputSchema: {
                type: 'object',
                properties: {
                    blocks: {
                        type: 'array', minItems: 1, maxItems: 300,
                        items: {
                            type: 'object',
                            properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, block: { type: 'string', description: 'block name, e.g. oak_planks' } },
                            required: ['x', 'y', 'z', 'block'],
                        },
                    },
                },
                required: ['blocks'],
            },
            run: async (agent, { blocks }) => {
                requireConnected(agent);
                if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks must be a non-empty list');
                if (blocks.some(b => b.block === 'air')) throw new Error('Use break_block to remove blocks.');
                const list = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
                const promise = agent.actions.runAction('action:place_blocks', async () => {
                    const bot = agent.bot;
                    let placed = 0;
                    let todo = list;
                    // blocks without support may become placeable once their neighbours exist: retry in passes
                    for (let pass = 0; pass < 3 && todo.length && !bot.interrupt_code; pass++) {
                        const failed = [];
                        for (const b of todo) {
                            if (bot.interrupt_code) break;
                            const ok = await skills.placeBlock(bot, b.block, b.x, b.y, b.z, 'bottom', true).catch(err => { skills.log(bot, `${b.block} at ${b.x},${b.y},${b.z}: ${err.message}`); return false; });
                            if (ok) placed++; else failed.push(b);
                        }
                        if (failed.length === todo.length) { todo = failed; break; }
                        todo = failed;
                    }
                    skills.log(bot, `Placed ${placed} of ${list.length} blocks.` + (todo.length ? ` Not placed: ${todo.slice(0, 20).map(b => `${b.x},${b.y},${b.z}`).join(' ')}${todo.length > 20 ? ' ...' : ''}` : ''));
                }, { timeout: 30 }).then(r => (r.interrupted && !r.timedout ? undefined : r.message));
                return awaitAction(agent, 'place_blocks', promise);
            },
        },
        {
            name: 'break_block',
            description: 'Go to and break the block at x, y, z (uses the held/best tool). Refused for blocks other players built.',
            inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }, required: ['x', 'y', 'z'] },
            run: async (agent, { x, y, z }) => {
                requireConnected(agent);
                const block = agent.bot.blockAt(new Vec3(x, y, z));
                if (block && agent.guard.protects(block)) return `Refused: ${block.name} at ${x}, ${y}, ${z} is protected (${agent.guard.lastReason}).`;
                const promise = agent.actions.runAction('action:break_block', async () => {
                    await skills.breakBlockAt(agent.bot, x, y, z);
                }, { timeout: 5 }).then(r => (r.interrupted && !r.timedout ? undefined : r.message));
                return awaitAction(agent, 'break_block', promise);
            },
        },
        {
            name: 'note',
            description: 'Long-term memory that survives restarts of you and the bot: save (text set), overwrite or delete (text empty) a note under a short key, e.g. key "home", text "hut at 120 64 -40". All notes are shown by status.',
            inputSchema: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key'] },
            run: async (agent, { key, text: t }) => {
                const k = String(key).trim().substring(0, 60);
                if (!k) throw new Error('key is empty');
                agent.state.notes = agent.state.notes || {};
                if (t && String(t).trim()) agent.state.notes[k] = String(t).trim().substring(0, 1000);
                else delete agent.state.notes[k];
                if (Object.keys(agent.state.notes).length > 100) throw new Error('Too many notes, delete some first.');
                agent.persist();
                return `Notes: ${Object.keys(agent.state.notes).join(', ') || 'none'}`;
            },
        },
        {
            name: 'nearby_players',
            description: 'Players near the bot with distance and position.',
            inputSchema: { type: 'object', properties: {} },
            run: async (agent) => {
                requireConnected(agent);
                const me = agent.bot.entity.position;
                const rows = world.getNearbyPlayers(agent.bot, 64).map(e => `${e.username}: ${me.distanceTo(e.position).toFixed(0)} blocks away at ${e.position.x.toFixed(0)}, ${e.position.y.toFixed(0)}, ${e.position.z.toFixed(0)}`);
                return rows.join('\n') || 'No players within 64 blocks.';
            },
        },
    ];
}
