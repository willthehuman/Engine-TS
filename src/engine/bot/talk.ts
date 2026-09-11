// Pepe bot — TalkRoutine: walk to the nearest NPC matching a name, talk to it,
// and click through the dialogue. The engine drives the walking (setInteraction
// → pathToPathingTarget → apTrigger fires when in range), so this routine only
// manages: target selection, interaction setup, and option/continue clicking.
//
// Option picking: deterministic first-resumeButton default (mirrors the client's
// IfButton click path). Cap + pace make loops impossible.

import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import ScriptState from '#/engine/script/ScriptState.js';
import World from '#/engine/World.js';
import Npc from '#/engine/entity/Npc.js';
import NpcType from '#/cache/config/NpcType.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine } from './routines.js';
import { currentDialog, wasUnreachable, clearDialogFlags, requestDialogChoice, consumeDialogChoice, clearDialogChoice } from './dialog.js';
import { soulRoutingEnabled, forwardDialogNotice, noticesMuted } from './webhook.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import { findPath } from '#/engine/GameMap.js';

enum Phase {
    FIND,
    APPROACH,
    TALK,
    DIALOG,
    DONE
}

/**
 * Path to stand adjacent to (tx,tz): tries the tile itself, then neighbors by
 * closeness to the walker. NPC/object tiles are often collision-blocked while
 * a neighbor works fine. Returns the waypoint path or null.
 */
export function standPath(level: number, fx: number, fz: number, tx: number, tz: number): number[] | null {
    const direct = findPath(level, fx, fz, tx, tz);
    if (direct.length > 0) {
        return Array.from(direct);
    }
    const nbs: { x: number; z: number; d: number }[] = [];
    for (let ax = -1; ax <= 1; ax++) {
        for (let az = -1; az <= 1; az++) {
            if (ax === 0 && az === 0) continue;
            nbs.push({ x: tx + ax, z: tz + az, d: Math.max(Math.abs(fx - (tx + ax)), Math.abs(fz - (tz + az))) });
        }
    }
    nbs.sort((a, b) => a.d - b.d);
    for (const n of nbs) {
        const path = findPath(level, fx, fz, n.x, n.z);
        if (path.length > 0) {
            return Array.from(path);
        }
    }
    return null;
}

export class TalkRoutine implements Routine {
    private npcName: string;
    private phase: Phase = Phase.FIND;
    private npc: Npc | null = null;
    private timeoutTick = 0;
    private lastOptionTick = -100;
    private optionsPicked = 0;
    private sawDialog = false;
    private talkedAtTick = 0;
    private lastApproachX = -1;
    private lastApproachZ = -1;
    private approachStuck = 0;
    private lastNpcX = -1;
    private lastNpcZ = -1;
    private lastRepathTick = -1000;
    private choiceAskedAt = -1000;
    private talkRetries = 0;
    private lastPickSig = '';
    private pickRepeat = 0;
    private readonly MAX_OPTIONS = 12; // hard cap: never loop a dialog forever

    constructor(name: string) {
        this.npcName = name;
    }

    step(bot: BotPlayer): 'running' | 'done' | 'aborted' {
        const p = bot.player;
        if (this.phase !== Phase.DIALOG) {
            clearDialogChoice(); // stale soul picks must not leak across phases
        }
        if (this.timeoutTick === 0) {
            this.timeoutTick = World.currentTick + 1000; // ~10 min hard cap
            clearDialogFlags();
        }
        if (World.currentTick > this.timeoutTick) {
            botLog.append('reflex', { kind: 'talk_timeout', npc: this.npcName });
            return 'aborted';
        }

        switch (this.phase) {
            case Phase.FIND: {
                // candidates: name match, same level, within RANGE tiles, sorted by distance
                const needle = this.npcName.toLowerCase();
                const RANGE = 40;
                const candidates: { npc: Npc; dist: number }[] = [];
                for (const npc of World.npcs) {
                    const nt = NpcType.get(npc.type);
                    const nm = (nt?.name ?? '').toLowerCase();
                    if (!nm.includes(needle)) {
                        continue;
                    }
                    if (npc.level !== p.level) {
                        continue;
                    }
                    if (npc.levels[3] <= 0) {
                        continue; // corpse: never talk to the dying
                    }
                    const dx = npc.x - p.x;
                    const dz = npc.z - p.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist > RANGE) {
                        continue;
                    }
                    candidates.push({ npc, dist });
                }
                candidates.sort((a, b) => a.dist - b.dist);

                // pick the nearest candidate we can actually stand next to (path
                // test to the npc tile OR an adjacent tile — npc tiles are often
                // collision-blocked, and talking works fine from adjacent)
                let best: Npc | null = null;
                for (const c of candidates) {
                    if (standPath(p.level, p.x, p.z, c.npc.x, c.npc.z) !== null) {
                        best = c.npc;
                        break;
                    }
                }
                if (!best) {
                    botLog.append('reflex', { kind: 'npc_not_found', npc: this.npcName, candidates: candidates.length });
                    return 'aborted';
                }
                this.npc = best;
                this.phase = Phase.APPROACH;
                return 'running';
            }
            case Phase.APPROACH: {
                const npc = this.npc!;
                // NPC despawned?
                if (!World.getNpc(npc.nid)) {
                    botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'despawned' });
                    return 'aborted';
                }
                const dx = npc.x - p.x;
                const dz = npc.z - p.z;
                // chebyshev near-adjacency: the op trigger is fired directly (not
                // via engine approach), so ≤2 is enough — content gates the rest.
                // (Pacing NPCs like Cook never stand still for a ≤1 handoff.)
                if (Math.max(Math.abs(dx), Math.abs(dz)) <= 2) {
                    this.phase = Phase.TALK;
                    return 'running';
                }
                // walk with the SMART pathfinder (the engine's naive pathToPathingTarget
                // stalls on obstacles; we only set the interaction once genuinely close).
                // Re-path ONLY on exhausted waypoints: re-queueing every NPC step
                // resets movement progress and makes Pepe crawl behind pacing NPCs.
                // A slow refresh (20 ticks) covers genuine relocation.
                if (!p.hasWaypoints() || World.currentTick - this.lastRepathTick > 20) {
                    const path = standPath(p.level, p.x, p.z, npc.x, npc.z);
                    if (!path) {
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'no_path' });
                        return 'aborted';
                    }
                    p.queueWaypoints(path);
                    this.lastNpcX = npc.x;
                    this.lastNpcZ = npc.z;
                    this.lastRepathTick = World.currentTick;
                }
                // stuck detection: same tile while walking for 30s → abort
                if (p.x === this.lastApproachX && p.z === this.lastApproachZ) {
                    this.approachStuck++;
                    if (this.approachStuck >= 50) {
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'approach_stuck' });
                        return 'aborted';
                    }
                } else {
                    this.approachStuck = 0;
                    this.lastApproachX = p.x;
                    this.lastApproachZ = p.z;
                }
                return 'running';
            }
            case Phase.TALK: {
                const npc = this.npc!;
                // dismiss any pre-existing overlay (e.g. the tutorial "Getting started"
                // screen) — it sets a MAIN modal that makes canAccess() false and
                // blocks both auto-walking and interactions entirely.
                if (p.containsModalInterface()) {
                    p.closeModal();
                    botLog.append('action', { action: 'dismiss_overlay' });
                    return 'running'; // let the close settle one tick
                }
                // engine-set interaction: pathToPathingTarget walks Pepe over,
                // the APNPC1 approach trigger fires the talk script in range.
                const ok = p.setInteraction(Interaction.ENGINE, npc, ServerTriggerType.APNPC1);
                if (!ok) {
                    // target transiently invalid (usually npc delayed) — retry a
                    // while before giving up, and say so out loud
                    this.talkRetries = (this.talkRetries ?? 0) + 1;
                    if (this.talkRetries > 40) {
                        // ~24s
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'target_invalid' });
                        return 'aborted';
                    }
                    return 'running';
                }
                this.talkRetries = 0;
                p.opcalled = true;
                p.clearWaypoints(); // adjacent already — make the engine try the trigger in place, not wander
                // Fire the op trigger directly (same mechanism as combat): the engine's
                // naive approach-walk stalls on counters and pacing NPCs drift out of
                // reach between ticks. Content gates everything itself.
                const opScript = ScriptProvider.getByTrigger(ServerTriggerType.OPNPC1, NpcType.get(npc.type).id, NpcType.get(npc.type).category);
                if (opScript) {
                    // executeScript (not runScript): a suspending dialog must attach
                    // as activeScript or DIALOG can never resume it
                    p.executeScript(ScriptRunner.init(opScript, p, npc), true);
                    botLog.append('action', { action: 'talk_fire', npc: this.npcName, dist: Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z)) });
                } else {
                    botLog.append('action', { action: 'talk_fire', npc: this.npcName, st: 'no_script' });
                }
                this.phase = Phase.DIALOG;
                this.lastOptionTick = World.currentTick;
                this.talkedAtTick = World.currentTick;
                botLog.append('action', { action: 'talk_to', npc: this.npcName });
                this.lastPickSig = '';
                this.pickRepeat = 0;
                return 'running';
            }
            case Phase.DIALOG: {
                const paused = p.activeScript?.execution === ScriptState.PAUSEBUTTON || p.activeScript?.execution === ScriptState.COUNTDIALOG;
                const modal = p.containsModalInterface() || paused;

                if (!modal) {
                    if (this.sawDialog || this.optionsPicked > 0) {
                        bot.saveNow(); // persist progress (e.g. tutorial skip) immediately
                        return 'done'; // conversation finished/closed
                    }
                    // hold position while adjacent: don't let the engine's naive
                    // walking drag Pepe off while the talk script starts
                    const ndx = this.npc ? Math.abs(this.npc.x - p.x) : 99;
                    const ndz = this.npc ? Math.abs(this.npc.z - p.z) : 99;
                    if (Math.max(ndx, ndz) <= 1 && p.hasWaypoints()) {
                        p.clearWaypoints();
                    }
                    // grace period right after talking: script may still be starting
                    if (World.currentTick - this.talkedAtTick < 15) {
                        return 'running';
                    }
                    if (wasUnreachable()) {
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'unreachable' });
                        return 'aborted';
                    }
                    // engine gave up (interaction cleared, not walking anymore)
                    if (!p.hasInteraction() && !p.hasWaypoints()) {
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'interaction_cleared' });
                        return 'aborted';
                    }
                    return 'running'; // still walking / script starting
                }

                this.sawDialog = true;

                // human-ish pace: 1 click per ~3s
                if (World.currentTick - this.lastOptionTick < 5) {
                    return 'running';
                }
                if (this.optionsPicked >= this.MAX_OPTIONS) {
                    p.closeModal();
                    return 'done';
                }

                const dlg = currentDialog(p.resumeButtons);
                const hasOptions = dlg !== null && dlg.options.length > 0;
                if (!hasOptions) {
                    // No resume-button options → this is a "click here to continue"
                    // page. The client advances these with RESUME_PAUSEBUTTON (opcode 72):
                    // resume the paused script directly, exactly like that handler does.
                    if (p.activeScript && p.activeScript.execution === ScriptState.PAUSEBUTTON) {
                        p.executeScript(p.activeScript, true, true);
                        this.optionsPicked++;
                        this.lastOptionTick = World.currentTick;
                        botLog.append('action', { action: 'dialog_page' });
                    } else if (!p.activeScript && (this.sawDialog || this.optionsPicked > 0)) {
                        // script is finished but an interface lingers (e.g. a shop
                        // viewport opened by the dialog) — close it and move on
                        bot.saveNow();
                        p.closeModal();
                        return 'done';
                    } else if (World.currentTick - this.lastOptionTick > 50 && this.optionsPicked === 0) {
                        // nothing resumable for 30s — bail out
                        p.closeModal();
                        return 'done';
                    }
                    return 'running';
                }

                // Strategist dialog callback: when soul routing is on, real choices go
                // to the Hermes agent (questing unlock). Timeout falls back to the
                // deterministic first option so dialogs never stall.
                let option = dlg.options[0];
                const sig = this.npcName + '|' + dlg.options.map(o => o.comId).join(',');
                if (soulRoutingEnabled() && !noticesMuted()) {
                    if (requestDialogChoice(sig)) {
                        this.choiceAskedAt = World.currentTick;
                        const lines = dlg.lines.slice(-4).join(' / ');
                        const opts = dlg.options.map(o => `${o.comId}: ${o.text}`).join(' | ');
                        forwardDialogNotice(
                            `Pepe is talking to ${this.npcName} and must choose a reply. Dialog: "${lines}". Options (reply with dialog_pick + comId): ${opts}. Callback sig: ${sig} — pass it back as dialog_pick sig; a stale pick is rejected instead of hijacking the page.`,
                            { dialog_npc: this.npcName, sig }
                        );
                        botLog.append('action', { action: 'dialog_callback', npc: this.npcName, options: dlg.options.length });
                    }
                    const pick = consumeDialogChoice(sig);
                    if (pick !== null) {
                        const chosen = dlg.options.find(o => o.comId === pick);
                        if (chosen) {
                            option = chosen;
                            botLog.append('action', { action: 'dialog_soul_pick', npc: this.npcName, comId: pick, text: chosen.text.slice(0, 60) });
                        } else {
                            botLog.append('action', { action: 'dialog_soul_pick_stale', npc: this.npcName, comId: pick });
                        }
                        clearDialogChoice();
                    } else if (World.currentTick - this.choiceAskedAt <= 150) {
                        return 'running'; // waiting for the soul (~90s budget)
                    } else {
                        clearDialogChoice();
                        botLog.append('action', { action: 'dialog_callback_timeout', npc: this.npcName });
                    }
                }
                p.lastCom = option.comId;
                if (p.resumeButtons.includes(option.comId) && p.activeScript && (p.activeScript.execution === ScriptState.PAUSEBUTTON || p.activeScript.execution === ScriptState.COUNTDIALOG)) {
                    p.executeScript(p.activeScript, true, true);
                    this.optionsPicked++;
                    this.lastOptionTick = World.currentTick;
                    // loop guard: same options page executed repeatedly = no progress.
                    // (observed: Hans 'in charge' page picked 3x while an agent polled.)
                    if (sig === this.lastPickSig) {
                        this.pickRepeat++;
                    } else {
                        this.lastPickSig = sig;
                        this.pickRepeat = 1;
                    }
                    if (this.pickRepeat >= 3) {
                        botLog.append('reflex', { kind: 'dialog_loop', npc: this.npcName, repeats: this.pickRepeat });
                        p.closeModal();
                        return 'aborted';
                    }
                    botLog.append('action', { action: 'dialog_option', comId: option.comId, text: option.text.slice(0, 60) });
                } else {
                    // not resumable via buttons — back off, stall logic will close us out
                    this.lastOptionTick = World.currentTick - 55;
                }
                return 'running';
            }
            case Phase.DONE:
                return 'done';
        }
    }
}
