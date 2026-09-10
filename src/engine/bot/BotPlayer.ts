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
import { botLog } from './EventLog.js';
import type { Routine } from './routines.js';

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

        // step the routine queue
        if (this.routine) {
            const done = this.routine.step(this);
            this.currentRoutineName = this.routine.constructor.name;
            if (done === 'done') {
                this.routine = null;
                this.currentRoutineName = null;
                this.nextRoutine();
            } else if (done === 'aborted') {
                this.routine = null;
                this.currentRoutineName = null;
                this.routineQueue.length = 0;
            }
        } else {
            this.nextRoutine();
        }
    }

    private nextRoutine(): void {
        const next = this.routineQueue.shift();
        if (next) {
            this.routine = next;
            this.brainState = 'executing';
        } else {
            this.brainState = 'idle';
        }
    }

    enqueue(r: Routine, clear = false): void {
        if (clear) {
            this.routineQueue.length = 0;
            this.routine = null;
        }
        this.routineQueue.push(r);
    }

    clearRoutines(): void {
        this.routineQueue.length = 0;
        this.routine = null;
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

    moveTo(x: number, z: number): { ok: boolean; reason?: string } {
        const p = this.player;
        if (typeof x !== 'number' || typeof z !== 'number' || !Number.isInteger(x) || !Number.isInteger(z)) {
            return { ok: false, reason: 'bad_coords' };
        }
        const dist = Math.max(Math.abs(x - p.x), Math.abs(z - p.z));
        if (dist > 104) {
            return { ok: false, reason: 'too_far' };
        }
        if (World.currentTick - this.lastMoveTick < BotPlayer.MOVE_COOLDOWN_TICKS) {
            return { ok: false, reason: 'rate_limited' };
        }
        if (!this.spendAction()) {
            return { ok: false, reason: 'action_budget' };
        }

        const path = findPath(p.level, p.x, p.z, x, z);
        if (!path || path.length === 0) {
            return { ok: false, reason: 'no_path' };
        }
        p.queueWaypoints(path);
        this.lastMoveTick = World.currentTick;
        botLog.append('action', { action: 'move_to', x, z });
        return { ok: true };
        // arrival detection lives in the WalkRoutine that wraps moveTo
    }

    stop(): { ok: boolean } {
        this.routineQueue.length = 0;
        this.routine = null;
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
