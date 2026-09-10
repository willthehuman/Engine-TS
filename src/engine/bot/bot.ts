// Pepe bot — single entry point wiring the bot system into the engine.
// Two touch points in existing files (kept minimal):
//   1. World.ts processClientsIn(): chat tap after `this.logPublicChat(player, player.logMessage)`
//   2. World.ts cycle(): brain.tick() once per cycle
// Everything else lives in src/engine/bot/.

import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { fromBase37 } from '#/util/JString.js';
import { BotPlayer, DEFAULT_PERSONA } from './BotPlayer.js';
import { Brain } from './brain.js';
import { Percept } from './Percept.js';
import { captureDialogText } from './dialog.js';
import { botLog } from './EventLog.js';
import { forwardIngameEvent, soulRoutingEnabled } from './webhook.js';
import { consumeUpTo, isInteresting } from './decide.js';

export const brain = new Brain();
export const guests: BotPlayer[] = [];

/** World-cycle hook: one deterministic brain tick. */
export function botTick(): void {
    if (brain.bots.length === 0 && guests.length === 0) {
        return;
    }
    brain.tick();
    for (const g of guests) {
        g.tick(); // keepalive + no routines = pure connection refresh
    }
}

let started = false;

/** Boot: attach Pepe + start the tick loop. Idempotent. */
export async function startBot(): Promise<void> {
    if (started) {
        return;
    }
    started = true;

    const bot = await BotPlayer.attach();
    // dialog capture: sniff write() for IfSetText/IfOpenChat/IfClose
    const origWrite = bot.player.write.bind(bot.player);
    bot.player.write = (msg: unknown) => {
        captureDialogText(msg);
        origWrite(msg as never);
    };
    brain.register(bot);
    console.log(`[pepe] attached: ${bot.player.username} at ${bot.player.x},${bot.player.z},${bot.player.level}`);

    if (process.env.PEPE_TEST_GUEST === '1') {
        const guestPersona = { ...DEFAULT_PERSONA, name: 'testguy', hearDistance: 14, wanderRadius: 0 };
        const guest = await BotPlayer.attach(guestPersona);
        guests.push(guest); // ticked for keepalive only, no brain
        // guest is NOT registered with the brain: no wander, no decisions, pure test puppet
        console.log(`[pepe] test guest attached: ${guest.player.username} at ${guest.player.x},${guest.player.z}`);
        const script = [
            { after: 6_000, kind: 'teleport_draynor', text: '' },
            { after: 20_000, kind: 'pm', text: 'pepe come with me!' },
            { after: 110_000, kind: 'pm', text: 'im at draynor village, come here' },
            { after: 260_000, kind: 'pm', text: 'hey pepe, now follow me around!' },
            { after: 280_000, kind: 'walk_away', text: '' },
            { after: 300_000, kind: 'walk_away2', text: '' }
        ];
        for (const line of script) {
            setTimeout(() => {
                if (line.kind === 'teleport') {
                    const pp = brain.bots[0].player;
                    guest.player.teleport(pp.x + 2, pp.z, pp.level);
                    console.log(`[pepe] guest teleported next to pepe at ${pp.x},${pp.z}`);
                    return;
                }
                if (line.kind === 'teleport_draynor') {
                    guest.player.teleport(3092, 3245, 0);
                    console.log('[pepe] guest teleported to DRAYNOR (3092,3245)');
                    return;
                }
                if (line.kind === 'walk_away') {
                    const g = guest.player;
                    const res = guest.walkSegment(g.x - 12, g.z - 6);
                    console.log(`[pepe] guest walks away -> ${JSON.stringify(res)}`);
                    return;
                }
                if (line.kind === 'walk_away2') {
                    const g = guest.player;
                    const res = guest.walkSegment(g.x - 10, g.z + 4);
                    console.log(`[pepe] guest walks away 2 -> ${JSON.stringify(res)}`);
                    return;
                }
                const res = line.kind === 'pm' ? guest.sendPm('pepe', line.text) : guest.say(line.text);
                console.log(`[pepe] guest ${line.kind} "${line.text}" -> ${JSON.stringify(res)}`);
            }, line.after);
        }
    }
}

/** Chat tap — called from World.processClientsIn() once per player chat message. */
export function tapChat(sender: NetworkPlayer | import('#/engine/entity/Player.js').default, text: string): void {
    if (brain.bots.length === 0) {
        return;
    }
    for (const bot of brain.bots) {
        // perception honesty: range + chat-mode + height-level filter
        if (sender.username === bot.player.username) {
            // Pepe's own words — record so the decision layer can see its own history
            botLog.append('chat', { from: bot.player.username, text, self: true });
            continue;
        }
        if (!Percept.canHear(bot, sender)) {
            continue;
        }
        const dist = tileDistance(bot.player, sender);
        const ev = botLog.append('chat', { from: sender.username, text, dist });
        // soul routing: interesting public chat goes to Hermes (the agent replies
        // in-game itself); consume it so the local brain does not double-answer.
        if (soulRoutingEnabled() && isInteresting(text)) {
            forwardIngameEvent('chat', sender.username, text, { dist: Math.round(dist) });
            consumeUpTo(ev.seq);
        }
    }
}

/** PM tap — called from World.sendPrivateMessage() for EVERY private message. */
export function tapPrivateMessage(sender: import('#/engine/entity/Player.js').default, targetUsername37: bigint, text: string): void {
    if (brain.bots.length === 0 || !soulRoutingEnabled()) {
        return;
    }
    const targetName = fromBase37(targetUsername37);
    for (const bot of brain.bots) {
        if (targetName !== bot.player.username) {
            continue; // not for pepe
        }
        if (sender.username === bot.player.username) {
            continue; // pepe's own outgoing PMs
        }
        // PMs are direct — always perceivable, always forwarded to the soul.
        const ev = botLog.append('chat', { from: sender.username, text, pm: true, dist: 0 });
        forwardIngameEvent('pm', sender.username, text);
        consumeUpTo(ev.seq);
    }
}

function tileDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}
