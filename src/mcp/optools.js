// Tools for a bot account with operator rights (OP_TOOLS=on).
//
// The bot may not run free-form server commands (the chat tool refuses "/"). Instead these few
// fixed commands are available, so a chat message cannot talk it into /give or /gamemode:
// teleport itself to a player and back, go from the lobby into a world, set time and weather,
// fly to a spot (temporarily creative) and land again.

import Vec3 from 'vec3';
import settings from '../agent/settings.js';

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;
const FLY_RANGE = 128;                 // flying is for showing/marking spots, not for travelling
const AUTO_LAND_MS = 15 * 60 * 1000;   // land automatically if nobody does it
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

function here(bot) {
    const p = bot.entity.position;
    return { dimension: bot.game.dimension, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
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
    return `Landed at ${fmt(here(bot))}, back in survival.`;
}

// called by the agent after every (re)connect: never stay in creative by accident
export function opOnSpawn(agent) {
    if (!settings.op_tools) return;
    if (agent.state.flying || agent.bot.game.gameMode === 'creative') {
        agent.events.push({ type: 'system', text: 'Was still flying/creative after reconnect, landing.' });
        land(agent).catch(err => console.error('auto land failed:', err));
    }
}

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
                const before = here(bot);
                const moved = waitFor(bot, 'forcedMove', null, 5000);
                run(agent, `tp ${bot.username} ${player}`);
                if (!await moved) return `Teleport to ${player} did not happen (offline or wrong name?).`;
                agent.state.lastTeleport = before;
                agent.persist();
                return `Teleported to ${player}, now at ${fmt(here(bot))}. Previous spot saved: ${fmt(before)}.`;
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
                return `Back at ${fmt(here(bot))}.`;
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
                if (!/lobby/i.test(String(bot.game.dimension))) return `Only allowed from the lobby. You are in ${bot.game.dimension}.`;
                const moved = waitFor(bot, 'forcedMove', null, 8000);
                run(agent, `mvtp ${bot.username} ${world}`);
                if (!await moved) return `Teleport to ${world} did not happen.`;
                return `Now in ${bot.game.dimension} at ${fmt(here(bot))}.`;
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
                const promise = agent.actions.runAction('action:fly_to', async () => {
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
                }, { timeout: 3 }).then(r => (r.interrupted && !r.timedout ? undefined : r.message));
                return awaitAction(agent, 'fly_to', promise);
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
