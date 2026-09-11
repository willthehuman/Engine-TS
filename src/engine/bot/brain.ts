// Pepe bot — brain scheduler + reflexes. Wired into World.cycle() by bot-hook.ts.
// The LLM never runs in here; this is the deterministic tier.
// Decision calls (Phase 2.3+) arrive through the control surface / MCP tools.

import World from '#/engine/World.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import { WanderRoutine } from './routines.js';
import { maybeDecide } from './decide.js';
import { forwardNotice, soulRoutingEnabled, summarizeNotable, noticesMuted } from './webhook.js';
import type { BotPlayer } from './BotPlayer.js';

const SKILL_NAMES = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving'];

export class Brain {
    bots: BotPlayer[] = [];
    private lastBase = new Map<string, number[]>();
    private lastNoticedSeq = 0;
    private noticedInit = false;

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
        this.noticePoll();
    }

    /**
     * Strategist feed: exactly-once forwarding of notable bot-log events to the
     * Hermes soul (train_done, level_up, death, retreats, unreachable paths...).
     * Level-ups are detected here too (baseLevels diff). Cheap: one tail scan.
     */
    private noticePoll(): void {
        for (const bot of this.bots) {
            const name = bot.player.username;
            const prev = this.lastBase.get(name);
            const cur = Array.from(bot.player.baseLevels.slice(0, SKILL_NAMES.length));
            if (prev) {
                for (let i = 0; i < cur.length; i++) {
                    if (cur[i] > (prev[i] ?? 1)) {
                        botLog.append('action', { action: 'level_up', skill: SKILL_NAMES[i], level: cur[i] });
                        break; // one per tick max; others surface next ticks
                    }
                }
            }
            this.lastBase.set(name, cur);
        }
        if (!soulRoutingEnabled() || noticesMuted()) {
            // still advance the cursor so a later enable doesn't replay history
            const tail = botLog.tail(null, 1);
            if (tail.length > 0) {
                this.lastNoticedSeq = Math.max(this.lastNoticedSeq, tail[0].seq);
            }
            return;
        }
        const fresh = botLog.tail(null, 60).filter(e => e.seq > this.lastNoticedSeq);
        if (!this.noticedInit) {
            // first poll after boot: baseline, don't replay history
            this.noticedInit = true;
            if (fresh.length > 0) {
                this.lastNoticedSeq = fresh[fresh.length - 1].seq;
            }
            return;
        }
        let sent = 0;
        for (const ev of fresh) {
            this.lastNoticedSeq = Math.max(this.lastNoticedSeq, ev.seq);
            if (sent >= 3) {
                continue; // drain cursor, rate-limit wakes
            }
            const text = summarizeNotable(ev);
            if (text) {
                sent++;
                forwardNotice(text, { event: ev.type + ':' + String((ev.data as { action?: string; kind?: string }).action ?? (ev.data as { kind?: string }).kind ?? '?') });
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
