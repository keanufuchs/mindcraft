// Event queue between the bot and the external controller (MCP client).
// Everything that happens in game (chat, death, finished actions, ...) lands here
// and is picked up with the MCP tool `wait_for_events`.

import { EventEmitter } from 'events';

// Event types that should wake up a waiting controller early (e.g. while an action is running).
const URGENT = new Set(['chat', 'whisper', 'death', 'danger', 'disconnected']);

export class EventQueue extends EventEmitter {
    constructor(max = 200) {
        super();
        this.max = max;
        this.items = [];
        this.dropped = 0;
        this.setMaxListeners(100);
    }

    push(event) {
        event.time = new Date().toISOString();
        const last = this.items[this.items.length - 1];
        // collapse identical repeating events (e.g. a mode retrying the same thing)
        if (last && last.type === event.type && last.text === event.text && last.from === event.from) {
            last.repeat = (last.repeat || 1) + 1;
            last.time = event.time;
        } else {
            this.items.push(event);
        }
        if (this.items.length > this.max) {
            this.items.shift();
            this.dropped++;
        }
        console.log('[event]', formatEvent(event));
        this.emit('event', event);
        if (URGENT.has(event.type)) this.emit('urgent', event);
    }

    drain() {
        const items = this.items;
        const dropped = this.dropped;
        this.items = [];
        this.dropped = 0;
        return { items, dropped };
    }

    // Wait until at least one event is queued (or timeout), then return all queued events.
    async take(timeoutMs) {
        if (this.items.length === 0 && timeoutMs > 0) {
            await this.waitFor('event', timeoutMs);
        }
        return this.drain();
    }

    // Resolves true on the next urgent event, false on timeout. Does not consume events.
    waitFor(name, timeoutMs) {
        return new Promise(resolve => {
            const onEvent = () => { clearTimeout(timer); resolve(true); };
            const timer = setTimeout(() => { this.off(name, onEvent); resolve(false); }, timeoutMs);
            this.once(name, onEvent);
        });
    }
}

export function formatEvent(e) {
    const t = e.time ? e.time.substring(11, 19) : '';
    const rep = e.repeat ? ` (x${e.repeat})` : '';
    switch (e.type) {
        case 'chat': return `[${t}] chat <${e.from}> ${e.text}`;
        case 'whisper': return `[${t}] whisper (only to you) <${e.from}> ${e.text}`;
        default: return `[${t}] ${e.type}: ${e.text}${rep}`;
    }
}
