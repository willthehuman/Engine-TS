// Pepe bot — deterministic routines. Pure code executors; no LLM in here.

import { findPath, canTravel } from '#/engine/GameMap.js';
import { CollisionType } from '#/engine/routefinder/index.js';
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
    private bestDist = Infinity; // best (smallest) distance seen so far
    private maxStuck = 80; // ~50s without improvement = abort (long enough for door tasks)
    private readonly SEGMENT = 40;

    constructor(x: number, z: number) {
        this.destX = x;
        this.destZ = z;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        // Adjacent counts as arrived: goto targets are often LOC tiles (trees,
        // objects) you cannot stand ON — parking next to them IS the arrival
        // (2026-09-11: soul's goto:tree x,y froze WalkRoutine 17 min).
        if (Math.max(Math.abs(p.x - this.destX), Math.abs(p.z - this.destZ)) <= 1) {
            return 'done';
        }

        // stuck detection: if the player's distance to the destination hasn't
        // improved (decreased) for maxStuck consecutive ticks, it's stuck.
        // If a door task is active, the player may be walking toward a door
        // that is off the direct path — distance to the destination may not
        // improve, so don't count that as stuck.
        const dist = Math.max(Math.abs(p.x - this.destX), Math.abs(p.z - this.destZ));
        const doorTaskActive = (bot as unknown as Record<string, unknown>).doorTask != null;
        if (!doorTaskActive && dist < this.bestDist) {
            this.bestDist = dist;
            this.stuckTicks = 0;
        } else if (!doorTaskActive) {
            this.stuckTicks++;
        }
        if (this.stuckTicks >= this.maxStuck) {
            return 'aborted';
        }

        // Door task owns the bot while it runs: scenery ops only execute on a
        // tick where the player takes NO steps (tryInteract's allowOpScenery =
        // stepsTaken === 0). Issuing any movement here cancels that window and
        // the door never actually opens (2026-09-12: cold-trace root cause —
        // fired door_open but the doorway stayed blocked forever).
        if (doorTaskActive) {
            return 'running';
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
            } else if (res.reason === 'door_opening') {
                // A door task is in progress — don't re-issue every tick.
                // The door task advances on its own; the next re-issue
                // (triggered by exhausted waypoints or stall) will find
                // the door open and succeed.
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

/**
 * Tile-per-tile walk: always targets the NEXT single step toward the
 * destination — exactly like a player clicking the adjacent tile over and
 * over. No long-distance A* ever runs, so the "path cannot be made through
 * a door" dead-end class of failures disappears: each hop is a trivially
 * short findPath that either succeeds (walk one tile) or triggers the door
 * opener and retries next tick.
 *
 * Use for long journeys where the old segment-based WalkRoutine loops.
 * Slower (one A* per tile) but bullet-proof against mid-route blockers.
 */
export class StepWalkRoutine implements Routine {
    private destX: number;
    private destZ: number;
    private stuckTicks = 0;
    private bestDist = Infinity; // best (smallest) distance seen so far
    private readonly maxStuck = 40; // ~24s of no improvement = fallback (door tasks take ~20 ticks)

    constructor(x: number, z: number) {
        this.destX = x;
        this.destZ = z;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        // arrived (exact tile match for stepwalk — no LOC-tile leniency)
        if (p.x === this.destX && p.z === this.destZ) {
            return 'done';
        }

        // stuck detection: if the player's distance to the destination hasn't
        // improved (decreased) for maxStuck consecutive ticks, it's stuck.
        // If a door task is active, the player may be walking toward a door
        // that is off the direct path — distance to the destination may not
        // improve, so don't count that as stuck.
        const dist = Math.max(Math.abs(p.x - this.destX), Math.abs(p.z - this.destZ));
        const doorTaskActive = (bot as unknown as Record<string, unknown>).doorTask != null;
        if (!doorTaskActive && dist < this.bestDist) {
            this.bestDist = dist;
            this.stuckTicks = 0;
        } else if (!doorTaskActive) {
            this.stuckTicks++;
        }
        // Debug: log stuck state every 5 ticks
        if (this.stuckTicks > 0 && this.stuckTicks % 5 === 0) {
            botLog.append('reflex', { kind: 'stepwalk_stuck_debug', x: p.x, z: p.z, dist, bestDist: this.bestDist, stuckTicks: this.stuckTicks, maxStuck: this.maxStuck, doorTaskActive });
        }
        if (this.stuckTicks >= this.maxStuck) {
            return 'aborted';
        }

        // Freeze while a door task runs — see WalkRoutine note (stepsTaken
        // must be 0 for the loc op to execute).
        if (doorTaskActive) {
            return 'running';
        }

        // Build candidate steps toward the destination, sorted by
        // Chebyshev distance (closest to dest first).
        const dx = this.destX - p.x;
        const dz = this.destZ - p.z;
        const sx = dx === 0 ? 0 : Math.sign(dx);
        const sz = dz === 0 ? 0 : Math.sign(dz);

        const cands: [number, number][] = [];
        // axis steps first
        if (sx !== 0) cands.push([p.x + sx, p.z]);
        if (sz !== 0) cands.push([p.x, p.z + sz]);
        // diagonals
        if (sx !== 0 && sz !== 0) {
            cands.push([p.x + sx, p.z + sz]);
            if (Math.abs(dx) > Math.abs(dz)) {
                cands.push([p.x + sx, p.z + (sz > 0 ? -sz : sz)]);
            } else {
                cands.push([p.x + (sx > 0 ? -sx : sx), p.z + sz]);
            }
        }
        // remaining diagonals
        for (const [dx2, dz2] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1]
        ]) {
            const cx = p.x + dx2,
                cz = p.z + dz2;
            if (!cands.some(([a, b]) => a === cx && b === cz)) {
                cands.push([cx, cz]);
            }
        }

        cands.sort((a, b) => {
            const da = Math.max(Math.abs(a[0] - this.destX), Math.abs(a[1] - this.destZ));
            const db = Math.max(Math.abs(b[0] - this.destX), Math.abs(b[1] - this.destZ));
            return da - db;
        });

        for (const [cx, cz] of cands) {
            if (cx === p.x && cz === p.z) continue;
            if (!bot.validCoords(cx, cz)) continue;
            // Don't step away from the destination
            const cDist = Math.max(Math.abs(cx - this.destX), Math.abs(cz - this.destZ));
            const pDist = Math.max(Math.abs(p.x - this.destX), Math.abs(p.z - this.destZ));
            if (cDist >= pDist) {
                continue;
            }
            // Single-tile collision check — bypasses A* entirely
            if (!canTravel(p.level, p.x, p.z, cx - p.x, cz - p.z, 1, 0, CollisionType.NORMAL)) {
                continue;
            }
            // Use walkSegment (findPath-based) for reliable single-tile movement
            const res = bot.walkSegment(cx, cz);
            if (res.ok) {
                return 'running';
            }
            // door_opening: a door task is in progress — keep running, the door
            // task advances independently and the next tick re-paths successfully
            if (res.reason === 'door_opening') {
                return 'running';
            }
        }

        // Debug: log when we're about to abort
        botLog.append('reflex', {
            kind: 'stepwalk_about_to_abort',
            x: p.x,
            z: p.z,
            destX: this.destX,
            destZ: this.destZ,
            dist: Math.max(Math.abs(p.x - this.destX), Math.abs(p.z - this.destZ)),
            bestDist: this.bestDist,
            stuckTicks: this.stuckTicks,
            cands: cands.length
        });
        return 'aborted';
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
