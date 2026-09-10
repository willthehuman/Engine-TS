// Pepe bot — HTTP control surface. 127.0.0.1 only, no firewall rule ever.
// Endpoints: /health /state /events?cursor= /chat-tail?n= POST /act /admin/*

import fastify from 'fastify';

import { brain } from './bot.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import World from '#/engine/World.js';
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
        return Percept.snapshot(bot, Percept.nearby(bot, players));
    });

    app.get('/events', async req => {
        const cursor = Number((req.query as Record<string, string>).cursor ?? 0) || 0;
        return botLog.since(cursor);
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
                // Phase 2.3: goal compilation arrives with the decision layer.
                return { action, ok: false, reason: 'not_implemented' };
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
            default:
                return { error: 'unknown admin action' };
        }
    });

    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`[pepe] control surface on http://127.0.0.1:${PORT}`);
}
