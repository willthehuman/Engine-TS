// Pepe bot — "use item on target" primitive (OpHeldU / OpLocU / OpNpcU / OpObjU
// client paths, driven server-side). This is the processing-skill unlock:
// raw meat → range = Cooking, logs + tinderbox = Firemaking, bones → bury, etc.
//
// Paths mirrored exactly from the network handlers:
//   item on item:  OPHELDU script chain (b / a / b_category / a_category)
//   item on loc:   setInteraction(ENGINE, loc, APLOCU) with lastUseItem set
//   item on npc:   setInteraction(ENGINE, npc, APNPCU) with lastUseItem set
//   item on obj:   setInteraction(ENGINE, obj, APOBJU) with lastUseItem set
// All of them require the held item slot + the backpack component to be set up
// the way the real handler does (lastItem/lastSlot/lastUseItem/lastUseSlot).

import CategoryType from '#/cache/config/CategoryType.js';
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import World from '#/engine/World.js';
import Entity from '#/engine/entity/Entity.js';
import { findTarget } from './interact.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine, RoutineStatus } from './routines.js';

function findInInventory(bot: BotPlayer, item: string): { slot: number; objId: number; name: string } | null {
    const inv = bot.player.invs.get(InvType.INV);
    if (!inv) {
        return null;
    }
    const q = item.trim().toLowerCase();
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (!it) continue;
        const ot = ObjType.get(it.id);
        const n = (ot?.name ?? ot?.debugname ?? '').toLowerCase();
        if (n.includes(q)) {
            return { slot, objId: it.id, name: ot?.name ?? ot.debugname ?? String(it.id) };
        }
    }
    return null;
}

export function inventorySnapshot(bot: BotPlayer): { slot: number; id: number; name: string; qty: number }[] {
    const inv = bot.player.invs.get(InvType.INV);
    if (!inv) {
        return [];
    }
    const rows: { slot: number; id: number; name: string; qty: number }[] = [];
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (!it) continue;
        const ot = ObjType.get(it.id);
        rows.push({ slot, id: it.id, name: ot?.name ?? ot?.debugname ?? String(it.id), qty: it.count });
    }
    return rows;
}

type UseTargetKind = 'item' | 'loc' | 'npc' | 'obj';

/**
 * UseItemRoutine: use the first inventory item matching `item` on a target —
 * another inventory item (by name), or the nearest world entity (loc/npc/obj
 * by name). Walks any distance (staged), then fires the real op path.
 */
export class UseItemRoutine implements Routine {
    private itemName: string;
    private targetKind: UseTargetKind;
    private targetName: string;
    private phase: 'FIND' | 'APPROACH' | 'FIRE' | 'DONE' = 'FIND';
    private firedAt = -1;
    private lastX = -1;
    private lastZ = -1;
    private stuckTicks = 0;
    private worldTarget: { x: number; z: number; level: number; entity: () => Entity; kind: 'loc' | 'npc' | 'obj' } | null = null;

    constructor(item: string, targetKind: UseTargetKind, targetName: string) {
        this.itemName = item;
        this.targetKind = targetKind;
        this.targetName = targetName;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;

        switch (this.phase) {
            case 'FIND': {
                const held = findInInventory(bot, this.itemName);
                if (!held) {
                    botLog.append('reflex', { kind: 'use_no_item', item: this.itemName });
                    return 'aborted';
                }
                if (this.targetKind === 'item') {
                    const target = findInInventory(bot, this.targetName);
                    if (!target || target.slot === held.slot) {
                        botLog.append('reflex', { kind: 'use_no_target_item', item: this.targetName });
                        return 'aborted';
                    }
                    this.fireItemOnItem(bot, held, target);
                    return 'done'; // instant, no walking
                }
                // world target: nearest loc/npc/obj by name (any op — U-trigger needs no op index)
                const t = findTarget(bot, this.targetName, 1, [this.targetKind]);
                if (!t) {
                    botLog.append('reflex', { kind: 'use_no_target', target: this.targetName });
                    return 'aborted';
                }
                this.worldTarget = { x: t.x, z: t.z, level: t.level, entity: t.entity, kind: this.targetKind };
                this.stuckTicks = 0;
                this.lastX = -1;
                this.lastZ = -1;
                this.phase = 'APPROACH';
                return 'running';
            }
            case 'APPROACH': {
                const t = this.worldTarget!;
                const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
                if (dist <= 1) {
                    this.phase = 'FIRE';
                    return 'running';
                }
                if (p.hasInteraction()) {
                    p.clearInteraction();
                }
                if (p.x === this.lastX && p.z === this.lastZ) {
                    this.stuckTicks++;
                    if (this.stuckTicks >= 50) {
                        this.phase = 'FIND';
                        return 'running';
                    }
                } else {
                    this.stuckTicks = 0;
                    this.lastX = p.x;
                    this.lastZ = p.z;
                }
                if (!p.hasWaypoints()) {
                    let tx = t.x;
                    let tz = t.z;
                    if (dist > 50) {
                        const scale = 50 / dist;
                        tx = p.x + Math.round((t.x - p.x) * scale);
                        tz = p.z + Math.round((t.z - p.z) * scale);
                    }
                    if (!bot.walkSegment(tx, tz).ok) {
                        let hopped = false;
                        for (const seg of [25, 12, 6]) {
                            const s = Math.min(1, seg / dist);
                            const hx = p.x + Math.round((t.x - p.x) * s);
                            const hz = p.z + Math.round((t.z - p.z) * s);
                            if (bot.walkSegment(hx, hz).ok) {
                                hopped = true;
                                break;
                            }
                        }
                        if (!hopped) {
                            this.phase = 'FIND';
                        }
                    }
                }
                return 'running';
            }
            case 'FIRE': {
                const held = findInInventory(bot, this.itemName);
                if (!held) {
                    return 'aborted'; // ran out mid-walk
                }
                const t = this.worldTarget!;
                const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
                if (dist > 1) {
                    this.phase = 'APPROACH';
                    return 'running';
                }
                p.clearWaypoints();
                // the real handler contract for U-op interactions
                p.lastUseItem = held.objId;
                p.lastUseSlot = held.slot;
                const trigger = this.worldTarget!.kind === 'loc' ? ServerTriggerType.APLOCU : this.worldTarget!.kind === 'npc' ? ServerTriggerType.APNPCU : ServerTriggerType.APOBJU;
                const ok = p.setInteraction(Interaction.ENGINE, t.entity(), trigger);
                if (ok) {
                    p.opcalled = true;
                    this.firedAt = World.currentTick;
                    botLog.append('action', { action: 'use_item', item: held.name, on: this.targetName, kind: t.kind });
                    if (World.currentTick - this.firedAt > 4) {
                        return 'done';
                    }
                    return 'running';
                }
                this.phase = 'FIND';
                return 'running';
            }
            case 'DONE':
                return 'done';
        }
    }

    /** item-on-item: mirrors OpHeldUHandler's script resolution chain exactly. */
    private fireItemOnItem(bot: BotPlayer, held: { slot: number; objId: number; name: string }, target: { slot: number; objId: number; name: string }): void {
        const p = bot.player;
        p.lastItem = held.objId;
        p.lastSlot = held.slot;
        p.lastUseItem = target.objId;
        p.lastUseSlot = target.slot;

        const objType = ObjType.get(held.objId);
        const useObjType = ObjType.get(target.objId);
        p.clearPendingAction();

        // [opheldu,b] → [opheldu,a] → [opheldu,b_category] → [opheldu,a_category]
        let script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, objType.id, -1);
        if (!script) {
            script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, useObjType.id, -1);
            if (script) {
                [p.lastItem, p.lastUseItem] = [p.lastUseItem, p.lastItem];
                [p.lastSlot, p.lastUseSlot] = [p.lastUseSlot, p.lastSlot];
            }
        }
        if (!script) {
            const objCategory = objType.category !== -1 ? CategoryType.get(objType.category) : null;
            if (objCategory) {
                script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, objCategory.id);
            }
        }
        if (!script) {
            if (useObjType.category !== -1) {
                const useObjCategory = CategoryType.get(useObjType.category);
                script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.OPHELDU, -1, useObjCategory.id);
                if (script) {
                    [p.lastItem, p.lastUseItem] = [p.lastUseItem, p.lastItem];
                    [p.lastSlot, p.lastUseSlot] = [p.lastUseSlot, p.lastSlot];
                }
            }
        }

        if (script) {
            p.executeScript(ScriptRunner.init(script, p), true);
            botLog.append('action', { action: 'use_item', item: held.name, on: target.name, kind: 'item' });
        } else {
            botLog.append('reflex', { kind: 'use_no_script', item: held.name, on: target.name });
        }
    }
}

/** Fire a held-item op (iop: Bury / Eat / Drop / Light ...) on the first matching
 *  inventory item — mirrors OpHeldHandler exactly. Returns false when not found. */
export function itemOp(bot: BotPlayer, item: string, op: string): { ok: boolean; reason?: string; item?: string; op?: string } {
    const p = bot.player;
    const held = findInInventory(bot, item);
    if (!held) {
        return { ok: false, reason: 'no_item' };
    }
    const ot = ObjType.get(held.objId);
    const q = op.trim().toLowerCase();
    const idx = (ot.iop ?? []).findIndex(o => (o ?? '').toLowerCase() === q || (o ?? '').toLowerCase().includes(q));
    if (idx < 0) {
        return { ok: false, reason: 'no_op', item: held.name };
    }
    p.lastItem = held.objId;
    p.lastSlot = held.slot;
    const script = ScriptProvider.getByTrigger(ServerTriggerType.OPHELD1 + idx, ot.id, ot.category);
    if (!script) {
        return { ok: false, reason: 'no_script', item: held.name };
    }
    p.executeScript(ScriptRunner.init(script, p), true, true); // force: heal/bury must not be swallowed by delays
    const opName: string = ot.iop![idx] ?? op;
    botLog.append('action', { action: 'item_op', item: held.name, op: opName });
    return { ok: true, item: held.name, op: opName };
}

/** Routine wrapper: fire a held-item op instantly (no walking). */
export class ItemOpRoutine implements Routine {
    private item: string;
    private op: string;
    private waited = 0;
    private readonly MAX_WAIT = 40; // ~24s for a preceding take to land

    constructor(item: string, op: string) {
        this.item = item;
        this.op = op;
    }

    step(bot: BotPlayer): RoutineStatus {
        const res = itemOp(bot, this.item, this.op);
        if (res.ok) {
            return 'done';
        }
        if (res.reason === 'no_item' && ++this.waited < this.MAX_WAIT) {
            return 'running'; // item en route (e.g. a take finishing) — wait for it
        }
        botLog.append('reflex', { kind: 'item_op_failed', item: this.item, op: this.op, reason: res.reason ?? 'unknown' });
        return 'aborted';
    }
}
