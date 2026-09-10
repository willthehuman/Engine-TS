// Pepe bot — deterministic routines. Pure code executors; no LLM in here.

import { findPath } from '#/engine/GameMap.js';
import World from '#/engine/World.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';

export type RoutineStatus = 'running' | 'done' | 'aborted';

export interface Routine {
    step(bot: BotPlayer): RoutineStatus;
}

/**
 * Walk to a tile, staged for long journeys. The rsmod A* window is ~64 tiles,
 * so anything farther is walked in SEGMENT-sized hops toward the destination
 * (this is how a 2004 player crossed the map — the client streamed waypoints).
 * Arrival/stuck detection included.
 */
export class WalkRoutine implements Routine {
    private destX: number;
    private destZ: number;
    private issued = false;
    private stuckTicks = 0;
    private lastX = -1;
    private lastZ = -1;
    private maxStuck = 50; // ~30s without position change = abort
    private readonly SEGMENT = 40;

    constructor(x: number, z: number) {
        this.destX = x;
        this.destZ = z;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        if (p.x === this.destX && p.z === this.destZ) {
            return 'done';
        }

        // stuck detection
        if (p.x === this.lastX && p.z === this.lastZ) {
            this.stuckTicks++;
            if (this.stuckTicks >= this.maxStuck) {
                return 'aborted';
            }
        } else {
            this.stuckTicks = 0;
            this.lastX = p.x;
            this.lastZ = p.z;
        }

        // (re)issue when: never issued, path exhausted mid-journey, or stalled 10 ticks
        const needIssue = !this.issued || !p.hasWaypoints() || (this.stuckTicks > 0 && this.stuckTicks % 10 === 0);
        if (needIssue) {
            const dx = this.destX - p.x;
            const dz = this.destZ - p.z;
            const dist = Math.max(Math.abs(dx), Math.abs(dz));
            let tx = this.destX;
            let tz = this.destZ;
            if (dist > this.SEGMENT) {
                const scale = this.SEGMENT / dist;
                tx = p.x + Math.round(dx * scale);
                tz = p.z + Math.round(dz * scale);
            }
            const res = bot.walkSegment(tx, tz);
            if (res.ok) {
                this.issued = true;
            } else if (tx !== this.destX || tz !== this.destZ) {
                // segment unreachable — try progressively smaller hops toward it
                const half = Math.max(5, Math.floor(this.SEGMENT / 2));
                const dxs = this.destX - p.x;
                const dzs = this.destZ - p.z;
                const dists = Math.max(Math.abs(dxs), Math.abs(dzs));
                const scale = Math.min(1, half / dists);
                const hx = p.x + Math.round(dxs * scale);
                const hz = p.z + Math.round(dzs * scale);
                if (!bot.walkSegment(hx, hz).ok) {
                    return 'aborted';
                }
                this.issued = true;
            } else {
                return 'aborted';
            }
        }
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

/**
 * Follow a player (the "come with me" routine). Persistent: runs until the
 * target logs out / despawns, gets stuck 60 ticks, or an admin stop clears it.
 * Approaches with the SMART pathfinder and re-paths when the target moves.
 */
export class FollowRoutine implements Routine {
    private targetName: string;
    private lastQueueX = -1;
    private lastQueueZ = -1;
    private lastX = -1;
    private lastZ = -1;
    private stuck = 0;
    private readonly KEEP_DIST = 1; // close enough — stop stepping
    private readonly REPATH_DIST = 3; // target drifted this far from our path dest → re-path
    private readonly MAX_STUCK = 60; // ~36s of no progress → give up

    constructor(name: string) {
        this.targetName = name;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        const target = World.getPlayerByUsername(this.targetName);
        if (!target || target.level !== p.level) {
            botLog.append('reflex', { kind: 'follow_lost', user: this.targetName });
            return 'done';
        }

        const dx = target.x - p.x;
        const dz = target.z - p.z;
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        if (dist <= this.KEEP_DIST) {
            this.stuck = 0;
            this.lastX = p.x;
            this.lastZ = p.z;
            return 'running';
        }

        // re-path when we have no waypoints, or the target has drifted from our
        // last planned destination (keeps us honest — we path to where they ARE)
        if (!p.hasWaypoints() || Math.abs(target.x - this.lastQueueX) >= this.REPATH_DIST || Math.abs(target.z - this.lastQueueZ) >= this.REPATH_DIST) {
            const path = findPath(p.level, p.x, p.z, target.x, target.z);
            if (path.length > 0) {
                p.queueWaypoints(path);
                this.lastQueueX = target.x;
                this.lastQueueZ = target.z;
            }
        }

        if (p.x === this.lastX && p.z === this.lastZ) {
            this.stuck++;
            if (this.stuck >= this.MAX_STUCK) {
                botLog.append('reflex', { kind: 'follow_stuck', user: this.targetName });
                return 'done';
            }
        } else {
            this.stuck = 0;
            this.lastX = p.x;
            this.lastZ = p.z;
        }
        return 'running';
    }
}
