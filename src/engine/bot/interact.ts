// Pepe bot — generic interaction primitives. One mechanism, every interaction:
// find an entity by name (NPC / loc / ground obj), walk to it (staged for any
// distance), and fire its Nth op exactly the way the real client handler does
// (setInteraction(ENGINE, target, APXXX<op>) + opcalled). No per-content code.
//
// Supported targets:
//   npc:  NpcType.name match (alive only — corpses excluded)
//   loc:  LocType.name match (static world objects: trees, rocks, doors, banks)
//   obj:  ground items
//
// The "op" is 1-based and maps to the right-click menu order (op1 = first menu
// entry, e.g. 'Chop down' on a tree is usually op1; 'Attack' on a chicken is op2).

import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { isLineOfWalk } from '#/engine/GameMap.js';
import World from '#/engine/World.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import Obj from '#/engine/entity/Obj.js';
import Entity from '#/engine/entity/Entity.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import { botLog } from './EventLog.js';
import { wasUnreachable, clearDialogFlags } from './dialog.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine, RoutineStatus } from './routines.js';

export type InteractKind = 'npc' | 'loc' | 'obj';

interface OpLikeType {
    op?: (string | null)[];
}

export interface InteractTarget {
    kind: InteractKind;
    name: string; // resolved entity name
    x: number;
    z: number;
    level: number;
    entity: () => Npc | Loc | Obj;
    opIndex: number; // 1-based op on the entity's type
    opName: string;
}

const matches = (needle: string, ...cands: (string | null | undefined)[]): boolean =>
    cands.some(c => {
        if (!c) return false;
        const lc = c.toLowerCase();
        return lc === needle || lc.includes(needle);
    });

/** Exact name match (avoids "door" hitting "Trapdoor"). Null when none exact. */
const matchesExact = (needle: string, ...cands: (string | null | undefined)[]): boolean =>
    cands.some(c => {
        if (!c) return false;
        return c.toLowerCase() === needle;
    });

/** List ops (right-click menu) for a type, skipping 'hidden'. */
function opsFor(type: OpLikeType): { index: number; name: string }[] {
    const out: { index: number; name: string }[] = [];
    const ops = type.op ?? [];
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || op === 'hidden') continue;
        out.push({ index: i + 1, name: op });
    }
    return out;
}

/** Resolve an op by name ("attack", "chop down") or 1-based number, case-insensitive. */
export function resolveOp(type: OpLikeType, op: string | number): { index: number; name: string } | null {
    const ops = opsFor(type);
    if (typeof op === 'number') {
        return ops.find(o => o.index === op) ?? null;
    }
    const q = op.trim().toLowerCase();
    return ops.find(o => o.name.toLowerCase() === q) ?? ops.find(o => o.name.toLowerCase().includes(q)) ?? null;
}

/** Find the nearest matching entity across the requested kinds (nearest wins).
 * Exact name matches beat substring matches ("door" must not resolve Trapdoor). */
export function findTarget(bot: BotPlayer, query: string, op: string | number, kinds: InteractKind[] = ['npc', 'loc', 'obj'], preferReachable = false): InteractTarget | null {
    return scanTargets(bot, query, op, kinds, true, preferReachable) ?? scanTargets(bot, query, op, kinds, false, preferReachable);
}

function scanTargets(bot: BotPlayer, query: string, op: string | number, kinds: InteractKind[], exact: boolean, preferReachable = false): InteractTarget | null {
    const p = bot.player;
    const q = query.trim().toLowerCase();
    const hit = (...cands: (string | null | undefined)[]): boolean => (exact ? matchesExact(q, ...cands) : matches(q, ...cands));
    let best: InteractTarget | null = null;
    let bestDist = Infinity;
    // Nearest target with a CLEAR walk-line from the player. Killing across a
    // fence/wall means endless "I can't reach that!" re-fires — when the
    // caller asks preferReachable (gather), a same-side target wins.
    let bestReach: InteractTarget | null = null;
    let bestReachDist = Infinity;

    if (kinds.includes('npc')) {
        for (const npc of World.npcs) {
            const nt = NpcType.get(npc.type);
            if (!hit(nt?.name, nt?.debugname)) continue;
            if (npc.level !== p.level) continue;
            if (npc.levels[3] <= 0) continue; // corpse: never target the dying
            const dist = Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z));
            if (dist < bestDist) {
                const r = resolveOp(nt as OpLikeType, op);
                if (!r) continue;
                best = { kind: 'npc', name: nt!.name ?? q, x: npc.x, z: npc.z, level: npc.level, entity: () => npc, opIndex: r.index, opName: r.name };
                bestDist = dist;
            }
            if (preferReachable && dist < bestReachDist && isLineOfWalk(p.level, p.x, p.z, npc.x, npc.z)) {
                const r2 = resolveOp(nt as OpLikeType, op);
                if (!r2) continue;
                bestReach = { kind: 'npc', name: nt!.name ?? q, x: npc.x, z: npc.z, level: npc.level, entity: () => npc, opIndex: r2.index, opName: r2.name };
                bestReachDist = dist;
            }
        }
    }

    if (kinds.includes('loc')) {
        for (const zone of World.gameMap.allZones()) {
            for (const loc of zone.getAllLocsSafe()) {
                const lt = LocType.get(loc.type);
                if (!hit(lt?.name, lt?.debugname)) continue;
                if (loc.level !== p.level) continue;
                const dist = Math.max(Math.abs(loc.x - p.x), Math.abs(loc.z - p.z));
                if (dist < bestDist) {
                    const r = resolveOp(lt as OpLikeType, op);
                    if (!r) continue;
                    best = { kind: 'loc', name: lt!.name ?? q, x: loc.x, z: loc.z, level: loc.level, entity: () => loc, opIndex: r.index, opName: r.name };
                    bestDist = dist;
                }
            }
        }
    }

    if (kinds.includes('obj')) {
        for (const zone of World.gameMap.allZones()) {
            for (const obj of zone.getAllObjsSafe()) {
                const ot = ObjType.get(obj.type);
                if (!hit(ot?.name, ot?.debugname)) continue;
                if (obj.level !== p.level) continue;
                const dist = Math.max(Math.abs(obj.x - p.x), Math.abs(obj.z - p.z));
                if (dist < bestDist) {
                    const r = resolveOp(ot as OpLikeType, op);
                    if (!r) continue;
                    best = { kind: 'obj', name: ot!.name ?? q, x: obj.x, z: obj.z, level: obj.level, entity: () => obj, opIndex: r.index, opName: r.name };
                    bestDist = dist;
                }
            }
        }
    }

    return preferReachable ? (bestReach ?? best) : best;
}

enum Phase {
    FIND,
    APPROACH,
    FIRE,
    DONE
}

/**
 * InteractRoutine: walk to the nearest matching entity and fire its op.
 * NPC ops persist (engine drives the combat/dialogue loop after the trigger);
 * loc/obj ops fire once — skilling loops are composed by the caller
 * (goal steps / repeat semantics), not baked in here.
 */
export class InteractRoutine implements Routine {
    private query: string;
    private op: string | number;
    private kinds: InteractKind[];
    private phase: Phase = Phase.FIND;
    private target: InteractTarget | null = null;
    private firedAt = -1;
    private lastX = -1;
    private lastZ = -1;
    private stuckTicks = 0;
    private firedOnce = false;
    private findRetries = 0;
    private readonly MAX_FIND_RETRIES = 6;
    private farWaits = 0;
    private readonly MAX_FAR_WAITS = 4; // re-scan before hiking (drops spawn late)
    private waitTicks = 0;
    private readonly FAR_DIST = 40;
    private pathGoal: { x: number; z: number } | null = null;
    private badTiles: Set<string> = new Set(); // engine-rejected stand tiles
    private recentPicks: string[] = []; // oscillation guard: last issued destinations
    private targetKey = '';
    private lastIssueTick = -100;
    private readonly ISSUE_COOLDOWN = 3; // let movement happen between re-issues
    private progressX = -1;
    private progressZ = -1;
    private progressAt = 0; // tick of last net-progress sample

    constructor(query: string, op: string | number, kinds: InteractKind[] = ['npc', 'loc', 'obj']) {
        this.query = query;
        this.op = op;
        this.kinds = kinds;
    }

    private stillValid(p: { hash64: bigint; level: number }): boolean {
        const t = this.target;
        if (!t) {
            return false;
        }
        if (t.kind === 'npc') {
            const npc = t.entity() as Npc;
            return !!World.getNpc(npc.nid) && npc.levels[3] > 0;
        }
        if (t.kind === 'loc') {
            const loc = t.entity() as Loc;
            return !!World.getLoc(t.x, t.z, t.level, loc.type);
        }
        const obj = t.entity() as Obj;
        return !!World.getObj(t.x, t.z, t.level, obj.type, p.hash64);
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;

        switch (this.phase) {
            case Phase.FIND: {
                if (this.waitTicks > 0) {
                    this.waitTicks--;
                    return 'running'; // grace period: a drop may still be spawning
                }
                const t = findTarget(bot, this.query, this.op, this.kinds);
                if (!t) {
                    botLog.append('reflex', { kind: 'interact_no_target', query: this.query, op: String(this.op) });
                    return 'aborted';
                }
                const tDist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
                if (tDist > this.FAR_DIST && this.farWaits < this.MAX_FAR_WAITS) {
                    // only far matches (e.g. kill drop hasn't spawned yet) — wait
                    // and re-scan rather than hiking across the map immediately
                    this.farWaits++;
                    this.waitTicks = 10; // ~6s
                    return 'running';
                }
                if (++this.findRetries > this.MAX_FIND_RETRIES) {
                    botLog.append('reflex', { kind: 'interact_unreachable', query: this.query, target: t.name, dist: Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z)) });
                    return 'aborted';
                }
                this.target = t;
                this.stuckTicks = 0;
                this.lastX = -1;
                this.lastZ = -1;
                this.pathGoal = null;
                const key = t.kind + ':' + t.x + ',' + t.z;
                if (key !== this.targetKey) {
                    // new entity — reset per-target memory
                    this.targetKey = key;
                    this.badTiles.clear();
                    this.recentPicks = [];
                }
                this.lastIssueTick = -100;
                this.progressX = p.x;
                this.progressZ = p.z;
                this.progressAt = World.currentTick;
                this.firedOnce = false;
                this.firedAt = -1;
                this.phase = Phase.APPROACH;
                return 'running';
            }
            case Phase.APPROACH: {
                const t = this.target!;
                // re-resolve liveness each step (npcs die/move; locs/objs may despawn)
                if (!this.stillValid(p)) {
                    botLog.append('action', { action: 'approach_retry', why: 'invalid', query: this.query });
                    this.phase = Phase.FIND;
                    return 'running';
                }
                if (t.kind === 'npc') {
                    const npc = t.entity() as Npc;
                    if (Math.abs(npc.x - t.x) > 2 || Math.abs(npc.z - t.z) > 2) {
                        this.phase = Phase.FIND; // wandered — re-target the fresh nearest
                        return 'running';
                    }
                }
                const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
                if (dist <= 1) {
                    this.pathGoal = { x: p.x, z: p.z }; // already adjacent — fire from here
                    clearDialogFlags();
                    this.phase = Phase.FIRE;
                    return 'running';
                }
                // naive interaction-walk ping-pongs: our own smart pathing walks
                if (p.hasInteraction()) {
                    p.clearInteraction();
                }
                if (p.x === this.lastX && p.z === this.lastZ) {
                    this.stuckTicks++;
                    if (this.stuckTicks >= 50) {
                        botLog.append('action', { action: 'approach_retry', why: 'stuck', query: this.query });
                        this.phase = Phase.FIND;
                        return 'running';
                    }
                } else {
                    this.stuckTicks = 0;
                    this.lastX = p.x;
                    this.lastZ = p.z;
                }
                // net-progress detection: same tile as 15 ticks ago = going nowhere
                // (catches A↔B oscillation, where per-tick stuck detection is blind)
                if (World.currentTick - this.progressAt >= 15) {
                    if (p.x === this.progressX && p.z === this.progressZ) {
                        botLog.append('action', { action: 'approach_retry', why: 'no_progress', query: this.query });
                        this.phase = Phase.FIND;
                        return 'running';
                    }
                    this.progressX = p.x;
                    this.progressZ = p.z;
                    this.progressAt = World.currentTick;
                }
                if (!p.hasWaypoints()) {
                    // stand candidates: target tile first, then neighbors closest to
                    // Pepe — ops fire fine from adjacent, and the exact tile is often
                    // blocked (fence/wall) or unreachable from this side
                    const cands: { x: number; z: number }[] = [{ x: t.x, z: t.z }];
                    const neighbors: { x: number; z: number; d: number }[] = [];
                    for (let ax = -1; ax <= 1; ax++) {
                        for (let az = -1; az <= 1; az++) {
                            if (ax === 0 && az === 0) continue;
                            neighbors.push({ x: t.x + ax, z: t.z + az, d: Math.max(Math.abs(p.x - (t.x + ax)), Math.abs(p.z - (t.z + az))) });
                        }
                    }
                    neighbors.sort((a, b) => a.d - b.d);
                    for (const n of neighbors) {
                        cands.push(n);
                    }
                    let picked: { x: number; z: number } | null = null;
                    if (dist <= 50 && World.currentTick - this.lastIssueTick >= this.ISSUE_COOLDOWN) {
                        const closeIn = dist <= 8; // oscillation guard only matters adjacent
                        for (const c of cands) {
                            const key = c.x + ',' + c.z;
                            if (this.badTiles.has(key)) continue;
                            if (closeIn && this.recentPicks.includes(key)) continue; // don't re-issue a fresh pick (oscillation)
                            if (bot.walkSegment(c.x, c.z).ok) {
                                picked = c;
                                break;
                            }
                        }
                    }
                    if (!picked && dist > 8) {
                        // far: staged hops toward the target (halving on blockage)
                        for (const seg of [50, 25, 12, 6]) {
                            const s = Math.min(1, seg / dist);
                            const hx = p.x + Math.round((t.x - p.x) * s);
                            const hz = p.z + Math.round((t.z - p.z) * s);
                            if (bot.walkSegment(hx, hz).ok) {
                                picked = { x: hx, z: hz };
                                break;
                            }
                        }
                    }
                    if (picked) {
                        this.pathGoal = picked;
                        this.lastIssueTick = World.currentTick;
                        this.recentPicks.push(picked.x + ',' + picked.z);
                        if (this.recentPicks.length > 6) {
                            this.recentPicks.shift();
                        }
                    } else {
                        botLog.append('action', { action: 'approach_retry', why: 'no_candidate', query: this.query, dist });
                        this.phase = Phase.FIND;
                    }
                }
                return 'running';
            }
            case Phase.FIRE: {
                const t = this.target!;
                // NOTE: locs skip re-validation here — firing an op like Open/Cut
                // often swaps the loc's type id, which must NOT read as "vanished"
                if (t.kind !== 'loc' && !this.stillValid(p)) {
                    this.phase = Phase.FIND;
                    return 'running';
                }
                if (wasUnreachable()) {
                    // engine said "I can't reach that!" — this stand tile can't work
                    // the op through (fence/wall). Blacklist it, try next candidate.
                    clearDialogFlags();
                    if (this.pathGoal) {
                        this.badTiles.add(this.pathGoal.x + ',' + this.pathGoal.z);
                    }
                    p.clearInteraction();
                    this.phase = Phase.APPROACH;
                    return 'running';
                }
                const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
                if (dist > 1) {
                    this.phase = Phase.APPROACH;
                    return 'running';
                }
                p.clearWaypoints();
                const trigger = triggerFor(t);
                const ok = p.setInteraction(Interaction.ENGINE, t.entity() as Entity, trigger);
                if (ok) {
                    p.opcalled = true;
                    if (!this.firedOnce) {
                        this.firedOnce = true;
                        this.firedAt = World.currentTick;
                        botLog.append('action', { action: 'interact', kind: t.kind, target: t.name, op: t.opName, opIndex: t.opIndex });
                    }
                    if (t.kind === 'npc') {
                        if (World.currentTick - this.firedAt > 100) {
                            this.phase = Phase.FIND; // engine won't hold it — re-target
                            return 'running';
                        }
                        return 'running'; // engine loop (combat/dialog) takes over
                    }
                    if (t.kind === 'obj') {
                        // done when the ground item is actually gone (picked up)
                        if (!this.stillValid(p)) {
                            return 'done';
                        }
                        if (World.currentTick - this.firedAt > 25) {
                            return 'done'; // pickup stalled — let the caller retry
                        }
                        return 'running';
                    }
                    // loc ops (chop/mine/etc): one action cycle, caller composes repeats
                    if (World.currentTick - this.firedAt > 8) {
                        return 'done';
                    }
                    return 'running';
                }
                this.phase = Phase.FIND;
                return 'running';
            }
            case Phase.DONE:
                return 'done';
        }
    }
}

function triggerFor(t: InteractTarget): ServerTriggerType {
    switch (t.kind) {
        case 'npc':
            return ServerTriggerType.APNPC1 + (t.opIndex - 1);
        case 'loc':
            return ServerTriggerType.APLOC1 + (t.opIndex - 1);
        case 'obj':
            return ServerTriggerType.APOBJ1 + (t.opIndex - 1);
    }
}
