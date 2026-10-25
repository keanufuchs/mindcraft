// Tools for a bot account with operator rights (OP_TOOLS=on).
//
// The bot may not run free-form server commands (the chat tool refuses "/"). Instead these few
// fixed commands are available, so a chat message cannot talk it into /give or /gamemode:
// teleport itself to a player and back, go from the lobby into a world, set time and weather,
// fly to a spot (temporarily creative) and land again, and a few things a player does by hand
// that Mineflayer cannot: write signs, turn a placed block, get out when stuck, colored announcements.
// Rule of thumb: OP replaces what the bot cannot do technically, it never creates items or advantages.

import Vec3 from 'vec3';
import settings from '../agent/settings.js';

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;
const FLY_RANGE = 128;                 // flying is for showing/marking spots, not for travelling
const AUTO_LAND_MS = 15 * 60 * 1000;   // land automatically if nobody does it
const NEAR = 6;                        // write_sign / rotate_block only within reach
const RESCUE_COOLDOWN_MS = 2 * 60 * 1000;
const ANNOUNCE_COOLDOWN_MS = 30 * 1000;
const COLORS = ['white', 'gold', 'yellow', 'green', 'aqua', 'light_purple', 'red', 'gray'];
// blocks whose contents or second half would be lost when replaced with /setblock
const NO_ROTATE = /chest|barrel|furnace|smoker|hopper|dispenser|dropper|shulker_box|brewing_stand|lectern|crafter|_door$|_bed$|sign|banner|campfire|chiseled_bookshelf|decorated_pot|jukebox|spawner|beacon/;
const FLIGHT_MODES_OFF = ['self_preservation', 'unstuck', 'item_collecting', 'elbow_room', 'torch_placing', 'hunting'];

function need(agent) {
    if (!agent.connected) throw new Error('Bot is not connected to the Minecraft server right now.');
}

function run(agent, cmd) {
    console.log(`[op] /${cmd}`);
    agent.bot.chat('/' + cmd);
}

function waitFor(bot, event, check, ms) {
    return new Promise(resolve => {
        const handler = (...args) => {
            if (check && !check(...args)) return;
            clearTimeout(timer);
            bot.off(event, handler);
            resolve(true);
        };
        const timer = setTimeout(() => { bot.off(event, handler); resolve(false); }, ms);
        bot.on(event, handler);
    });
}

function here(agent) {
    const p = agent.bot.entity.position;
    return { dimension: agent.world || agent.bot.game.dimension, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function clean(text, max) {
    // printable text only, no formatting codes
    return String(text ?? '').replace(/[\u0000-\u001f\u007f§]/g, '').trim().substring(0, max);
}

function snbtString(text) {
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function nearBlock(agent, x, y, z) {
    const bot = agent.bot;
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error('Invalid coordinates');
    const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
    if (dist > NEAR) throw new Error(`Block is ${dist.toFixed(0)} blocks away, go within ${NEAR} blocks first.`);
    const block = bot.blockAt(pos);
    if (!block) throw new Error('Block not loaded');
    return block;
}

function fmt(p) {
    return `${p.x}, ${p.y}, ${p.z} (${p.dimension})`;
}

async function setGameMode(agent, mode) {
    const bot = agent.bot;
    if (bot.game.gameMode === mode) return true;
    run(agent, `gamemode ${mode} ${bot.username}`);
    return waitFor(bot, 'game', () => bot.game.gameMode === mode, 5000);
}

async function land(agent) {
    const bot = agent.bot;
    clearTimeout(agent.autoLandTimer);
    if (bot.game.gameMode === 'creative') {
        const p = bot.entity.position;
        let y = Math.floor(p.y);
        while (y > -64 && !(bot.blockAt(new Vec3(p.x, y - 1, p.z))?.boundingBox === 'block')) y--;
        try { await bot.creative.flyTo(new Vec3(p.x, y + 0.2, p.z)); } catch (err) { console.warn('land flyTo:', err.message); }
        bot.creative.stopFlying();
        if (!await setGameMode(agent, 'survival')) return 'Could not switch back to survival.';
    }
    // restore the reflexes that were switched off for the flight
    for (const [mode, on] of Object.entries(agent.state.flightModes || {})) bot.modes.setOn(mode, on);
    delete agent.state.flightModes;
    agent.state.flying = false;
    agent.persist();
    return `Landed at ${fmt(here(agent))}, back in survival.`;
}

// IMMORTAL=on: keep Resistance V (infinite, hidden) on the bot. It blocks all damage from mobs,
// players, drowning, falling, fire, explosions; knockback still applies. /kill and the void ignore
// resistance, so the bot can still die (reset). Effects are lost on death and by milk, so the bot
// re-applies it after every spawn/respawn and checks it every 30 s.
function hasResistance(bot) {
    const id = bot.registry.effectsByName?.resistance?.id ?? bot.registry.effectsByName?.Resistance?.id;
    const e = id !== undefined ? bot.entity.effects?.[id] : undefined;
    return e && e.amplifier >= 4;
}
function ensureImmortal(agent) {
    if (!settings.immortal || !agent.connected || hasResistance(agent.bot)) return;
    run(agent, `effect give ${agent.bot.username} minecraft:resistance infinite 4 true`);
}
export function opStartImmortal(agent) {
    if (!settings.immortal) return;
    clearInterval(agent.immortalTimer);
    agent.immortalTimer = setInterval(() => ensureImmortal(agent), 30000);
}

// called by the agent after every (re)connect and respawn: never stay in creative by accident
export function opOnSpawn(agent) {
    if (settings.immortal) setTimeout(() => ensureImmortal(agent), 1500);
    if (!settings.op_tools) return;
    if (agent.state.flying || agent.bot.game.gameMode === 'creative') {
        agent.events.push({ type: 'system', text: 'Was still flying/creative after reconnect, landing.' });
        land(agent).catch(err => console.error('auto land failed:', err));
    }
}

// awaitAction(agent, label, makePromise): queued like all action tools, see chained() in server.js
export function opTools(awaitAction) {
    const worlds = settings.op_worlds || [];
    return [
        {
            name: 'teleport_to_player',
            description: 'OP: teleport yourself to a player. Only when that player asked you to come to them. Your current spot is saved for teleport_back.',
            inputSchema: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
            run: async (agent, { player }) => {
                need(agent);
                if (!PLAYER.test(String(player))) throw new Error('Invalid player name');
                const bot = agent.bot;
                const before = here(agent);
                const moved = waitFor(bot, 'forcedMove', null, 5000);
                run(agent, `tp ${bot.username} ${player}`);
                if (!await moved) return `Teleport to ${player} did not happen (offline or wrong name?).`;
                agent.state.lastTeleport = before;
                agent.persist();
                return `Teleported to ${player}, now at ${fmt(here(agent))}. Previous spot saved: ${fmt(before)}.`;
            },
        },
        {
            name: 'teleport_back',
            description: 'OP: teleport back to where you were before the last teleport_to_player.',
            inputSchema: { type: 'object', properties: {} },
            run: async (agent) => {
                need(agent);
                const t = agent.state.lastTeleport;
                if (!t) return 'No saved spot to go back to.';
                const bot = agent.bot;
                const moved = waitFor(bot, 'forcedMove', null, 5000);
                run(agent, `execute in ${t.dimension} run tp ${bot.username} ${t.x + 0.5} ${t.y} ${t.z + 0.5}`);
                if (!await moved) return 'Teleport back did not happen.';
                delete agent.state.lastTeleport;
                agent.persist();
                return `Back at ${fmt(here(agent))}.`;
            },
        },
        {
            name: 'go_to_world',
            description: `OP: from the lobby (after dying or joining) go straight into one of your worlds instead of walking through the portal. Allowed: ${worlds.join(', ')}.`,
            inputSchema: { type: 'object', properties: { world: { type: 'string', enum: worlds } }, required: ['world'] },
            run: async (agent, { world }) => {
                need(agent);
                if (!worlds.includes(world)) throw new Error(`Only ${worlds.join(', ')}`);
                const bot = agent.bot;
                if (!/lobby/i.test(String(agent.world))) return `Only allowed from the lobby. You are in ${agent.world || 'an unknown world'}.`;
                const moved = waitFor(bot, 'forcedMove', null, 8000);
                run(agent, `mvtp ${bot.username} ${world}`);
                if (!await moved) return `Teleport to ${world} did not happen.`;
                return `Now at ${fmt(here(agent))}.`;
            },
        },
        {
            name: 'set_time',
            description: 'OP: set the time of day in your current world (affects everyone there). Use when players ask.',
            inputSchema: { type: 'object', properties: { time: { type: 'string', enum: ['day', 'noon', 'night', 'midnight'] } }, required: ['time'] },
            run: async (agent, { time }) => {
                need(agent);
                if (!['day', 'noon', 'night', 'midnight'].includes(time)) throw new Error('Invalid time');
                run(agent, `time set ${time}`);
                return `Time set to ${time}.`;
            },
        },
        {
            name: 'set_weather',
            description: 'OP: set the weather in your current world (affects everyone there). Use when players ask.',
            inputSchema: { type: 'object', properties: { weather: { type: 'string', enum: ['clear', 'rain', 'thunder'] } }, required: ['weather'] },
            run: async (agent, { weather }) => {
                need(agent);
                if (!['clear', 'rain', 'thunder'].includes(weather)) throw new Error('Invalid weather');
                run(agent, `weather ${weather}`);
                return `Weather set to ${weather}.`;
            },
        },
        {
            name: 'fly_to',
            description: `OP: fly to an exact spot and hover there, e.g. when a player asks you to mark a height or look at a build from above. Switches to creative only for the flight, within ${FLY_RANGE} blocks. Call land when done (automatic after 15 minutes). Not for travelling, mining or collecting.`,
            inputSchema: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                required: ['x', 'y', 'z'],
            },
            run: async (agent, { x, y, z }) => {
                need(agent);
                const bot = agent.bot;
                const target = new Vec3(Number(x), Number(y), Number(z));
                if (![target.x, target.y, target.z].every(Number.isFinite)) throw new Error('Invalid coordinates');
                if (bot.entity.position.distanceTo(target) > FLY_RANGE) return `Too far (${bot.entity.position.distanceTo(target).toFixed(0)} blocks). Flying only within ${FLY_RANGE} blocks; walk or teleport to the player first.`;
                return awaitAction(agent, 'fly_to', () => agent.actions.runAction('action:fly_to', async () => {
                    if (!agent.state.flying) {
                        agent.state.flightModes = {};
                        for (const m of FLIGHT_MODES_OFF) {
                            agent.state.flightModes[m] = bot.modes.isOn(m);
                            bot.modes.setOn(m, false);
                        }
                    }
                    if (!await setGameMode(agent, 'creative')) throw new Error('Could not switch to creative.');
                    agent.state.flying = true;
                    agent.persist();
                    bot.creative.startFlying();
                    await bot.creative.flyTo(target);
                    clearTimeout(agent.autoLandTimer);
                    agent.autoLandTimer = setTimeout(() => {
                        land(agent).then(r => agent.events.push({ type: 'system', text: `Auto landing after 15 minutes: ${r}` }));
                    }, AUTO_LAND_MS);
                    bot.output += `Hovering at ${target.x}, ${target.y}, ${target.z}.`;
                }, { timeout: 3 }).then(r => (r.interrupted && !r.timedout ? undefined : r.message)));
            },
        },
        {
            name: 'write_sign',
            description: 'OP: write text on a sign that is already placed (Mineflayer cannot edit sign text). Up to 4 lines, max 20 characters each. Place the sign first (place_blocks / placeHere with a sign item).',
            inputSchema: {
                type: 'object',
                properties: {
                    x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
                    lines: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
                },
                required: ['x', 'y', 'z', 'lines'],
            },
            run: async (agent, { x, y, z, lines }) => {
                need(agent);
                const block = nearBlock(agent, x, y, z);
                if (!/sign/.test(block.name)) return `The block at ${block.position} is ${block.name}, not a sign.`;
                const text = [0, 1, 2, 3].map(i => snbtString(clean(Array.isArray(lines) ? lines[i] : '', 20)));
                const p = block.position;
                run(agent, `data merge block ${p.x} ${p.y} ${p.z} {front_text:{messages:[${text.join(',')}]}}`);
                return `Sign at ${p.x}, ${p.y}, ${p.z} written.`;
            },
        },
        {
            name: 'rotate_block',
            description: `OP: turn a block that is already placed (e.g. stairs, trapdoors, observers) to face another direction, because Mineflayer cannot choose the direction when placing. Same block type, only the facing changes. Not for containers, doors, beds, signs. Within ${NEAR} blocks.`,
            inputSchema: {
                type: 'object',
                properties: {
                    x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
                    facing: { type: 'string', enum: ['north', 'south', 'east', 'west', 'up', 'down'] },
                },
                required: ['x', 'y', 'z', 'facing'],
            },
            run: async (agent, { x, y, z, facing }) => {
                need(agent);
                const block = nearBlock(agent, x, y, z);
                if (NO_ROTATE.test(block.name)) return `${block.name} cannot be turned this way (contents or second half would be lost).`;
                const props = block.getProperties ? block.getProperties() : {};
                if (!('facing' in props)) return `${block.name} has no direction to turn.`;
                if (!['north', 'south', 'east', 'west', 'up', 'down'].includes(facing)) throw new Error('Invalid facing');
                props.facing = facing;
                const states = Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',');
                const p = block.position;
                const updated = waitFor(agent.bot, `blockUpdate:${p}`, null, 3000);
                run(agent, `setblock ${p.x} ${p.y} ${p.z} minecraft:${block.name}[${states}] replace`);
                await updated;
                const now = agent.bot.blockAt(p);
                const nowFacing = now?.getProperties ? now.getProperties().facing : undefined;
                return nowFacing === facing ? `${block.name} at ${p.x}, ${p.y}, ${p.z} now faces ${facing}.` : `Sent, but the block now shows facing=${nowFacing} (the server may name this state differently).`;
            },
        },
        {
            name: 'rescue_teleport',
            description: 'OP: only when you are really stuck (trapped, buried, stuck after a glitch, unstuck/goToSurface failed). mode "surface": straight up to the surface above you (no sideways move); mode "refresh": teleport onto your own position to fix a position glitch. At most every 2 minutes.',
            inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['surface', 'refresh'] } }, required: ['mode'] },
            run: async (agent, { mode }) => {
                need(agent);
                const bot = agent.bot;
                const wait = (agent.lastRescue || 0) + RESCUE_COOLDOWN_MS - Date.now();
                if (wait > 0) return `Rescue teleport was used recently, try again in ${Math.ceil(wait / 1000)} s.`;
                const p = bot.entity.position;
                let target = p.floored();
                if (mode === 'surface') {
                    const at = (y) => bot.blockAt(new Vec3(p.x, y, p.z));
                    const solid = (y) => at(y)?.boundingBox === 'block';
                    // air only: water counts as not free, so we never land on a river bed
                    const free = (y) => { const b = at(y); return b && b.boundingBox === 'empty' && !/water|lava|fire|bubble_column/.test(b.name); };
                    const water = (y) => /water|bubble_column/.test(at(y)?.name || '');
                    const nether = /nether/.test(String(bot.game.dimension));
                    let found = null;
                    if (nether) {
                        // the nether has a bedrock roof: take the first safe pocket above
                        for (let y = target.y + 1; y < 126 && !found; y++) if (solid(y - 1) && free(y) && free(y + 1)) found = y;
                    } else {
                        for (let y = 319; y > target.y && !found; y--) {
                            if (solid(y - 1) && free(y) && free(y + 1)) found = y;
                            // the highest thing is a lake or river: surface of the water (swim out from there)
                            else if (water(y - 1) && free(y) && free(y + 1)) found = y - 1;
                        }
                    }
                    if (!found) return 'No safe surface found straight above you.';
                    target = new Vec3(target.x, found, target.z);
                }
                const moved = waitFor(bot, 'forcedMove', null, 5000);
                run(agent, `tp ${bot.username} ${target.x + 0.5} ${target.y} ${target.z + 0.5}`);
                agent.lastRescue = Date.now();
                if (!await moved) return 'Rescue teleport did not happen.';
                return `Rescued to ${fmt(here(agent))}.`;
            },
        },
        {
            name: 'announce',
            description: 'OP: a colored, highlighted message to everyone (e.g. an invitation, a finished build, a short help text). Normal talk stays in chat. At most every 30 seconds, max 150 characters.',
            inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' }, color: { type: 'string', enum: COLORS } },
                required: ['text'],
            },
            run: async (agent, { text, color = 'white' }) => {
                need(agent);
                const wait = (agent.lastAnnounce || 0) + ANNOUNCE_COOLDOWN_MS - Date.now();
                if (wait > 0) return `Wait ${Math.ceil(wait / 1000)} s before the next announcement.`;
                const t = clean(text, 150);
                if (!t) throw new Error('Empty text');
                const c = COLORS.includes(color) ? color : 'white';
                const json = JSON.stringify(['', { text: '✦ CLAUDE: ', color: '#D97757', bold: true }, { text: t, color: c }]);
                const cmd = `tellraw @a ${json}`;
                if (cmd.length > 256) throw new Error('Text too long after escaping, shorten it.');
                run(agent, cmd);
                agent.lastAnnounce = Date.now();
                return 'Announced.';
            },
        },
        {
            name: 'reset_by_kill',
            description: 'OP: kill yourself with /kill as a last-resort reset (e.g. hopelessly stuck and rescue_teleport did not help). You respawn at the world spawn or your bed; your items drop where you were (go back with goToRememberedPlace last_death_position). Normal damage cannot kill you, this can.',
            inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'why a reset is needed' } }, required: ['reason'] },
            run: async (agent, { reason }) => {
                need(agent);
                console.log(`[op] reset_by_kill: ${String(reason).substring(0, 200)}`);
                run(agent, `kill ${agent.bot.username}`);
                return 'Killed yourself for a reset. Wait for the death/respawn events, then continue.';
            },
        },
        {
            name: 'land',
            description: 'OP: end a flight: fly straight down to the ground and switch back to survival.',
            inputSchema: { type: 'object', properties: {} },
            run: async (agent) => {
                need(agent);
                return land(agent);
            },
        },
    ];
}
