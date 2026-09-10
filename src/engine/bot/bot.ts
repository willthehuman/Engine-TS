// Pepe bot — single entry point wiring the bot system into the engine.
// Two touch points in existing files (kept minimal):
//   1. World.ts processClientsIn(): chat tap after `this.logPublicChat(player, player.logMessage)`
//   2. World.ts cycle(): brain.tick() once per cycle
// Everything else lives in src/engine/bot/.

import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { BotPlayer } from './BotPlayer.js';
import { Brain } from './brain.js';
import { Percept } from './Percept.js';
import { botLog } from './EventLog.js';

export const brain = new Brain();

/** World-cycle hook: one deterministic brain tick. */
export function botTick(): void {
    if (brain.bots.length === 0) {
        return;
    }
    brain.tick();
}

let started = false;

/** Boot: attach Pepe + start the tick loop. Idempotent. */
export async function startBot(): Promise<void> {
    if (started) {
        return;
    }
    started = true;

    const bot = await BotPlayer.attach();
    brain.register(bot);
    console.log(`[pepe] attached: ${bot.player.username} at ${bot.player.x},${bot.player.z},${bot.player.level}`);
}

/** Chat tap — called from World.processClientsIn() once per player chat message. */
export function tapChat(sender: NetworkPlayer | import('#/engine/entity/Player.js').default, text: string): void {
    if (brain.bots.length === 0) {
        return;
    }
    for (const bot of brain.bots) {
        // perception honesty: range + chat-mode + height-level filter
        if (sender.username === bot.player.username) {
            // Pepe's own words — record so the decision layer can see its own history
            botLog.append('chat', { from: bot.player.username, text, self: true });
            continue;
        }
        if (!Percept.canHear(bot, sender)) {
            continue;
        }
        botLog.append('chat', { from: sender.username, text, dist: tileDistance(bot.player, sender) });
    }
}

function tileDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}
