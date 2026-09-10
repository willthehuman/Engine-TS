// Pepe bot — HTTP control surface. 127.0.0.1 only, no firewall rule ever.
// Endpoints: /health /state /events?cursor= /chat-tail?n= POST /act /admin/*

import fastify from 'fastify';

import { brain } from './bot.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import { compileGoal } from './goals.js';
import { CombatTrainRoutine } from './combat.js';
import { currentDialog, resetDialog } from './dialog.js';
import ScriptState from '#/engine/script/ScriptState.js';
import World from '#/engine/World.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import ParamType from '#/cache/config/ParamType.js';
import Npc from '#/engine/entity/Npc.js';
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
            targetName: bot.player.target && bot.player.target instanceof Npc ? (NpcType.get(bot.player.target.type)?.name ?? null) : null,
            targetHp: bot.player.target && bot.player.target instanceof Npc ? bot.player.target.levels[3] : null,
            hasInteraction: bot.player.hasInteraction(),
            waypoints: bot.player.waypointIndex !== -1,
            protect: bot.player.protect,
            delayed: bot.player.delayed
        };
        const pp = bot.player;
        snap.skills = {
            attack: { level: pp.levels[0], xp: pp.stats[0] },
            defence: { level: pp.levels[1], xp: pp.stats[1] },
            strength: { level: pp.levels[2], xp: pp.stats[2] },
            hitpoints: { level: pp.levels[3], xp: pp.stats[3] },
            prayer: { level: pp.levels[5], xp: pp.stats[5] }
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

    app.get('/locate', async req => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const q = String((req.query as Record<string, string>).q ?? '')
            .trim()
            .toLowerCase();
        if (!q.length) {
            return { error: 'no query' };
        }
        const slug = q.replace(/\s+/g, '_');
        const limit = Math.min(Number((req.query as Record<string, string>).limit ?? 10) || 10, 30);
        const kinds = new Set(
            String((req.query as Record<string, string>).kinds ?? 'loc,npc,shop,obj')
                .toLowerCase()
                .split(',')
                .map(s => s.trim())
        );
        const p = bot.player;
        const rows: { kind: string; name: string; x: number; z: number; level: number; dist: number; detail?: string }[] = [];

        const matches = (...cands: (string | null | undefined)[]): boolean =>
            cands.some(c => {
                if (!c) return false;
                const lc = c.toLowerCase();
                return lc.includes(q) || lc.includes(slug);
            });

        // ---- NPCs (all spawned, world-wide) ----
        if (kinds.has('npc')) {
            for (const npc of World.npcs) {
                const nt = NpcType.get(npc.type);
                if (!matches(nt?.name, nt?.debugname)) continue;
                rows.push({ kind: 'npc', name: nt?.name ?? `type:${npc.type}`, x: npc.x, z: npc.z, level: npc.level, dist: Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z)) });
            }
        }

        // ---- LOCs: world-wide scan over all zones ----
        if (kinds.has('loc')) {
            for (const zone of World.gameMap.allZones()) {
                for (const loc of zone.getAllLocsSafe()) {
                    const lt = LocType.get(loc.type);
                    if (!matches(lt?.name, lt?.debugname)) continue;
                    rows.push({ kind: 'loc', name: lt?.name ?? `type:${loc.type}`, x: loc.x, z: loc.z, level: loc.level, dist: Math.max(Math.abs(loc.x - p.x), Math.abs(loc.z - p.z)) });
                }
            }
        }

        // ---- Ground item spawns ----
        if (kinds.has('obj')) {
            for (const zone of World.gameMap.allZones()) {
                for (const obj of zone.getAllObjsSafe()) {
                    const ot = ObjType.get(obj.type);
                    if (!matches(ot?.name, ot?.debugname)) continue;
                    rows.push({ kind: 'obj', name: ot?.name ?? `type:${obj.type}`, x: obj.x, z: obj.z, level: obj.level, dist: Math.max(Math.abs(obj.x - p.x), Math.abs(obj.z - p.z)) });
                }
            }
        }

        // ---- Shops: invs whose stock matches the item; owners located via owned_shop param ----
        if (kinds.has('shop')) {
            const ownedShopParam = ParamType.getId('owned_shop');
            for (let invId = 0; invId < InvType.count; invId++) {
                const inv = InvType.get(invId);
                if (!inv?.stockobj || !inv.stockobj.length) continue;
                let hitItem: string | null = null;
                let hitCount = 0;
                for (const objId of inv.stockobj) {
                    if (!objId) continue;
                    const ot = ObjType.get(objId);
                    if (matches(ot?.name, ot?.debugname)) {
                        hitItem = hitItem ?? ot?.name ?? `type:${objId}`;
                        hitCount++;
                    }
                }
                if (!hitItem) continue;
                // find owner NPC(s) currently spawned
                let placed = false;
                for (const npc of World.npcs) {
                    const nt = NpcType.get(npc.type);
                    if (!nt?.params) continue;
                    const raw = nt.params.get(ownedShopParam);
                    const ownerInv = typeof raw === 'number' ? raw : typeof raw === 'string' ? InvType.getId(raw) : -1;
                    if (ownerInv !== invId) continue;
                    rows.push({
                        kind: 'shop',
                        name: nt.name ?? `type:${npc.type}`,
                        x: npc.x,
                        z: npc.z,
                        level: npc.level,
                        dist: Math.max(Math.abs(npc.x - p.x), Math.abs(npc.z - p.z)),
                        detail: `sells ${hitItem}${hitCount > 1 ? ` (+${hitCount - 1} more match${hitCount > 2 ? 'es' : ''})` : ''} at the ${String(nt.params.get(ParamType.getId('shop_title')) ?? inv.debugname ?? 'shop')}`
                    });
                    placed = true;
                }
                if (!placed && matches(inv.debugname)) {
                    rows.push({ kind: 'shop', name: inv.debugname ?? `inv:${invId}`, x: -1, z: -1, level: p.level, dist: 9999, detail: 'shop exists but its owner is not currently spawned' });
                }
            }
        }

        rows.sort((a, b) => a.dist - b.dist);
        return { query: q, pepe_at: { x: p.x, z: p.z }, total: rows.length, results: rows.slice(0, limit) };
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
            case 'pm': {
                const res = bot.sendPm(String(args.to ?? ''), String(args.text ?? ''));
                return { action, ...res };
            }
            case 'follow': {
                const res = bot.followPlayer(String(args.user ?? ''));
                return { action, ...res };
            }
            case 'stop': {
                return { action, ...bot.stop() };
            }
            case 'train': {
                const npc = String(args.npc ?? '').trim();
                if (!npc) {
                    return { action, ok: false, reason: 'no_npc' };
                }
                const kills = Number(args.kills ?? 0);
                bot.clearRoutines();
                bot.enqueue(new CombatTrainRoutine(npc, Number.isFinite(kills) && kills > 0 ? Math.round(kills) : 0));
                return { action, ok: true, npc, kills: kills > 0 ? kills : 'endless' };
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
