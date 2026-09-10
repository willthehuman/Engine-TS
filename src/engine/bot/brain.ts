// Pepe bot — brain scheduler + reflexes. Wired into World.cycle() by bot-hook.ts.
// The LLM never runs in here; this is the deterministic tier.
// Decision calls (Phase 2.3+) arrive through the control surface / MCP tools.

import World from '#/engine/World.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import { WanderRoutine } from './routines.js';
import { maybeDecide } from './decide.js';
import type { BotPlayer } from './BotPlayer.js';

export class Brain {
    bots: BotPlayer[] = [];

    register(bot: BotPlayer): void {
        this.bots.push(bot);
    }

    /** Called every world tick from the hook. Must stay cheap. */
    tick(): void {
        for (const bot of this.bots) {
            try {
                this.reflexes(bot);
                bot.tick();
            } catch (err) {
                botLog.append('error', { where: 'brain.tick', err: String(err) });
                bot.brainState = 'error';
            }
        }
    }

    /** Engine-side reflexes: run before/above any routine or LLM decision. */
    private reflexes(bot: BotPlayer): void {
        const p = bot.player;

        // death/respawn: engine handles respawn itself; we just drop routines
        if (p.levels[3] <= 0) {
            if (bot.brainState !== 'idle') {
                bot.clearRoutines();
                botLog.append('reflex', { kind: 'death', tile: { x: p.x, z: p.z } });
            }
            return;
        }

        // idle fallback: no routine, not frozen/error -> wander (the "busy player" look)
        if (bot.brainState === 'idle' && !bot.currentRoutineName) {
            bot.enqueue(new WanderRoutine());
        }

        // decision layer: fire an LLM decision if fresh interesting chat exists
        maybeDecide(bot);
    }

    /** Perceived chat tail for the decision layer (honesty-filtered). */
    chatTail(_bot: BotPlayer, n = 10) {
        return botLog.tail('chat', n);
    }

    nearby(bot: BotPlayer) {
        const players: unknown[] = [];
        for (const p of World.playerLoop.all()) {
            players.push(p);
        }
        return Percept.nearby(bot, players as never);
    }
}
