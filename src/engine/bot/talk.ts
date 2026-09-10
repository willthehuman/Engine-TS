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
import { currentDialog, wasUnreachable, clearDialogFlags } from './dialog.js';
import { findPath } from '#/engine/GameMap.js';

enum Phase {
    FIND,
    APPROACH,
    TALK,
    DIALOG,
    DONE
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
    private readonly MAX_OPTIONS = 12; // hard cap: never loop a dialog forever

    constructor(name: string) {
        this.npcName = name;
    }

    step(bot: BotPlayer): 'running' | 'done' | 'aborted' {
        const p = bot.player;
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

                // pick the nearest candidate we can actually reach (path test)
                let best: Npc | null = null;
                for (const c of candidates) {
                    if (findPath(p.level, p.x, p.z, c.npc.x, c.npc.z).length > 0) {
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
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist <= 2.5) {
                    this.phase = Phase.TALK;
                    return 'running';
                }
                // walk with the SMART pathfinder (the engine's naive pathToPathingTarget
                // stalls on obstacles; we only set the interaction once genuinely close)
                if (!p.hasWaypoints() || npc.x !== this.lastNpcX || npc.z !== this.lastNpcZ) {
                    const path = findPath(p.level, p.x, p.z, npc.x, npc.z);
                    if (path.length === 0) {
                        botLog.append('reflex', { kind: 'talk_aborted', npc: this.npcName, reason: 'no_path' });
                        return 'aborted';
                    }
                    p.queueWaypoints(path);
                    this.lastNpcX = npc.x;
                    this.lastNpcZ = npc.z;
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
                    return 'aborted';
                }
                p.opcalled = true;
                this.phase = Phase.DIALOG;
                this.lastOptionTick = World.currentTick;
                this.talkedAtTick = World.currentTick;
                botLog.append('action', { action: 'talk_to', npc: this.npcName });
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

                const option = dlg.options[0]; // deterministic: first option
                p.lastCom = option.comId;
                if (p.resumeButtons.includes(option.comId) && p.activeScript && (p.activeScript.execution === ScriptState.PAUSEBUTTON || p.activeScript.execution === ScriptState.COUNTDIALOG)) {
                    p.executeScript(p.activeScript, true, true);
                    this.optionsPicked++;
                    this.lastOptionTick = World.currentTick;
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
