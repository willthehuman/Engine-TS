// Pepe bot — generic gathering. One mechanism, every farmable item:
// walk to the source area (any distance), interact with the source until the
// item shows up in the inventory (effect-verified), pick up ground drops.
//
// Sources are DATA, not code: data/bot_sources.json (or the builtin table
// below) maps an item name to how it is obtained. The soul grows the table
// with the `learn_source` /act action as it discovers new items — no recompile.
//
// Builtin source (egg): chickens in Lumbridge drop eggs as ground items
// (content/general/scripts/flavour_text/chickens.rs2 ai_timer obj_addall).
// Table entries:
//   { kind: 'npc',   query, op,         area: {x,z}, kills? }  — kill N and
//                                                               pick up drops
//   { kind: 'loc',   query, op,         area }                 — interact loc
//                                                               until item
//   { kind: 'obj',   query, op='take' }                        — pick up ground
//                                                               item directly
//   tool: { item, required } — when the source needs a tool (e.g. bucket),
//   gather fails fast with need_tool so the planner can add a buy milestone.

import World from '#/engine/World.js';
import { isLineOfWalk } from '#/engine/GameMap.js';
import NpcType from '#/cache/config/NpcType.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { botLog } from './EventLog.js';
import { inventorySnapshot } from './use_item.js';
import { findTarget, type InteractTarget } from './interact.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine, RoutineStatus } from './routines.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

export interface GatherSource {
    kind: 'npc' | 'loc' | 'obj';
    query: string;
    op: string | number;
    area?: { x: number; z: number };
    kills?: number; // npc sources: how many kills before giving up
    tool?: string;
}

const BUILTIN_SOURCES: Record<string, GatherSource> = {
    egg: {
        kind: 'npc',
        query: 'Chicken',
        op: 'attack',
        area: { x: 3191, z: 3276 },
        kills: 25
    }
    // milk / flour land here together with the shop-buy routine (tools:
    // bucket_empty / pot_empty at Lumbridge General Store).
};

let TABLE: Record<string, GatherSource> | null = null;
function sources(): Record<string, GatherSource> {
    if (TABLE) return TABLE;
    TABLE = { ...BUILTIN_SOURCES };
    try {
        const path = 'data/bot_sources.json';
        if (existsSync(path)) {
            const loaded = JSON.parse(readFileSync(path, 'utf-8'));
            for (const [item, src] of Object.entries(loaded)) {
                TABLE[item.toLowerCase()] = src as GatherSource;
            }
        }
    } catch {
        // corrupt table: keep builtins
    }
    return TABLE;
}

/** Items the gather verb can currently get (for goal_help / diagnostics). */
export function gatherItems(): string[] {
    return Object.keys(sources());
}

/** Register a source discovered in-game; persists to data/bot_sources.json. */
export function learnSource(item: string, src: GatherSource): { ok: boolean; error?: string } {
    const itemKey = item.trim().toLowerCase();
    if (!/^[a-z0-9_ -]{1,40}$/.test(itemKey)) {
        return { ok: false, error: `bad item name: "${itemKey}"` };
    }
    if (!['npc', 'loc', 'obj'].includes(src.kind)) {
        return { ok: false, error: `bad kind: ${src.kind}` };
    }
    sources()[itemKey] = src;
    try {
        const path = 'data/bot_sources.json';
        writeFileSync(path, JSON.stringify(sources(), null, 2));
    } catch (e: any) {
        return { ok: false, error: `persist failed: ${e.message}` };
    }
    return { ok: true };
}

enum Phase {
    WALK,
    FIGHT, // npc sources: kill until the drop lands
    PICKUP, // ground drop appeared — go get it
    DONE
}

/**
 * GatherRoutine: effect-verified gathering. Resolves the item's source,
 * walks to it from any distance, then loops interact → check the actual
 * outcome (inventory contains the item, or the drop landed on the floor and
 * was picked up). Aborts with a machine-readable reason on: missing tool,
 * no source, no drop after N kills / T ticks, unreachable, death.
 */
export class GatherRoutine implements Routine {
    private item: string;
    private src: GatherSource;
    private phase: Phase = Phase.WALK;
    private target: InteractTarget | null = null;
    private kills = 0;
    private walked = false;
    private startedAt = 0;
    private idleTicks = 0;
    private lastPos = { x: -1, z: -1 };
    private readonly MAX_TICKS = 1500; // ~15 min hard cap
    private blockTicks = 0;
    private readonly DROP_SCAN_RANGE = 15;

    constructor(item: string) {
        this.item = item.trim().toLowerCase();
        this.src = sources()[this.item];
    }

    get label(): string {
        return `GatherRoutine:${this.item}`;
    }

    private abort(reason: string, extra?: Record<string, unknown>): RoutineStatus {
        botLog.append('reflex', { kind: 'gather_fail', item: this.item, reason, ...(extra ?? {}) });
        return 'aborted';
    }

    private probeTick = 0;
    private engagedAt = -1;
    private lastFireTick = -100;

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        if (!this.src) {
            return this.abort('unknown_item', { known: gatherItems().join(',') });
        }
        // eyes-inside probe (30s cadence): routine state for remote diagnosis
        if (World.currentTick - this.probeTick > 50) {
            this.probeTick = World.currentTick;
            const near = findTarget(bot, this.src.query, this.src.op, [this.src.kind] as any);
            botLog.append('action', {
                action: 'gather_probe',
                item: this.item,
                phase: this.phase,
                walked: this.walked,
                at: `${p.x},${p.z}`,
                target: this.target ? `${this.target.name}@${this.target.x},${this.target.z}` : null,
                nearDist: near ? Math.max(Math.abs(near.x - p.x), Math.abs(near.z - p.z)) : null,
                interaction: (p as any).hasInteraction ? (p as any).hasInteraction() : '?',
                waypoints: (p as any).hasWaypoints ? (p as any).hasWaypoints() : '?',
                kills: this.kills,
                tick: World.currentTick
            });
        }
        if (this.startedAt === 0) {
            this.startedAt = World.currentTick;
        }
        if (World.currentTick - this.startedAt > this.MAX_TICKS) {
            return this.abort('timeout', { kills: this.kills });
        }
        if (p.levels[3] <= 0) {
            return this.abort('dead', { kills: this.kills });
        }

        // Tool gate: fail fast with the missing tool so the planner can act.
        if (this.src.tool) {
            const have = inventorySnapshot(bot);
            if (!have.some(i => i.name.toLowerCase().includes(this.src.tool!.toLowerCase()))) {
                return this.abort('need_tool', { tool: this.src.tool });
            }
        }

        // Already carrying it? Effect-verified done, no work needed.
        if (inventorySnapshot(bot).some(i => i.name.toLowerCase() === this.item)) {
            botLog.append('action', { action: 'gather_done', item: this.item, source: 'inventory' });
            return 'done';
        }

        if (!this.walked && this.src.area) {
            const w = this.walkToArea(bot);
            if (w === 'arrived') {
                this.walked = true;
                this.blockTicks = 0;
            } else if (w === 'blocked') {
                // transient: parked on a bad tile, pathing warm-up, gate cycle —
                // only give up after sustained blockage so the walker can recover
                this.blockTicks++;
                if (this.blockTicks > 45) {
                    return this.abort('walk_blocked', { to: `${this.src.area!.x},${this.src.area!.z}` });
                }
            } else {
                this.blockTicks = 0;
            }
            return 'running';
        }

        if (this.phase === Phase.FIGHT) {
            return this.fight(bot);
        }
        if (this.phase === Phase.PICKUP) {
            return this.pickup(bot);
        }
        return this.fight(bot);
    }

    /** Staged walk to the source area. Returns true once arrived (or blocked). */
    private walkToArea(bot: BotPlayer): 'arrived' | 'blocked' | 'walking' {
        const p = bot.player;
        const a = this.src.area!;
        const dist = Math.max(Math.abs(a.x - p.x), Math.abs(a.z - p.z));
        if (dist <= 3) {
            botLog.append('action', { action: 'gather_arrived', item: this.item, at: `${a.x},${a.z}` });
            return 'arrived';
        }
        if (!p.hasWaypoints()) {
            for (const seg of [50, 25, 12, 6]) {
                const s = Math.min(1, seg / dist);
                const hx = p.x + Math.round((a.x - p.x) * s);
                const hz = p.z + Math.round((a.z - p.z) * s);
                const r = bot.walkSegment(hx, hz);
                if (r.ok) {
                    this.lastPos = { x: p.x, z: p.z };
                    return 'walking';
                }
            }
            return 'blocked';
        }
        return 'walking';
    }

    private fight(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        const src = this.src;

        // 1) Ground drop NEARBY? Switch to pickup. (A far drop on the other
        //    side of a fence/castle must not hijack the hunt.)
        const drop = findTarget(bot, this.item, 'take', ['obj']);
        if (drop && Math.max(Math.abs(drop.x - p.x), Math.abs(drop.z - p.z)) <= this.DROP_SCAN_RANGE) {
            botLog.append('action', { action: 'gather_drop_seen', item: this.item, at: `${drop.x},${drop.z}` });
            this.target = drop;
            this.phase = Phase.PICKUP;
            return 'running';
        }

        // 2) Kills exhausted?
        if (this.kills >= (src.kills ?? 12)) {
            return this.abort('no_drop', { kills: this.kills });
        }

        // 3) Target liveness / re-find (count the kill when the held target dies)
        if (!this.target || !this.targetAlive()) {
            if (this.target) {
                this.kills++;
                botLog.append('action', { action: 'gather_kill', item: this.item, npc: this.target.name, kills: this.kills });
            }
            const t = findTarget(bot, src.query, src.op, [src.kind]);
            if (!t) {
                return this.abort('no_source', { query: src.query, kills: this.kills });
            }
            this.target = t;
            this.engagedAt = -1;
        }
        const t = this.target;
        const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));

        // 4) One target for ~3 min without a kill — give up and re-find
        //    (checked even while an interaction holds)
        if (this.engagedAt > 0 && World.currentTick - this.engagedAt > 300) {
            botLog.append('action', { action: 'approach_retry', why: 'no_kill', query: src.query });
            this.target = null;
            this.engagedAt = -1;
            return 'running';
        }

        // 5) Approach — also when the walk-line is blocked: a target at
        //    Chebyshev 1 across a fence/wall would otherwise sit in the fire
        //    path forever, attack-spamming into "I can't reach that!" (the
        //    2026-09-12 chicken-pen observation). Routing it through the
        //    approach also triggers walkSegment→door task to open a way.
        if (dist > 1 || !isLineOfWalk(p.level, p.x, p.z, t.x, t.z)) {
            p.clearInteraction();
            if (p.x === this.lastPos.x && p.z === this.lastPos.z) {
                this.idleTicks++;
                if (this.idleTicks > 40) {
                    this.target = null;
                    this.idleTicks = 0;
                    return 'running';
                }
            } else {
                this.idleTicks = 0;
                this.lastPos = { x: p.x, z: p.z };
            }
            if (!p.hasWaypoints()) {
                const cands: { x: number; z: number }[] = [{ x: t.x, z: t.z }];
                for (let ax = -1; ax <= 1; ax++) {
                    for (let az = -1; az <= 1; az++) {
                        if (ax === 0 && az === 0) continue;
                        cands.push({ x: t.x + ax, z: t.z + az });
                    }
                }
                for (const c of cands) {
                    if (bot.walkSegment(c.x, c.z).ok) return 'running';
                }
                this.target = null;
            }
            return 'running';
        }

        // 6) Fire the op. Attack path mirrors CombatTrainRoutine (re-fire on
        //    the swing timer vars[58], run the [opnpcN] script directly to
        //    start the melee loop). Non-attack ops (pickpocket, chop, take, ...)
        //    re-fire on a cooldown until the item lands — the effect check
        //    below IS the loop terminator.
        const isAttack = String(t.opName ?? '')
            .toLowerCase()
            .includes('attack');
        if (isAttack && !isLineOfWalk(p.level, p.x, p.z, t.x, t.z)) {
            // unreachable from here — retarget; the approach path above owns
            // opening a way through (door task)
            this.target = null;
            return 'running';
        }
        if (isAttack) {
            const ready = World.currentTick >= p.vars[58];
            if (!p.hasInteraction() || ready) {
                p.clearWaypoints();
                const trigger = this.triggerFor(t);
                if (p.setInteraction(Interaction.ENGINE, t.entity() as any, trigger)) {
                    p.opcalled = true;
                    this.engagedAt = World.currentTick;
                    botLog.append('action', { action: 'gather_interact', item: this.item, target: t.name, op: t.opName });
                    const npc = t.entity() as any;
                    const opScript = ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1 + (t.opIndex - 1), NpcType.get(npc.type).id, NpcType.get(npc.type).category);
                    if (opScript) {
                        p.runScript(ScriptRunner.init(opScript, p, npc), true);
                    }
                }
            }
        } else {
            // non-attack op: fire once per cooldown (~6s), no interaction wait —
            // the engine executes the op; effect shows up as inventory/message
            if (World.currentTick - this.lastFireTick > 10) {
                if (!p.hasInteraction()) {
                    p.clearWaypoints();
                    const trigger = this.triggerFor(t);
                    if (p.setInteraction(Interaction.ENGINE, t.entity() as any, trigger)) {
                        p.opcalled = true;
                        this.engagedAt = World.currentTick;
                        this.lastFireTick = World.currentTick;
                        botLog.append('action', { action: 'gather_interact', item: this.item, target: t.name, op: t.opName });
                    }
                }
            }
        }
        if (this.stepWait(bot)) {
            botLog.append('action', { action: 'gather_done', item: this.item, source: 'interact' });
            return 'done';
        }
        return 'running';
    }

    /** Effect check: is the gathered item in the inventory now? */
    private stepWait(bot: BotPlayer): boolean {
        return inventorySnapshot(bot).some(i => i.name.toLowerCase().includes(this.item));
    }

    private pickup(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        const t = this.target;
        if (!t) {
            this.phase = Phase.FIGHT;
            return 'running';
        }
        // Still there? (may have despawned)
        const obj = (t as any).entity?.();
        if (!obj || !World.getObj(t.x, t.z, t.level, (obj as any).type, p.hash64)) {
            this.target = null;
            this.phase = Phase.FIGHT; // despawned — keep hunting
            return 'running';
        }
        const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
        if (dist > 1) {
            if (!p.hasWaypoints()) {
                for (let ax = -1; ax <= 1; ax++) {
                    for (let az = -1; az <= 1; az++) {
                        const r = bot.walkSegment(t.x + ax, t.z + az);
                        if (r.ok) return 'running';
                    }
                }
                this.target = null;
                this.phase = Phase.FIGHT;
            }
            return 'running';
        }
        p.clearWaypoints();
        const trigger = ServerTriggerType.APOBJ1 + ((typeof t.opIndex === 'number' ? t.opIndex : 1) - 1);
        if (p.setInteraction(Interaction.ENGINE, obj as any, trigger)) {
            p.opcalled = true;
            botLog.append('action', { action: 'gather_pickup', item: this.item, at: `${t.x},${t.z}` });
        }
        if (inventorySnapshot(bot).some(i => i.name.toLowerCase() === this.item)) {
            botLog.append('action', { action: 'gather_done', item: this.item, source: 'pickup' });
            return 'done';
        }
        return 'running';
    }

    private targetAlive(): boolean {
        const t = this.target!;
        if (t.kind === 'npc') {
            const npc = t.entity() as any;
            return !!World.getNpc(npc.nid) && npc.levels[3] > 0;
        }
        if (t.kind === 'loc') {
            const loc = t.entity() as any;
            return !!World.getLoc(t.x, t.z, t.level, loc.type);
        }
        return true;
    }

    private triggerFor(t: InteractTarget): ServerTriggerType {
        switch (t.kind) {
            case 'npc':
                return ServerTriggerType.APNPC1 + (t.opIndex - 1);
            case 'loc':
                return ServerTriggerType.APLOC1 + (t.opIndex - 1);
            case 'obj':
                return ServerTriggerType.APOBJ1 + (t.opIndex - 1);
        }
    }
}
