// Pepe bot — deterministic routines. Pure code executors; no LLM in here.

import type { BotPlayer } from './BotPlayer.js';

export type RoutineStatus = 'running' | 'done' | 'aborted';

export interface Routine {
    step(bot: BotPlayer): RoutineStatus;
}

/** Walk to a tile (server pathfinding via BotPlayer.moveTo) and detect arrival/stuck. */
export class WalkRoutine implements Routine {
    private destX: number;
    private destZ: number;
    private issued = false;
    private stuckTicks = 0;
    private lastX = -1;
    private lastZ = -1;
    private maxStuck = 50; // ~30s without position change = abort

    constructor(x: number, z: number) {
        this.destX = x;
        this.destZ = z;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        if (!this.issued) {
            const res = bot.moveTo(this.destX, this.destZ);
            this.issued = true;
            if (!res.ok) {
                return 'aborted';
            }
            return 'running';
        }
        if (p.x === this.destX && p.z === this.destZ) {
            return 'done';
        }
        // stuck detection
        if (p.x === this.lastX && p.z === this.lastZ) {
            this.stuckTicks++;
            if (this.stuckTicks >= this.maxStuck) {
                return 'aborted';
            }
            // re-issue path every 10 stuck ticks (path may have been cleared)
            if (this.stuckTicks % 10 === 0) {
                this.issued = false;
            }
            return 'running';
        }
        this.lastX = p.x;
        this.lastZ = p.z;
        this.stuckTicks = 0;
        return 'running';
    }
}

/** Do nothing for N ticks. */
export class WaitRoutine implements Routine {
    private remaining: number;
    constructor(ticks: number) {
        this.remaining = ticks;
    }
    step(_bot: BotPlayer): RoutineStatus {
        return --this.remaining <= 0 ? 'done' : 'running';
    }
}

/**
 * Wander: pick a random walkable tile within persona.wanderRadius of the anchor,
 * walk there, dwell a random 5–60s. This IS the "busy player" idle look.
 * Anchor = wherever Pepe was when the wander started (Lumbridge by default).
 */
export class WanderRoutine implements Routine {
    private anchorX: number | null = null;
    private anchorZ: number | null = null;
    private inner: Routine | null = null;

    step(bot: BotPlayer): RoutineStatus {
        if (this.anchorX === null) {
            this.anchorX = bot.player.x;
            this.anchorZ = bot.player.z;
        }
        const anchorX = this.anchorX;
        const anchorZ = this.anchorZ;
        if (this.inner) {
            const s = this.inner.step(bot);
            if (s === 'running') {
                return 'running';
            }
            this.inner = null;
            // dwell before picking a new target
            this.inner = new WaitRoutine(8 + Math.floor(Math.random() * 100)); // ~5-60s
            return 'running';
        }
        const r = bot.persona.wanderRadius;
        const tx = anchorX! + Math.floor(Math.random() * (2 * r + 1)) - r;
        const tz = anchorZ! + Math.floor(Math.random() * (2 * r + 1)) - r;
        this.inner = new WalkRoutine(tx, tz);
        return 'running';
    }
}
