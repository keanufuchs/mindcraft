// Build protection for a bot that plays on a shared survival server.
// Off by default (GUARD=on enables it); players are never attacked either way.
//
// The bot must not destroy what other players built, must not loot their chests and
// must not attack players, named mobs or animals in their farms. These rules live in
// code (not only in the prompt) because chat messages can try to talk the model out of them.
//
// "Player build" heuristic: a block is protected if it is a crafted/placed-looking block
// (planks, glass, doors, ...) that the bot did not place itself, or if at least `minCount`
// such blocks are within `radius` blocks of it (e.g. the log walls of a cabin).

import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as mc from '../utils/mcdata.js';

const ARTIFICIAL = new RegExp([
    'planks', 'glass', 'wool', 'bricks?$', 'brick_', '_stairs$', '_slab$', '_door$', 'fence', '_wall$', 'trapdoor',
    '_bed$', 'chest', 'barrel', 'furnace', 'smoker', 'crafting_table', 'torch', 'lantern', 'carpet',
    'terracotta', 'concrete', 'bookshelf', '_sign$', 'rail$', '^smooth_', '^polished_', '^chiseled_', '^cut_',
    '_banner$', 'anvil', 'hopper', 'composter', 'lectern', 'enchanting_table', 'brewing_stand', 'cauldron',
    'ladder', 'scaffolding', 'iron_bars', 'campfire', 'flower_pot', 'shulker_box', '^stripped_', '_pane$',
    'beacon', 'jukebox', 'note_block', 'loom', 'cartography_table', 'fletching_table', 'smithing_table',
    'grindstone', 'stonecutter', '^bell$', 'candle', 'glowstone', 'sea_lantern', 'lever', '_button$',
    'pressure_plate', 'repeater', 'comparator', 'observer', 'piston', 'dispenser', 'dropper', '^target$',
    'daylight_detector', 'tripwire_hook', 'end_rod', 'copper_bulb', 'decorated_pot', 'redstone_lamp',
].join('|'));

const CELL = 8;           // spatial hash cell size
const SCAN_RADIUS = 64;   // how far around the bot artificial blocks are indexed
const SCAN_MAX_AGE = 10000;

let current = null; // guard of the currently connected bot (pathfinder patch is global)

// Pathfinder and collectBlock ask Movements.safeToBreak() before digging anything.
const origSafeToBreak = pf.Movements.prototype.safeToBreak;
pf.Movements.prototype.safeToBreak = function (block) {
    if (current && block && current.protects(block)) return false;
    return origSafeToBreak.call(this, block);
};

export class Guard {
    constructor(state, { enabled = false, radius = 5, minCount = 4 } = {}) {
        this.enabled = enabled;
        this.state = state;          // persistent state: state.placed = ["x,y,z", ...]
        this.placed = new Set(state.placed || []);
        this.radius = radius;
        this.minCount = minCount;
        this.index = new Map();
        this.scanCenter = null;
        this.scanTime = 0;
        this.ids = null;
        this.lastReason = '';
    }

    install(bot) {
        this.bot = bot;
        bot.guard = this;
        current = this;
        this.index.clear();
        this.scanTime = 0;

        // Blocks that need a minimum pickaxe tier (iron/gold/diamond ore, obsidian ...) carry the
        // material "incorrect_for_<tier>_tool", for which mineflayer knows no tool speed, so even the
        // right pickaxe digs at hand speed (iron ore: 4.5 s instead of 0.75 s). Mindcraft's patch only
        // fixes the wooden tier; treat all of them as pickaxe blocks (harvest rules stay unchanged).
        const pickaxeMaterial = (block) => {
            if (block && /^incorrect_for_\w+_tool$/.test(block.material || '')) block.material = 'mineable/pickaxe';
            return block;
        };
        const origDigTime = bot.digTime.bind(bot);
        bot.digTime = (block, ...args) => origDigTime(pickaxeMaterial(block), ...args);
        const origDig = bot.dig.bind(bot);
        bot.dig = async (block, ...args) => {
            if (this.protects(block)) {
                throw new Error(`Protected block ${block.name} at ${fmt(block.position)}: ${this.lastReason}`);
            }
            // mineflayer computes the dig time once at the start; starting while falling (e.g. right
            // after breaking the block below) uses the 5x airborne penalty for the whole dig
            pickaxeMaterial(block);
            if (!bot.entity.onGround && !bot.entity.isInWater) await waitForGround(bot, 1500);
            if (process.env.DEBUG_MOVES) console.log(`[dig] ${block.name} (${block.material}) expected ${bot.digTime(block)}ms onGround=${bot.entity.onGround} held=${bot.heldItem?.name}`);
            const res = await origDig(block, ...args);
            this.forget(block.position);
            return res;
        };

        const origPlace = bot.placeBlock.bind(bot);
        bot.placeBlock = async (referenceBlock, faceVector, ...args) => {
            const res = await origPlace(referenceBlock, faceVector, ...args);
            this.remember(referenceBlock.position.plus(faceVector));
            return res;
        };

        const origOpen = bot.openContainer.bind(bot);
        bot.openContainer = async (target, ...args) => {
            if (target && target.position && target.name && !this.mayOpen(target)) {
                throw new Error(`Container at ${fmt(target.position)} belongs to someone else: ${this.lastReason}`);
            }
            return origOpen(target, ...args);
        };

        const origAttack = bot.attack.bind(bot);
        bot.attack = (entity, ...args) => {
            if (!this.mayAttack(entity)) {
                bot.pvp?.stop();
                return;
            }
            return origAttack(entity, ...args);
        };
    }

    key(pos) {
        return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    }

    remember(pos) {
        this.placed.add(this.key(pos));
        if (this.placed.size > 20000) this.placed.delete(this.placed.values().next().value);
        this.state.placed = [...this.placed];
        this.state.dirty = true;
    }

    forget(pos) {
        if (this.placed.delete(this.key(pos))) {
            this.state.placed = [...this.placed];
            this.state.dirty = true;
        }
    }

    isOwn(pos) {
        return this.placed.has(this.key(pos));
    }

    artificialIds() {
        if (!this.ids) {
            const blocks = this.bot.registry?.blocksArray || [];
            this.ids = blocks.filter(b => ARTIFICIAL.test(b.name)).map(b => b.id);
        }
        return this.ids;
    }

    refresh(force = false) {
        const center = this.bot.entity?.position;
        if (!center) return;
        const fresh = this.scanCenter && Date.now() - this.scanTime < SCAN_MAX_AGE && this.scanCenter.distanceTo(center) < 16;
        if (fresh && !force) return;
        const found = this.bot.findBlocks({ matching: this.artificialIds(), maxDistance: SCAN_RADIUS, count: 20000, point: center });
        this.index.clear();
        for (const p of found) {
            if (this.isOwn(p)) continue;
            const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)},${Math.floor(p.z / CELL)}`;
            if (!this.index.has(k)) this.index.set(k, []);
            this.index.get(k).push(p);
        }
        this.scanCenter = center.clone();
        this.scanTime = Date.now();
    }

    countNear(pos, radius = this.radius, limit = Infinity) {
        this.refresh();
        let n = 0;
        const c0 = Math.floor((pos.x - radius) / CELL), c1 = Math.floor((pos.x + radius) / CELL);
        const d0 = Math.floor((pos.y - radius) / CELL), d1 = Math.floor((pos.y + radius) / CELL);
        const e0 = Math.floor((pos.z - radius) / CELL), e1 = Math.floor((pos.z + radius) / CELL);
        for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) for (let cz = e0; cz <= e1; cz++) {
            const list = this.index.get(`${cx},${cy},${cz}`);
            if (!list) continue;
            for (const p of list) {
                if (Math.abs(p.x - pos.x) <= radius && Math.abs(p.y - pos.y) <= radius && Math.abs(p.z - pos.z) <= radius) {
                    if (++n >= limit) return n;
                }
            }
        }
        return n;
    }

    // true if the bot must not break this block
    protects(block) {
        if (!this.enabled || !block || !block.position || !this.bot) return false;
        if (this.isOwn(block.position)) return false;
        if (ARTIFICIAL.test(block.name)) {
            this.lastReason = `${block.name} looks player-made`;
            return true;
        }
        if (this.countNear(block.position, this.radius, this.minCount) >= this.minCount) {
            this.lastReason = 'part of or next to a player build';
            return true;
        }
        return false;
    }

    mayOpen(block) {
        if (!this.enabled || this.isOwn(block.position)) return true;
        // a lone chest (dungeon, shipwreck, ...) is fine, chests in builds are not
        const n = this.countNear(block.position, this.radius, this.minCount + 1);
        if (n - 1 >= this.minCount) {
            this.lastReason = 'chest is inside a player build, only own chests may be used there';
            return false;
        }
        return true;
    }

    mayAttack(entity) {
        if (!entity) return false;
        if (entity.type === 'player') {
            this.lastReason = 'players are never attacked';
            return false;
        }
        if (!this.enabled || mc.isHostile(entity)) return true;
        if (hasCustomName(entity)) {
            this.lastReason = `${entity.name} has a name tag (someone's pet)`;
            return false;
        }
        if (this.countNear(entity.position, 6, this.minCount) >= this.minCount) {
            this.lastReason = `${entity.name} is in or near a player build/farm`;
            return false;
        }
        return true;
    }
}

function waitForGround(bot, ms) {
    return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
            if (bot.entity.onGround || Date.now() - start > ms) { bot.off('physicsTick', check); resolve(); }
        };
        bot.on('physicsTick', check);
        check();
    });
}

function hasCustomName(entity) {
    if (entity.customName) return true;
    // metadata index 2 = custom name (optional text component) on current versions
    const m = entity.metadata?.[2];
    return m !== undefined && m !== null && m !== '' && m !== false;
}

function fmt(pos) {
    const p = new Vec3(pos.x, pos.y, pos.z).floored();
    return `${p.x}, ${p.y}, ${p.z}`;
}
