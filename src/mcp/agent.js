// Mindcraft agent without its own LLM loop.
//
// Keeps everything that makes Mindcraft useful (skills, commands, reflex modes, memory of places)
// but replaces Prompter/History/SelfPrompter: instead of prompting a model, every chat message and
// game event is put into an EventQueue that an external controller (Claude Code via MCP) reads.

import { initBot } from '../utils/mcdata.js';
import { initModes } from '../agent/modes.js';
import { ActionManager } from '../agent/action_manager.js';
import { MemoryBank } from '../agent/memory_bank.js';
import settings from '../agent/settings.js';
import { EventQueue } from './events.js';
import { Guard } from './guard.js';
import { opOnSpawn } from './optools.js';

const UPDATE_INTERVAL = 300;
// reflexes the controller may not switch off (stay pauses them on its own)
export const PROTECTED_MODES = ['unstuck', 'self_preservation', 'self_defense'];
// actions that legitimately stand still
const NO_WATCH = ['action:stay', 'action:followPlayer', 'action:fly_to', 'mode:'];
const STALL_WARN_S = 60;
const STALL_STOP_S = 150;
const IGNORE_SYSTEM = ['Set own game mode to', 'Set the time to', 'Set the difficulty to', 'Teleported ', 'Set the weather to', 'Gamerule '];

export class McpAgent {
    constructor(state, saveState) {
        this.state = state;
        this.saveState = saveState;
        this.name = settings.bot_name;
        this.events = new EventQueue();
        this.actions = new ActionManager(this);
        // remember when the current action started and when it last made progress (stall watchdog)
        const execute = this.actions._executeAction.bind(this.actions);
        this.actions._executeAction = (...args) => {
            this.actionRun = { started: Date.now(), lastProgress: Date.now(), sig: null };
            return execute(...args);
        };
        this.memory_bank = new MemoryBank();
        this.memory_bank.loadJson(state.places || {});
        this.guard = new Guard(state, settings.guard || {});
        this.blocked_actions = settings.blocked_actions || [];
        this.task = {};
        this.shut_up = false;
        this.last_sender = null;
        this.connected = false;
        this.generation = 0;
        this.msaPending = false;

        // stubs for the parts of Mindcraft's Agent that only exist for its own LLM loop
        this.history = { add: () => {}, save: () => {}, clear: () => {}, getHistory: () => [] };
        this.self_prompter = {
            isActive: () => false, isPaused: () => false, isStopped: () => true,
            stop: () => {}, stopLoop: () => {}, start: () => {}, setPromptPaused: () => {},
            shouldInterrupt: () => false, handleUserPromptedCmd: () => {}, update: () => {},
        };
        const modes = { ...settings.modes, ...(state.modes || {}) };
        for (const m of PROTECTED_MODES) modes[m] = true;
        this.prompter = { profile: { name: this.name, modes }, getName: () => this.name, getInitModes: () => modes };
    }

    connect() {
        const gen = ++this.generation;
        this.connected = false;
        console.log(`Connecting ${this.name} to ${settings.host}:${settings.port} (version ${settings.minecraft_version}, auth ${settings.auth})`);

        settings.bot_options = {
            ...(settings.bot_options || {}),
            onMsaCode: (data) => {
                this.msaPending = true;
                const msg = `Microsoft login required: open ${data.verification_uri} and enter code ${data.user_code}`;
                console.log('*'.repeat(70) + '\n' + msg + '\n' + '*'.repeat(70));
                this.events.push({ type: 'system', text: msg });
            },
        };
        const bot = this.bot = initBot(this.name);
        initModes(this);
        // bot.game.dimension is only the dimension type (overworld); Multiverse worlds have their own key, e.g. minecraft:lobby
        const onWorld = (packet) => {
            const name = packet?.worldState?.name || packet?.worldName;
            if (name) this.world = String(name);
        };
        bot._client.on('login', onWorld);
        bot._client.on('respawn', onWorld);

        const spawnTimeout = setInterval(() => {
            if (this.msaPending) return; // waiting for a human to log in
            if (!this.connected) this.reconnect('spawn timeout');
        }, (settings.spawn_timeout || 60) * 1000);

        bot.once('login', () => {
            // mineflayer's own plugins (dig, placeBlock, ...) are loaded after createBot, so wrap them here
            this.guard.install(bot);
            this.msaPending = false;
            this.name = bot.username;
            this.prompter.profile.name = bot.username;
            console.log(`${this.name} logged in (protocol version ${bot.version}).`);
        });

        bot.once('spawn', async () => {
            clearInterval(spawnTimeout);
            await sleep(1000);
            if (gen !== this.generation) return;
            this.connected = true;
            this.spawnedAt = Date.now();
            this.clearBotLogs();
            bot.autoEat.options = {
                priority: 'foodPoints',
                startAt: 14,
                bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'],
            };
            const p = bot.entity.position;
            this.events.push({ type: 'system', text: `Connected as ${this.name}. Position ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} in world ${this.world || bot.game.dimension}, gamemode ${bot.game.gameMode}.` });
            this.setupEvents(bot, gen);
            this.updateLoop(gen);
            opOnSpawn(this);
            bot.emit('idle');
        });

        bot.on('kicked', (reason) => this.reconnect(`kicked: ${textOf(reason)}`, /whitelist|banned/i.test(textOf(reason)) ? 300 : 30));
        bot.on('end', (reason) => this.reconnect(`connection ended: ${reason}`));
        bot.on('error', (err) => console.error('Bot error:', err?.message || err));
    }

    // own name plus display aliases (e.g. a nickname plugin shows the bot under another name)
    isSelf(username) {
        const n = String(username || '').toLowerCase();
        return n === String(this.name).toLowerCase() || (settings.bot_aliases || []).some(a => a.toLowerCase() === n);
    }

    setupEvents(bot, gen) {
        const alive = () => gen === this.generation;

        bot.on('chat', (username, message) => {
            if (!alive() || this.isSelf(username) || !message) return;
            if (IGNORE_SYSTEM.some(m => message.startsWith(m))) return;
            this.last_sender = username;
            this.events.push({ type: 'chat', from: username, text: message });
        });
        bot.on('whisper', (username, message) => {
            if (!alive() || this.isSelf(username) || !message) return;
            this.last_sender = username;
            this.events.push({ type: 'whisper', from: username, text: message });
        });
        bot.on('playerJoined', (player) => {
            if (!alive() || Date.now() - this.spawnedAt < 5000 || this.isSelf(player.username)) return;
            this.events.push({ type: 'player', text: `${player.username} joined the server` });
        });
        bot.on('playerLeft', (player) => {
            if (!alive() || this.isSelf(player.username)) return;
            this.events.push({ type: 'player', text: `${player.username} left the server` });
        });

        let prevHealth = bot.health;
        let lastDanger = 0;
        bot.lastDamageTime = 0;
        bot.lastDamageTaken = 0;
        bot.on('health', () => {
            if (!alive()) return;
            if (bot.health < prevHealth) {
                bot.lastDamageTime = Date.now();
                bot.lastDamageTaken = prevHealth - bot.health;
                if (bot.health <= 6 && Date.now() - lastDanger > 20000) {
                    lastDanger = Date.now();
                    this.events.push({ type: 'danger', text: `Low health: ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20` });
                }
            }
            prevHealth = bot.health;
        });

        bot.on('death', () => {
            if (!alive()) return;
            this.actions.cancelResume();
            this.actions.stop();
        });
        bot.on('messagestr', (message, _, jsonMsg) => {
            if (!alive()) return;
            if (jsonMsg?.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                const p = bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', p.x, p.y, p.z);
                this.persist();
                this.events.push({ type: 'death', text: `${message} at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} in world ${this.world || bot.game.dimension}. Items are dropped there, saved as place 'last_death_position'. Current action was stopped, you respawned.` });
            }
        });

        // pathfinder diagnostics in the container log (why the bot does not move)
        bot.on('path_update', (r) => {
            if (!alive()) return;
            console.log(`[path] ${r.status} len=${r.path?.length ?? 0} nodes=${r.visitedNodes ?? '?'} ${Math.round(r.time ?? 0)}ms`);
        });
        bot.on('path_reset', (reason) => alive() && console.log(`[path] reset: ${reason}`));
        bot.on('path_stop', () => alive() && console.log('[path] stop'));
        bot.on('goal_reached', () => alive() && console.log('[path] goal reached'));
        bot.on('forcedMove', () => alive() && console.log(`[move] server set position ${process.env.DEBUG_MOVES ? bot.entity.position.toString() : bot.entity.position.floored()}`));

        bot.on('idle', () => {
            if (!alive()) return;
            bot.clearControlStates();
            bot.pathfinder.stop();
            bot.modes.unPauseAll();
            setTimeout(() => {
                if (alive() && this.isIdle()) this.actions.resumeAction();
            }, 1000);
        });
    }

    async updateLoop(gen) {
        while (gen === this.generation) {
            const start = Date.now();
            try {
                await this.bot.modes.update();
                this.checkStalled();
                const log = this.bot.modes.flushBehaviorLog().trim();
                if (log) this.events.push({ type: 'behavior', text: log.replaceAll('\n', ' | ') });
            } catch (err) {
                console.error('mode update failed:', err);
            }
            await sleep(Math.max(0, UPDATE_INTERVAL - (Date.now() - start)));
        }
    }

    // An action that neither moves the bot nor changes its inventory is probably stuck
    // (e.g. waiting for an item that floated away). Warn the controller, then stop it.
    checkStalled() {
        const run = this.actionRun;
        const label = this.actions.currentActionLabel || '';
        if (!this.actions.executing || !run || NO_WATCH.some(l => label.startsWith(l))) return;
        const b = this.bot;
        const p = b.entity.position;
        const items = b.inventory.items().reduce((n, i) => n + i.count, 0);
        const sig = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}|${items}|${b.targetDigBlock ? b.targetDigBlock.position : ''}`;
        const now = Date.now();
        if (sig !== run.sig) {
            run.sig = sig;
            run.lastProgress = now;
            return;
        }
        const idle = Math.round((now - run.lastProgress) / 1000);
        const name = label.replace('action:', '');
        if (idle >= STALL_WARN_S && !run.warned) {
            run.warned = true;
            this.events.push({ type: 'danger', text: `${name} has made no progress for ${idle}s (not moving, inventory unchanged). Probably stuck: call stop and try something else. It is stopped automatically after ${STALL_STOP_S}s.` });
        }
        if (idle >= STALL_STOP_S && !run.stopped) {
            run.stopped = true;
            this.events.push({ type: 'system', text: `${name} stopped automatically after ${idle}s without progress.` });
            this.actions.cancelResume();
            this.actions.stop();
        }
    }

    // Disconnects are handled by exiting: the container restarts the process.
    // In-process reconnects would leave half-finished actions bound to the old bot object.
    reconnect(reason, delaySeconds = 30) {
        if (this.exiting) return;
        this.exiting = true;
        this.connected = false;
        this.generation++;
        console.warn(`Disconnected (${reason}). Restarting in ${delaySeconds}s.`);
        this.events.push({ type: 'disconnected', text: `${reason}. Bot reconnects in about ${delaySeconds}s.` });
        this.persist();
        setTimeout(() => process.exit(1), delaySeconds * 1000);
    }

    persist() {
        this.state.places = this.memory_bank.getJson();
        if (this.bot?.modes) this.state.modes = this.bot.modes.getJson();
        this.saveState();
    }

    // --- interface used by Mindcraft's commands, modes and ActionManager ---

    async handleMessage(source, message) {
        // modes report interruptions with handleMessage('system', ...)
        this.events.push({ type: source === 'system' ? 'system' : 'chat', from: source, text: message });
        return false;
    }

    async routeResponse(_toPlayer, message) {
        return this.openChat(message);
    }

    async openChat(message) {
        if (!this.connected) return;
        for (const part of splitChat(message)) this.bot.chat(part);
    }

    isIdle() {
        return !this.actions.executing;
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {}

    cleanKill(msg = 'Killing agent process...') {
        // the unstuck mode gives up after 10 s; a reconnect would only make the bot leave and rejoin
        // Mindcraft restarts after every smelt to refresh the inventory; here the bot stays online.
        if (/Safely restarting to update inventory/.test(msg)) {
            this.events.push({ type: 'system', text: 'Smelting finished. Check the result with inventory.' });
            return;
        }
        // An action that ignores interrupts for 10 s: drop it instead of restarting the whole process.
        if (/refused stop/.test(msg)) {
            this.requestInterrupt();
            this.actions.abandon();
            this.bot.emit('idle');
            this.events.push({ type: 'system', text: 'The previous action hung and was abandoned. You can start the next one.' });
            return;
        }
        // Its retries every 20 s would interrupt every escape attempt, so pause it for 2 minutes.
        if (/couldn't get unstuck/.test(msg)) {
            this.requestInterrupt();
            this.bot.modes.setOn('unstuck', false);
            clearTimeout(this.unstuckTimer);
            this.unstuckTimer = setTimeout(() => this.bot?.modes?.setOn('unstuck', true), 120000);
            this.events.push({ type: 'danger', text: 'Stuck and could not free itself. The unstuck reflex is paused for 2 minutes so you can get out yourself: goToSurface, digDown, moveAway' + (settings.op_tools ? ', or rescue_teleport (mode surface)' : '') + '.' });
            return;
        }
        console.error(msg);
        this.reconnect(msg, 5);
    }
}

export function splitChat(message, max = 240) {
    const text = String(message).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        parts.push(rest.substring(0, cut));
        rest = rest.substring(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
}

function textOf(reason) {
    if (typeof reason === 'string') {
        try { return textOf(JSON.parse(reason)); } catch { return reason; }
    }
    if (reason && typeof reason === 'object') {
        if (reason.value !== undefined) return textOf(reason.value);
        const parts = [reason.text, reason.translate, ...[].concat(reason.extra || []).map(textOf), ...[].concat(reason.with || []).map(textOf)].filter(Boolean);
        return parts.length ? parts.join(' ') : JSON.stringify(reason);
    }
    return String(reason);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
