// Pepe bot — combat training (defence-first). Deterministic executor: find target,
// approach, attack, monitor, repeat. No LLM in here.
//
// How it hooks into real combat:
//  - Attack = the NPC's 'Attack' op, engaged exactly like a client click:
//    setInteraction(ENGINE, npc, APNPC<op>) + opcalled. Content's [apnpc2,_]
//    wildcard starts the melee loop, which self-sustains via p_opnpc(2).
//  - Combat style: executing the style button's if_button script (~set_attackstyle)
//    updates %com_mode through content code, so XP lands where it should.
//  - Defence XP is reported as a stats delta to prove the style stuck.

import Component from '#/cache/config/Component.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import World from '#/engine/World.js';
import Npc from '#/engine/entity/Npc.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';
import { WalkRoutine, type Routine, type RoutineStatus } from './routines.js';

const WEAPON_SLOT = 3; // worn: right hand
const LUMBRIDGE_SAFE = { x: 3222, z: 3216 }; // castle courtyard

function wornWeaponName(bot: BotPlayer): string {
    const worn = bot.player.invs.get(InvType.WORN);
    if (!worn) {
        return '';
    }
    const item = worn.get(WEAPON_SLOT);
    if (!item) {
        return '';
    }
    return (ObjType.get(item.id)?.name ?? '').toLowerCase();
}

/** Defensive-style component name for the equipped weapon (content interface names). */
function defensiveComponentFor(bot: BotPlayer): string {
    const n = wornWeaponName(bot);
    if (!n) return 'combat_unarmed:unarmed2';
    if (/2h|two-handed|godsword/.test(n)) return 'combat_heavysword:heavy3';
    if (/pickaxe/.test(n)) return 'combat_pickaxe:pickaxe3';
    if (/battleaxe|axe|hatchet/.test(n)) return 'combat_axe:axe3';
    if (/spear|halberd/.test(n)) return 'combat_spear:spear3';
    if (/staff|wand/.test(n)) return 'combat_staff_2:staff2c';
    if (/mace|warhammer|hammer|club/.test(n)) return 'combat_blunt:blunt2';
    if (/dagger|rapier|claw/.test(n)) return 'combat_stabsword:stab3';
    if (/sword|scimitar|longsword/.test(n)) return 'combat_hacksword:hack3';
    return 'combat_unarmed:unarmed2';
}

/** Execute the style button's if_button script — the exact path a client click runs. */
export function setCombatStyleDefensive(bot: BotPlayer): { ok: boolean; component?: string } {
    const name = defensiveComponentFor(bot);
    const comId = Component.getId(name);
    if (comId === -1) {
        botLog.append('error', { where: 'setCombatStyle', reason: 'no_component', name });
        return { ok: false };
    }
    const script = ScriptProvider.getByTriggerSpecific(ServerTriggerType.IF_BUTTON, comId, -1);
    if (!script) {
        botLog.append('error', { where: 'setCombatStyle', reason: 'no_script', name });
        return { ok: false };
    }
    bot.player.executeScript(ScriptRunner.init(script, bot.player), true);
    botLog.append('action', { action: 'combat_style', style: 'defensive', component: name });
    return { ok: true, component: name };
}

/** Find an 'Eat' option in the backpack; execute its opheld trigger. */
export function eatSomething(bot: BotPlayer): { ok: boolean; item?: string } {
    const inv = bot.player.invs.get(InvType.INV);
    if (!inv) {
        return { ok: false };
    }
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        const obj = ObjType.get(item.id);
        const idx = (obj?.iop ?? []).findIndex(op => (op ?? '').toLowerCase() === 'eat');
        if (idx < 0) continue;
        bot.player.lastItem = item.id;
        bot.player.lastSlot = slot;
        const script = ScriptProvider.getByTrigger(ServerTriggerType.OPHELD1 + idx, obj.id, obj.category);
        if (script) {
            // force: combat delays must not silently swallow the heal (runScript
            // returns -1 when protect && delayed — a starving Pepe would retreat)
            bot.player.executeScript(ScriptRunner.init(script, bot.player), true, true);
            botLog.append('action', { action: 'eat', item: obj.debugname });
            return { ok: true, item: obj.name ?? obj.debugname ?? undefined };
        }
    }
    return { ok: false };
}

/** Find the 'Attack' op index on an NPC type (1-based op number), or -1. */
function attackOpIndex(npc: Npc): number {
    const t = NpcType.get(npc.type);
    if (!t?.op) return -1;
    for (let i = 0; i < t.op.length; i++) {
        if ((t.op[i] ?? '').toLowerCase() === 'attack') {
            return i + 1;
        }
    }
    return -1;
}

enum Phase {
    SETUP,
    FIND,
    APPROACH,
    FIGHT,
    DONE
}

/**
 * Train on a nearby NPC type, defence-first. Params: npc name (e.g. "chicken"),
 * max kills (0 = endless until stopped), radius.
 */
export class CombatTrainRoutine implements Routine {
    private npcName: string;
    private maxKills: number;
    private radius: number;
    private phase: Phase = Phase.SETUP;
    private npc: Npc | null = null;
    private attackOp = -1;
    private kills = 0;
    private startDefXp = 0;
    private startHpXp = 0;
    private startPrayerXp = 0;
    private lastX = -1;
    private lastZ = -1;
    private stuckTicks = 0;
    private attackIssuedAt = -1;
    private lastEatAt = -1000;
    private reported = false;
    private attackLogged = false;
    private engagedAt = -1;

    constructor(npcName: string, maxKills = 0, radius = 30) {
        this.npcName = npcName.toLowerCase().trim();
        this.maxKills = maxKills;
        this.radius = Math.max(5, Math.min(60, radius));
    }

    private report(bot: BotPlayer, reason: string): void {
        if (this.reported) {
            return;
        }
        this.reported = true;
        const p = bot.player;
        botLog.append('action', {
            action: 'train_done',
            target: this.npcName,
            reason,
            kills: this.kills,
            defence_xp: p.stats[PlayerStat.DEFENCE] - this.startDefXp,
            hitpoints_xp: p.stats[PlayerStat.HITPOINTS] - this.startHpXp,
            prayer_xp: p.stats[PlayerStat.PRAYER] - this.startPrayerXp,
            hp: `${p.levels[PlayerStat.HITPOINTS]}/${p.baseLevels[PlayerStat.HITPOINTS]}`
        });
    }

    /** Safety tier: runs before anything else. Returns true when the routine must stop. */
    private safety(bot: BotPlayer): boolean {
        const p = bot.player;
        const hp = p.levels[PlayerStat.HITPOINTS];
        const base = p.baseLevels[PlayerStat.HITPOINTS];
        if (hp <= 0) {
            this.report(bot, 'died');
            return true;
        }
        if (hp <= Math.max(2, Math.floor(base * 0.35))) {
            if (World.currentTick - this.lastEatAt > 3) {
                const ate = eatSomething(bot);
                this.lastEatAt = World.currentTick;
                if (!ate.ok) {
                    // no food: retreat to Lumbridge and stop
                    botLog.append('reflex', { kind: 'train_retreat', hp: `${hp}/${base}` });
                    bot.clearRoutines();
                    bot.enqueue(new WalkRoutine(LUMBRIDGE_SAFE.x, LUMBRIDGE_SAFE.z));
                    this.report(bot, 'retreat_low_hp');
                    return true;
                }
            }
        }
        return false;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;

        if (this.safety(bot)) {
            return 'done';
        }

        switch (this.phase) {
            case Phase.SETUP: {
                this.startDefXp = p.stats[PlayerStat.DEFENCE];
                this.startHpXp = p.stats[PlayerStat.HITPOINTS];
                this.startPrayerXp = p.stats[PlayerStat.PRAYER];
                const res = setCombatStyleDefensive(bot);
                if (!res.ok) {
                    this.report(bot, 'style_failed');
                    return 'aborted';
                }
                this.phase = Phase.FIND;
                return 'running';
            }
            case Phase.FIND: {
                if (this.maxKills > 0 && this.kills >= this.maxKills) {
                    this.report(bot, 'kills_reached');
                    this.phase = Phase.DONE;
                    return 'done';
                }
                const needle = this.npcName;
                let best: Npc | null = null;
                let bestDist = Infinity;
                for (const npc of World.npcs) {
                    const t = NpcType.get(npc.type);
                    const nm = (t?.name ?? '').toLowerCase();
                    if (!nm.includes(needle)) continue;
                    if (npc.level !== p.level) continue;
                    if (npc.levels[3] <= 0) continue; // corpse: never target the dying
                    const dist = Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z));
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = npc;
                    }
                }
                if (!best) {
                    botLog.append('reflex', { kind: 'train_no_target', npc: this.npcName });
                    this.report(bot, 'no_target');
                    return 'aborted';
                }
                if (bestDist > this.radius) {
                    // target exists but far away: hop toward it, re-find next step
                    if (!p.hasWaypoints()) {
                        const scale = 50 / bestDist;
                        const tx = p.x + Math.round((best.x - p.x) * scale);
                        const tz = p.z + Math.round((best.z - p.z) * scale);
                        if (!bot.walkSegment(tx, tz).ok) {
                            // straight-line hop blocked: shorter hops before giving up
                            let hopped = false;
                            for (const seg of [25, 12, 6]) {
                                const s = Math.min(1, seg / bestDist);
                                const hx = p.x + Math.round((best.x - p.x) * s);
                                const hz = p.z + Math.round((best.z - p.z) * s);
                                if (bot.walkSegment(hx, hz).ok) {
                                    hopped = true;
                                    break;
                                }
                            }
                            if (!hopped) {
                                this.report(bot, 'no_path');
                                return 'aborted';
                            }
                        }
                    }
                    return 'running';
                }
                const opIdx = attackOpIndex(best);
                if (opIdx < 0) {
                    botLog.append('reflex', { kind: 'train_not_attackable', npc: this.npcName, op: opIdx });
                    this.report(bot, 'not_attackable');
                    return 'aborted';
                }
                this.npc = best;
                this.attackOp = opIdx;
                this.attackLogged = false;
                this.engagedAt = -1;
                this.stuckTicks = 0;
                this.lastX = -1;
                this.lastZ = -1;
                this.phase = Phase.APPROACH;
                return 'running';
            }
            case Phase.APPROACH: {
                const npc = this.npc;
                if (!npc || !World.getNpc(npc.nid)) {
                    this.phase = Phase.FIND;
                    return 'running';
                }
                const dist = Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z));
                if (dist <= 1) {
                    this.phase = Phase.FIGHT;
                    return 'running';
                }
                // drop the interaction while closing the gap: the engine's approach
                // walking is naive (clientRoutefinder) and ping-pongs on crowded
                // terrain — our own pathing is smart, so it does the walking.
                if (p.hasInteraction()) {
                    p.clearInteraction();
                    p.clearWaypoints();
                }
                // stuck detection while walking
                if (p.x === this.lastX && p.z === this.lastZ) {
                    this.stuckTicks++;
                    if (this.stuckTicks >= 50) {
                        // target may have wandered somewhere unreachable; re-find
                        this.phase = Phase.FIND;
                        return 'running';
                    }
                } else {
                    this.stuckTicks = 0;
                    this.lastX = p.x;
                    this.lastZ = p.z;
                }
                if (!p.hasWaypoints()) {
                    // walk toward the target's own tile: the final step is blocked by
                    // the npc itself, which parks us adjacent — and unlike the engine's
                    // naive interaction-walking (clientRoutefinder), our path is smart.
                    let tx = npc.x;
                    let tz = npc.z;
                    if (dist > 50) {
                        const scale = 50 / dist;
                        tx = p.x + Math.round((npc.x - p.x) * scale);
                        tz = p.z + Math.round((npc.z - p.z) * scale);
                    }
                    const res = bot.walkSegment(tx, tz);
                    if (!res.ok) {
                        this.phase = Phase.FIND;
                    }
                }
                return 'running';
            }
            case Phase.FIGHT: {
                const npc = this.npc;
                if (!npc) {
                    this.phase = Phase.FIND;
                    return 'running';
                }
                if (npc.levels[3] <= 0 || !World.getNpc(npc.nid)) {
                    // target died (hp hit 0) or despawned → count it, next
                    this.kills++;
                    this.attackIssuedAt = -1;
                    botLog.append('action', { action: 'kill', npc: this.npcName, kills: this.kills });
                    this.phase = Phase.FIND;
                    return 'running';
                }
                const dist = Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z));
                if (dist > 1) {
                    // strays away → chase again (smart walk to its tile)
                    this.attackIssuedAt = -1;
                    this.phase = Phase.APPROACH;
                    return 'running';
                }
                // Adjacent: drive the swing loop ourselves. The op trigger
                // ([opnpc2,_] -> player_combat_start) is fired directly whenever the
                // content's own %action_delay (var 58) says a swing is due; firing
                // early just re-arms via p_opnpc(2) inside the content, so this is
                // self-pacing and needs no engine branch luck.
                const ready = World.currentTick >= p.vars[58];
                if (!p.hasInteraction() || ready) {
                    p.clearWaypoints();
                    const ok = p.setInteraction(Interaction.ENGINE, npc, ServerTriggerType.APNPC1 + (this.attackOp - 1));
                    if (ok) {
                        p.opcalled = true;
                        this.attackIssuedAt = World.currentTick;
                        if (!this.attackLogged) {
                            this.attackLogged = true;
                            this.engagedAt = World.currentTick;
                            botLog.append('action', { action: 'attack', npc: this.npcName });
                        }
                        const opScript = ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1 + (this.attackOp - 1), NpcType.get(npc.type).id, NpcType.get(npc.type).category);
                        if (opScript) {
                            p.runScript(ScriptRunner.init(opScript, p, npc), true);
                        }
                    } else {
                        this.phase = Phase.FIND;
                    }
                }
                if (this.engagedAt > 0 && World.currentTick - this.engagedAt > 300) {
                    // ~3 minutes on one target without a kill — give up on it
                    this.phase = Phase.FIND;
                    this.engagedAt = -1;
                }
                return 'running';
            }
            case Phase.DONE:
                return 'done';
        }
    }
}
