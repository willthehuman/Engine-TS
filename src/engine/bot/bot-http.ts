// Pepe bot — HTTP control surface. 127.0.0.1 only, no firewall rule ever.
// Endpoints: /health /state /events?cursor= /chat-tail?n= POST /act /admin/*

import fastify from 'fastify';

import { brain } from './bot.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import { compileGoal } from './goals.js';
import { currentDialog, resetDialog } from './dialog.js';
import ScriptState from '#/engine/script/ScriptState.js';
import World from '#/engine/World.js';
import NpcType from '#/cache/config/NpcType.js';
import type Player from '#/engine/entity/Player.js';

const PORT = 43695;

export async function startBotHttp(): Promise<void> {
    const app = fastify({ logger: false });

    const getBot = () => brain.bots[0] ?? null;

    app.get('/health', async () => ({
        up: true,
        tick: World.currentTick,
        bots: brain.bots.map(b => b.status())
    }));

    app.get('/state', async () => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const players: Player[] = [];
        for (const p of World.playerLoop.all()) {
            players.push(p);
        }
        const snap = Percept.snapshot(bot, Percept.nearby(bot, players)) as Record<string, unknown>;
        snap.debug = {
            modalState: bot.player.modalState,
            activeScript: bot.player.activeScript?.execution ?? null,
            resumeButtons: bot.player.resumeButtons,
            target: bot.player.target ? String((bot.player.target as unknown as { constructor: { name: string } }).constructor.name) : null,
            waypoints: bot.player.waypointIndex !== -1,
            protect: bot.player.protect,
            delayed: bot.player.delayed
        };
        return snap;
    });

    app.get('/events', async req => {
        const cursor = Number((req.query as Record<string, string>).cursor ?? 0) || 0;
        return botLog.since(cursor);
    });

    app.get('/npcs', async req => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const range = Math.min(Number((req.query as Record<string, string>).range ?? 20) || 20, 60);
        const p = bot.player;
        const rows: { name: string; x: number; z: number; dist: number; type: number }[] = [];
        for (const npc of World.npcs) {
            if (npc.level !== p.level) {
                continue;
            }
            const dx = npc.x - p.x;
            const dz = npc.z - p.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > range) {
                continue;
            }
            const nt = NpcType.get(npc.type);
            rows.push({ name: nt?.name ?? `type:${npc.type}`, x: npc.x, z: npc.z, dist: Math.round(dist * 10) / 10, type: npc.type });
        }
        rows.sort((a, b) => a.dist - b.dist);
        return { tile: { x: p.x, z: p.z }, npcs: rows.slice(0, 40) };
    });

    app.get('/dialog', async () => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        // authoritative: only report open when the player actually has a modal/paused script
        const paused = bot.player.activeScript?.execution === ScriptState.PAUSEBUTTON || bot.player.activeScript?.execution === ScriptState.COUNTDIALOG;
        if (!bot.player.containsModalInterface() && !paused) {
            resetDialog();
            return { open: false };
        }
        const dlg = currentDialog(bot.player.resumeButtons);
        if (!dlg) {
            return { open: false };
        }
        return {
            open: true,
            lines: dlg.lines.slice(-6),
            options: dlg.options,
            debug: {
                resumeButtons: bot.player.resumeButtons,
                textByCom: Object.fromEntries(dlg.textByCom),
                lastCom: bot.player.lastCom
            }
        };
    });

    app.get('/chat-tail', async req => {
        const n = Math.min(Number((req.query as Record<string, string>).n ?? 10) || 10, 30);
        return { events: botLog.tail('chat', n) };
    });

    app.post<{ Body: { action: string; args?: Record<string, unknown> } }>('/act', async req => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const { action, args = {} } = req.body ?? ({} as never);

        switch (action) {
            case 'say': {
                const res = bot.say(String(args.text ?? ''));
                return { action, ...res };
            }
            case 'move_to': {
                const res = bot.moveTo(Number(args.x), Number(args.z));
                return { action, ...res };
            }
            case 'stop': {
                return { action, ...bot.stop() };
            }
            case 'set_goal': {
                const steps = Array.isArray(args.steps) ? (args.steps as string[]) : [];
                if (!steps.length) {
                    return { action, ok: false, reason: 'no_steps' };
                }
                const routines = compileGoal(steps);
                if (!routines.length) {
                    return { action, ok: false, reason: 'unparseable' };
                }
                bot.clearRoutines();
                for (const r of routines) {
                    bot.enqueue(r);
                }
                return { action, ok: true, steps: steps.length };
            }
            default:
                return { error: 'unknown action' };
        }
    });

    app.post<{ Body: { action: string } }>('/admin', async req => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        switch (req.body?.action) {
            case 'freeze':
                bot.freeze();
                return { ok: true, state: bot.status() };
            case 'unfreeze': {
                if (bot.brainState === 'error') {
                    bot.unfreeze(); // clears circuit breaker
                }
                bot.unfreeze();
                return { ok: true, state: bot.status() };
            }
            case 'clear':
                bot.clearRoutines();
                return { ok: true, state: bot.status() };
            case 'close_modal':
                bot.player.closeModal();
                return { ok: true };
            case 'save':
                return { ok: bot.saveNow() };
            default:
                return { error: 'unknown admin action' };
        }
    });

    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`[pepe] control surface on http://127.0.0.1:${PORT}`);
}
