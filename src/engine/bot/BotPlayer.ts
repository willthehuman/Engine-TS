// Pepe bot — headless player wrapper. Attach via the same code path an
// x-logged player uses: NetworkPlayer + NullClientSocket, loaded through
// PlayerLoading.load (which handles both fresh and existing saves).
// The world loop already guards all network I/O with isClientConnected(), so a
// NullClientSocket player ticks through the world without any packet traffic.

import fs from 'fs';
import Packet from '#/io/Packet.js';
import World from '#/engine/World.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import NullClientSocket from '#/server/NullClientSocket.js';
import WordEnc from '#/cache/wordenc/WordEnc.js';
import WordPack from '#/wordenc/WordPack.js';
import { findPath } from '#/engine/GameMap.js';
import { PlayerInfoProt } from '#/network/rsbuf/index.js';
import { toBase37 } from '#/util/JString.js';
import Entity from '#/engine/entity/Entity.js';
import LocType from '#/cache/config/LocType.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { botLog } from './EventLog.js';
import { FollowRoutine, WalkRoutine, StepWalkRoutine, type Routine } from './routines.js';
import { resolveOp } from './interact.js';

export interface Persona {
    name: string;
    hearDistance: number; // tiles; perception honesty radius for public chat
    wanderRadius: number; // tiles from anchor
    chattiness: number; // 0..1, reserved for the decision layer
}

export const DEFAULT_PERSONA: Persona = {
    name: 'pepe',
    hearDistance: 14,
    wanderRadius: 15,
    chattiness: 0.35
};

type BrainState = 'idle' | 'executing' | 'thinking' | 'frozen' | 'error';

export class BotPlayer {
    player: NetworkPlayer;
    persona: Persona;
    brainState: BrainState = 'idle';
    currentRoutineName: string | null = null;
    private routine: Routine | null = null;
    private routineQueue: Routine[] = [];
    private frozen = false;

    // action rate limiting (engine-side, LLM cannot talk past these)
    private lastSayTick = -1;
    private lastMoveTick = -1;
    private actionsThisMinute = 0;
    private minuteWindowStart = Date.now();
    private lastWalkKey = '';
    private doorTask: { x: number; z: number; type: number; level: number; opIndex: number; phase: 'walk' | 'fire' | 'wait'; ticks: number; refired?: boolean } | null = null;
    private lastDoorOpenTick = -100;
    private doorsOpenedThisGoal = 0;
    private walkRetryCount = 0;
    private stepWalkTried = false;
    static readonly MAX_WALK_RETRIES = 4;
    static readonly SAY_COOLDOWN_TICKS = 5; // 1 say / 3s
    static readonly MOVE_COOLDOWN_TICKS = 1; // 2 moves / s
    static readonly MAX_ACTIONS_PER_MIN = 25;

    private constructor(player: NetworkPlayer, persona: Persona) {
        this.player = player;
        this.persona = persona;
    }

    /** Load (or create) the save and attach to the world. */
    static async attach(persona: Persona = DEFAULT_PERSONA): Promise<BotPlayer> {
        const name = persona.name;
        const savePath = `data/players/main/${name}.sav`;
        let sav: Packet;
        if (fs.existsSync(savePath)) {
            sav = new Packet(fs.readFileSync(savePath));
        } else {
            sav = new Packet(new Uint8Array(0)); // empty => PlayerLoading creates a fresh character
        }

        const client = new NullClientSocket();
        const player = PlayerLoading.load(name, sav, client) as NetworkPlayer;
        player.session = client.uuid;
        player.reconnecting = false;
        player.staffModLevel = 0;
        player.lowMemory = false;
        player.members = true;

        World.newPlayers.add(player);

        const bot = new BotPlayer(player, persona);
        botLog.append('attach', { name, tile: { x: player.x, z: player.z, level: player.level } });
        return bot;
    }

    /** Persist the character save file immediately (mirrors LoginThread's write path). */
    saveNow(): boolean {
        try {
            fs.writeFileSync(`data/players/main/${this.player.username}.sav`, this.player.save());
            return true;
        } catch {
            return false;
        }
    }

    /** Tick — called from World.cycle() every game tick. Must stay cheap. */
    tick(): void {
        const p = this.player;

        // keepalive: refresh connection bookkeeping so the 30s/60s timeout
        // logic in processLogouts() never fires for the bot
        p.lastConnected = World.currentTick;
        p.lastResponse = World.currentTick;

        if (this.frozen) {
            return;
        }

        // advance rate-limit window
        if (Date.now() - this.minuteWindowStart >= 60_000) {
            this.actionsThisMinute = 0;
            this.minuteWindowStart = Date.now();
        }

        // door/gate task advances independently of the routine (it only
        // clears after the open op lands and the collision updates)
        this.stepDoorTask();

        // FREEZE ALL ROUTINES while a door task runs: scenery ops execute only
        // on a tick where the player takes no steps — any routine stepping
        // (walk/gather/buy/interact...) that queues movement cancels the
        // pending op and the door never opens (2026-09-12: gather at the
        // chicken-pen gate stalled forever; the freeze previously covered
        // only the two walk routines — this covers every routine centrally).
        if (this.doorTask) {
            return;
        }

        // step the routine queue
        if (this.routine) {
            this.currentRoutineName = this.routine.constructor.name;
            const done = this.routine.step(this);
            if (done === 'done') {
                this.goalSteps.push(`${this.describeRoutine(this.routine)} done`);
                this.routine = null;
                this.currentRoutineName = null;
                this.nextRoutine();
                if (this.routine === null && this.goalLabel !== null) {
                    this.emitGoalDone('done'); // whole queue drained
                }
            } else if (done === 'aborted') {
                const wasStepWalk = this.routine instanceof StepWalkRoutine;
                const raw = this.routine as unknown as Record<string, unknown>;
                const destX = typeof raw.destX === 'number' ? raw.destX : undefined;
                const destZ = typeof raw.destZ === 'number' ? raw.destZ : undefined;
                botLog.append('reflex', { kind: 'stepwalk_aborted', wasStepWalk, destX, destZ, keys: this.routine ? Object.keys(this.routine) : [], constructorName: this.routine?.constructor?.name ?? 'null' });
                this.goalSteps.push(`${this.describeRoutine(this.routine)} aborted (wasStepWalk=${wasStepWalk} destX=${destX} destZ=${destZ})`);
                this.routine = null;
                this.currentRoutineName = null;
                if (wasStepWalk && destX !== undefined && destZ !== undefined) {
                    if (this.walkRetryCount > BotPlayer.MAX_WALK_RETRIES) {
                        // the last-resort stepwalk pass failed too — real abort
                        this.routineQueue.length = 0;
                        this.emitGoalDone('aborted');
                    } else {
                        // stepwalk got stuck (wall/door) — retry with full
                        // pathfinding (WalkRoutine → door task machinery)
                        this.enqueueFront(new WalkRoutine(destX, destZ));
                        botLog.append('action', { action: 'stepwalk_fallback', x: destX, z: destZ });
                    }
                } else if (destX !== undefined && destZ !== undefined) {
                    // WalkRoutine got stuck — the door may be in the process of
                    // opening. Retry up to MAX_WALK_RETRIES times.
                    this.walkRetryCount++;
                    if (this.walkRetryCount > BotPlayer.MAX_WALK_RETRIES) {
                        if (!this.stepWalkTried) {
                            // retries exhausted — ONE tile-per-tile pass as the
                            // last resort (stale-A*/door-dense routes) before
                            // the goal dies
                            this.stepWalkTried = true;
                            this.enqueueFront(new StepWalkRoutine(destX, destZ));
                            botLog.append('action', { action: 'stepwalk_lastresort', x: destX, z: destZ });
                        } else {
                            this.routineQueue.length = 0;
                            this.emitGoalDone('aborted');
                        }
                    } else {
                        // retry FIRST — remaining goal steps wait for the walk
                        this.enqueueFront(new WalkRoutine(destX, destZ));
                        botLog.append('action', { action: 'walkretry', x: destX, z: destZ, retry: this.walkRetryCount });
                    }
                } else {
                    this.routineQueue.length = 0;
                    this.emitGoalDone('aborted');
                }
            }
        } else {
            this.nextRoutine();
        }
    }

    private nextRoutine(): void {
        const next = this.routineQueue.shift();
        if (next) {
            this.routine = next;
            if (next instanceof StepWalkRoutine) {
                // one stepwalk pass per goal attempt (explicit or last-resort)
                this.stepWalkTried = true;
            }
            this.brainState = 'executing';
        } else {
            this.brainState = 'idle';
        }
    }

    enqueue(r: Routine, clear = false): void {
        if (clear) {
            this.clearRoutines(); // emits goal_superseded when killing a tracked goal
        }
        this.routineQueue.push(r);
    }

    /**
     * Put a routine at the FRONT of the queue. Retries of the CURRENT step
     * must run before the goal's remaining steps — a backend enqueue let
     * compound-goal retries execute AFTER later steps (2026-09-12 fix).
     */
    enqueueFront(r: Routine): void {
        this.routineQueue.unshift(r);
    }

    /** Goal label for completion signals (set_goal DSL). Null = free routines, no signal. */
    goalLabel: string | null = null;
    private goalSteps: string[] = [];

    /** Enqueue a compiled goal spec as one trackable unit. Preempting a live goal
     * emits goal_superseded so stale runs disarm themselves on their next poll. */
    setGoal(steps: string[], routines: Routine[]): void {
        const old = this.goalLabel;
        const wasActive = this.routine !== null || this.routineQueue.length > 0;
        this.clearQueue();
        this.walkRetryCount = 0;
        this.stepWalkTried = false;
        this.doorsOpenedThisGoal = 0;
        this.goalLabel = steps.join(' | ');
        this.goalSteps = [];
        for (const r of routines) {
            // Always use StepWalkRoutine for stepwalk goals — it walks
            // tile-by-tile and handles doors via walkSegment.
            // (WalkRoutine's stuck detection has issues with door tasks
            // that walk away from the destination.)
            this.enqueue(r);
        }
        if (old && wasActive) {
            botLog.append('action', { action: 'goal_superseded', old_goal: old, new_goal: this.goalLabel });
        }
    }

    private clearQueue(): void {
        this.routineQueue.length = 0;
        this.routine = null;
    }

    private describeRoutine(r: Routine): string {
        const name = r?.constructor?.name ?? '?';
        const extra = (r as unknown as { npcName?: unknown })?.npcName;
        return typeof extra === 'string' && extra ? `${name}:${extra}` : name;
    }

    private emitGoalDone(outcome: string): void {
        const goal = this.goalLabel;
        this.goalLabel = null;
        const steps = this.goalSteps;
        this.goalSteps = [];
        if (!goal) {
            return;
        }
        // noticePoll forwards this via summarizeNotable: the explicit 'you are done'
        // signal, so agents stop on evidence instead of polling state in circles.
        botLog.append('action', { action: 'goal_done', goal, outcome, steps });
    }

    clearRoutines(): void {
        if (this.goalLabel !== null) {
            // tracked goal killed by a direct command (follow/stop/train...) — tell
            // the run that set it to stand down instead of acting stale.
            botLog.append('action', { action: 'goal_superseded', old_goal: this.goalLabel, new_goal: null });
        }
        this.clearQueue();
        this.goalLabel = null;
        this.goalSteps = [];
    }

    // ---- validated actions (the ONLY way the outside world mutates Pepe) ----

    say(text: string): { ok: boolean; reason?: string } {
        const p = this.player;
        const clean = (text ?? '').toString().slice(0, 100);
        if (!clean.length) {
            return { ok: false, reason: 'empty' };
        }
        if (p.muted_until !== null && p.muted_until > new Date()) {
            return { ok: false, reason: 'muted' };
        }
        if (World.currentTick - this.lastSayTick < BotPlayer.SAY_COOLDOWN_TICKS) {
            return { ok: false, reason: 'rate_limited' };
        }
        if (!this.spendAction()) {
            return { ok: false, reason: 'action_budget' };
        }

        // exact real-player chat path (mirrors MessagePublicHandler)
        const out = Packet.alloc(0);
        WordPack.pack(out, WordEnc.filter(clean));
        p.chatMessage = new Uint8Array(out.pos);
        out.pos = 0;
        out.gdata(p.chatMessage, 0, p.chatMessage.length);
        out.release();
        p.chatColour = 0;
        p.chatEffect = 0;
        p.chatRights = Math.min(p.staffModLevel, 2);
        p.masks |= PlayerInfoProt.CHAT;
        p.logMessage = clean; // flows through World's normal chat logging + our tap

        this.lastSayTick = World.currentTick;
        botLog.append('action', { action: 'say', text: clean });
        return { ok: true };
    }

    sendPm(to: string, text: string): { ok: boolean; reason?: string } {
        const p = this.player;
        const name = (to ?? '').toString().toLowerCase().trim();
        const clean = (text ?? '').toString().slice(0, 100);
        if (!name.length || !clean.length) {
            return { ok: false, reason: 'empty' };
        }
        if (name === p.username) {
            return { ok: false, reason: 'self' };
        }
        const target = World.getPlayerByUsername(name);
        if (!target) {
            return { ok: false, reason: 'player_offline' };
        }
        if (p.muted_until !== null && p.muted_until > new Date()) {
            return { ok: false, reason: 'muted' };
        }
        if (World.currentTick - this.lastSayTick < BotPlayer.SAY_COOLDOWN_TICKS) {
            return { ok: false, reason: 'rate_limited' };
        }
        if (!this.spendAction()) {
            return { ok: false, reason: 'action_budget' };
        }

        // same path a real client uses (MessagePrivateHandler → World.sendPrivateMessage)
        World.sendPrivateMessage(p, target.username37, clean);
        this.lastSayTick = World.currentTick;
        botLog.append('action', { action: 'pm', to: target.username, text: clean });
        return { ok: true };
    }

    addFriend(name: string): { ok: boolean; reason?: string } {
        const p = this.player;
        const clean = (name ?? '').toString().toLowerCase().trim();
        if (!clean.length) {
            return { ok: false, reason: 'empty' };
        }
        if (clean === p.username) {
            return { ok: false, reason: 'self' };
        }
        // same path a real client uses (friend add → World.addFriend → friend server)
        World.addFriend(p, toBase37(clean));
        botLog.append('action', { action: 'friend_add', target: clean });
        return { ok: true };
    }

    /**
     * Ops rescue: teleport Pepe out of unwalkable spots (random-event maze,
     * clipped corners). Same player.teleport() real clients use. Logged.
     */
    teleportTo(x: number, z: number, level = 0): { ok: boolean; reason?: string } {
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
            return { ok: false, reason: 'bad_coords' };
        }
        const p = this.player;
        this.clearRoutines();
        p.teleport(Math.round(x), Math.round(z), level);
        botLog.append('action', { action: 'teleport', x: Math.round(x), z: Math.round(z), level });
        return { ok: true };
    }

    followPlayer(name: string): { ok: boolean; reason?: string } {
        const p = this.player;
        const nm = (name ?? '').toString().toLowerCase().trim();
        if (!nm.length) {
            return { ok: false, reason: 'empty' };
        }
        const target = World.getPlayerByUsername(nm);
        if (!target || target.username === p.username) {
            return { ok: false, reason: 'player_offline' };
        }
        // perception honesty: follow only a player Pepe can see
        if (target.level !== p.level) {
            return { ok: false, reason: 'cant_see' };
        }
        const dx = Math.abs(target.x - p.x);
        const dz = Math.abs(target.z - p.z);
        if (Math.max(dx, dz) > this.persona.hearDistance) {
            return { ok: false, reason: 'cant_see' }; // same radius perception reports
        }
        if (!this.spendAction()) {
            return { ok: false, reason: 'action_budget' };
        }
        this.clearRoutines();
        this.enqueue(new FollowRoutine(target.username));
        botLog.append('action', { action: 'follow', user: target.username });
        return { ok: true };
    }

    moveTo(x: number, z: number): { ok: boolean; reason?: string } {
        const p = this.player;
        if (!this.validCoords(x, z)) {
            return { ok: false, reason: 'bad_coords' };
        }
        const dist = Math.max(Math.abs(x - p.x), Math.abs(z - p.z));
        if (dist > 104) {
            return { ok: false, reason: 'too_far' }; // agent-facing limit; routines walk staged instead
        }
        if (World.currentTick - this.lastMoveTick < BotPlayer.MOVE_COOLDOWN_TICKS) {
            return { ok: false, reason: 'rate_limited' };
        }
        if (!this.spendAction()) {
            return { ok: false, reason: 'action_budget' };
        }
        if (!this.pathAndQueue(x, z)) {
            return { ok: false, reason: 'no_path' };
        }
        this.lastMoveTick = World.currentTick;
        botLog.append('action', { action: 'move_to', x, z });
        return { ok: true };
        // arrival detection lives in the WalkRoutine that wraps moveTo
    }

    /**
     * Internal segment walk for routines (no rate limit / action budget — the
     * routine engine is the pacing). The rsmod A* window is ~64 tiles, so long
     * journeys are walked in segments by WalkRoutine; each segment lands here.
     */
    /**
     * Door/gate-aware walking (rs-sdk walkTo lesson): findPath refuses to route
     * through closed doors, so when a path fails we open the nearest door/gate
     * and let the routine re-path a few ticks later (collision updates on the
     * loc change). Stepped once per world tick from step().
     */
    private stepDoorTask(): void {
        const task = this.doorTask;
        if (!task) {
            return;
        }
        const p = this.player;
        if (task.phase === 'walk') {
            if (task.ticks++ > 40) {
                botLog.append('reflex', { kind: 'door_task_giveup', phase: 'walk_timeout', x: task.x, z: task.z });
                this.doorTask = null; // couldn't get adjacent — give up this door
                this.lastDoorOpenTick = World.currentTick;
                return;
            }
            const dist = Math.max(Math.abs(task.x - p.x), Math.abs(task.z - p.z));
            if (dist <= 1) {
                task.phase = 'fire';
                task.ticks = 0;
                return;
            }
            if (p.hasWaypoints()) {
                return;
            }
            // path to an adjacent tile (or a hop toward it when A* fails)
            const cands: { x: number; z: number; d: number }[] = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (Math.abs(dx) + Math.abs(dz) !== 1) continue;
                    cands.push({ x: task.x + dx, z: task.z + dz, d: Math.max(Math.abs(p.x - (task.x + dx)), Math.abs(p.z - (task.z + dz))) });
                }
            }
            cands.sort((a, b) => a.d - b.d);
            for (const c of cands) {
                const path = findPath(p.level, p.x, p.z, c.x, c.z);
                if (path && path.length > 0) {
                    p.queueWaypoints(path);
                    return;
                }
            }
            // no path to any neighbour — step toward it via a raw hop
            for (const c of cands) {
                const dx = c.x - p.x;
                const dz = c.z - p.z;
                const distC = Math.max(Math.abs(dx), Math.abs(dz));
                if (distC <= 1) continue;
                const hx = p.x + Math.round(dx / distC);
                const hz = p.z + Math.round(dz / distC);
                const hop = findPath(p.level, p.x, p.z, hx, hz);
                if (hop && hop.length > 0) {
                    p.queueWaypoints(hop);
                    return;
                }
            }
            botLog.append('reflex', { kind: 'door_task_giveup', phase: 'walk_stuck', x: task.x, z: task.z });
            this.doorTask = null; // fully stuck
            this.lastDoorOpenTick = World.currentTick;
            return;
        }
        if (task.phase === 'fire') {
            if (p.hasInteraction()) {
                botLog.append('reflex', { kind: 'door_task_fire_blocked', x: task.x, z: task.z, why: 'interaction_pending' });
                return; // give the active interaction the tick
            }
            const loc = World.getLoc(task.x, task.z, task.level, task.type);
            if (!loc) {
                botLog.append('reflex', { kind: 'door_task_giveup', phase: 'loc_missing', x: task.x, z: task.z });
                this.doorTask = null; // despawned/morphed — walkSegment will re-scan
                return;
            }
            p.clearWaypoints();
            const trigger = ServerTriggerType.APLOC1 + (task.opIndex - 1);
            const setOk = p.setInteraction(Interaction.ENGINE, loc as unknown as Entity, trigger);
            botLog.append('reflex', { kind: 'door_task_fire', x: task.x, z: task.z, opIndex: task.opIndex, set: setOk });
            if (setOk) {
                p.opcalled = true;
                this.doorsOpenedThisGoal++;
                botLog.append('action', { action: 'door_open', loc: `${task.x},${task.z}` });
            }
            task.phase = 'wait';
            task.ticks = 0;
            return;
        }
        // wait: verify the loc actually changed (gone / morphed). If the op
        // didn't take, re-fire ONCE (fresh interaction); then give up and let
        // walkSegment rescan. (2026-09-12: fired-once-blind left the door
        // closed and the walk aborted 4x — with the routines frozen during
        // this wait, the op now gets its stepsTaken===0 tick to execute.)
        const loc = World.getLoc(task.x, task.z, task.level, task.type);
        const changed = !loc || loc.isChanged() || loc.type !== task.type;
        if (changed) {
            if (task.ticks++ > 4) {
                botLog.append('reflex', { kind: 'door_task_end', x: task.x, z: task.z, changed: true });
                this.doorTask = null;
                this.lastDoorOpenTick = World.currentTick;
            }
            return;
        }
        if (task.ticks++ > 6) {
            if (!task.refired) {
                task.refired = true;
                task.phase = 'fire';
                task.ticks = 0;
                p.clearInteraction(); // fresh interaction — the old one may be stuck
                return;
            }
            botLog.append('reflex', { kind: 'door_task_end', x: task.x, z: task.z, changed: false });
            this.doorTask = null;
            this.lastDoorOpenTick = World.currentTick;
        }
    }

    /** Find the nearest closed-look door/gate loc and start opening it. */
    private openDoorOf(): boolean {
        const p = this.player;
        if (this.doorTask || World.currentTick - this.lastDoorOpenTick < 15) {
            return this.doorTask !== null;
        }
        let best: { x: number; z: number; type: number; level: number; opIndex: number } | null = null;
        let bestDist = Infinity;
        for (const zone of World.gameMap.allZones()) {
            for (const loc of zone.getAllLocsSafe()) {
                if (loc.level !== p.level) continue;
                const lt = LocType.get(loc.type);
                const name = lt?.name?.toLowerCase() ?? '';
                if (!name.includes('door') && !name.includes('gate')) continue;
                const d = Math.max(Math.abs(loc.x - p.x), Math.abs(loc.z - p.z));
                if (d > 14 || d >= bestDist) continue;
                const ops = { op: lt?.op ?? [] };
                const op = resolveOp(ops, 'open') ?? resolveOp(ops, 1); // first visible op fallback
                if (!op) continue;
                best = { x: loc.x, z: loc.z, type: loc.type, level: loc.level, opIndex: op.index };
                bestDist = d;
            }
        }
        if (!best) {
            return false;
        }
        this.doorTask = { ...best, phase: 'walk', ticks: 0 };
        botLog.append('reflex', { kind: 'door_task_start', x: best.x, z: best.z, opIndex: best.opIndex });
        return true;
    }

    walkSegment(x: number, z: number): { ok: boolean; reason?: string } {
        if (!this.validCoords(x, z)) {
            return { ok: false, reason: 'bad_coords' };
        }
        const p = this.player;
        if (Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) > 60) {
            return { ok: false, reason: 'segment_too_far' };
        }
        if (!this.pathAndQueue(x, z)) {
            if (this.doorsOpenedThisGoal < 4 && this.openDoorOf()) {
                return { ok: false, reason: 'door_opening' };
            }
            if (this.doorsOpenedThisGoal >= 4) {
                botLog.append('reflex', { kind: 'door_budget_exhausted', doorsOpenedThisGoal: this.doorsOpenedThisGoal });
            }
            return { ok: false, reason: 'no_path' };
        }
        this.doorsOpenedThisGoal = 0;
        const key = x + ',' + z + ':' + (this.currentRoutineName ?? '');
        if (key !== this.lastWalkKey) {
            // dedupe: re-issues of the same leg log once
            this.lastWalkKey = key;
            botLog.append('action', { action: 'walk', x, z, routine: this.currentRoutineName });
        }
        return { ok: true };
    }

    validCoords(x: number, z: number): boolean {
        return typeof x === 'number' && typeof z === 'number' && Number.isInteger(x) && Number.isInteger(z);
    }

    private pathAndQueue(x: number, z: number): boolean {
        const p = this.player;
        const path = findPath(p.level, p.x, p.z, x, z);
        if (!path || path.length === 0) {
            // Self-heal: a phantom collision under the player (parked on a gate
            // tile, tunnel corner, teleport crisp) poisons A* from the src. Step
            // off onto the nearest neighbour from which the target is reachable;
            // the routine re-paths from there on its next walkSegment call.
            // (rs-sdk's walkTo does exactly this door/gate recovery.)
            if (!p.hasWaypoints()) {
                const cands: { x: number; z: number; d: number }[] = [];
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        if (dx === 0 && dz === 0) continue;
                        cands.push({ x: p.x + dx, z: p.z + dz, d: Math.max(Math.abs(p.x + dx - x), Math.abs(p.z + dz - z)) });
                    }
                }
                cands.sort((a, b) => a.d - b.d);
                for (const c of cands) {
                    if (!findPath(p.level, c.x, c.z, x, z)) continue;
                    const hop = findPath(p.level, p.x, p.z, c.x, c.z);
                    if (hop && hop.length > 0) {
                        // Only accept the hop if it actually gets the player
                        // closer to the destination. A hop that doesn't reduce
                        // distance means the self-heal found a dead-end (e.g.
                        // the player is next to a closed door and the "path"
                        // through the door is actually blocked). Returning
                        // false here triggers openDoorOf, which is what we need.
                        const oldDist = Math.max(Math.abs(p.x - x), Math.abs(p.z - z));
                        const newDist = Math.max(Math.abs(c.x - x), Math.abs(c.z - z));
                        if (newDist >= oldDist) continue;
                        p.queueWaypoints(hop);
                        return true;
                    }
                }
            }
            return false;
        }
        p.queueWaypoints(path);
        return true;
    }

    stop(): { ok: boolean } {
        this.clearRoutines(); // emits goal_superseded when killing a tracked goal
        this.player.clearWaypoints();
        this.brainState = 'idle';
        botLog.append('admin', { action: 'stop' });
        return { ok: true };
    }

    freeze(): void {
        this.frozen = true;
        this.stop();
        this.brainState = 'frozen';
    }

    unfreeze(): void {
        this.frozen = false;
        this.brainState = 'idle';
    }

    private spendAction(): boolean {
        if (this.actionsThisMinute >= BotPlayer.MAX_ACTIONS_PER_MIN) {
            this.brainState = 'error'; // circuit breaker; requires admin clear
            botLog.append('error', { reason: 'action_budget_exceeded' });
            return false;
        }
        this.actionsThisMinute++;
        return true;
    }

    /** Serialize state for the control surface. */
    status(): Record<string, unknown> {
        const p = this.player;
        return {
            name: p.username,
            brainState: this.brainState,
            routine: this.currentRoutineName,
            tile: { x: p.x, z: p.z, level: p.level },
            queueDepth: this.routineQueue.length,
            actionsThisMinute: this.actionsThisMinute,
            persona: this.persona
        };
    }
}
