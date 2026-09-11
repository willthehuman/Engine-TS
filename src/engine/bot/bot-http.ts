// Pepe bot — HTTP control surface. 127.0.0.1 only, no firewall rule ever.
// Endpoints: /health /state /events?cursor= /chat-tail?n= POST /act /admin/*

import fastify from 'fastify';

import { brain } from './bot.js';
import { botLog } from './EventLog.js';
import { Percept } from './Percept.js';
import { compileGoal } from './goals.js';
import { CombatTrainRoutine } from './combat.js';
import { InteractRoutine } from './interact.js';
import { UseItemRoutine, inventorySnapshot, ItemOpRoutine } from './use_item.js';
import { currentDialog, resetDialog } from './dialog.js';
import { resolveDialogChoice, dialogChoicePending } from './dialog.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { findPath } from '#/engine/GameMap.js';
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
            canAccess: bot.player.canAccess(),
            targetValid: (() => {
                try {
                    return bot.player.validateTarget();
                } catch {
                    return null;
                }
            })(),
            apRange: bot.player.apRange,
            targetOp: bot.player.targetOp,
            waypoints: bot.player.waypointIndex !== -1,
            protect: bot.player.protect,
            delayed: bot.player.delayed
        };
        const pp = bot.player;
        const SKILL_NAMES = [
            'attack',
            'defence',
            'strength',
            'hitpoints',
            'ranged',
            'prayer',
            'magic',
            'cooking',
            'woodcutting',
            'fletching',
            'fishing',
            'firemaking',
            'crafting',
            'smithing',
            'mining',
            'herblore',
            'agility',
            'thieving',
            'stat18',
            'stat19',
            'runecraft'
        ];
        snap.skills = {};
        for (let si = 0; si < SKILL_NAMES.length && si < pp.levels.length; si++) {
            // baseLevels = true level; levels[] is the drainable current level.
            // stats[] stores xp x10 (decimal-point trick) — report real xp.
            (snap.skills as Record<string, unknown>)[SKILL_NAMES[si]] = { level: pp.baseLevels[si], xp: Math.floor(pp.stats[si] / 10) };
        }
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

    app.get('/route', async req => {
        // pathing probe: can Pepe walk to x,z? Returns staged-hop breakdown so
        // callers (soul included) can see WHERE a route breaks, not just that it does.
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const q = req.query as Record<string, string>;
        const x = Number(q.x);
        const z = Number(q.z);
        if (!Number.isInteger(x) || !Number.isInteger(z)) {
            return { error: 'need integer x,z' };
        }
        const p = bot.player;
        const legs: { from: [number, number]; to: [number, number]; steps: number; ok: boolean }[] = [];
        let cx = p.x;
        let cz = p.z;
        for (let i = 0; i < 8; i++) {
            const dx = x - cx;
            const dz = z - cz;
            const dist = Math.max(Math.abs(dx), Math.abs(dz));
            if (dist === 0) {
                break;
            }
            const seg = Math.min(40, dist);
            const s = seg / dist;
            const tx = cx + Math.round(dx * s);
            const tz = cz + Math.round(dz * s);
            const path = findPath(p.level, cx, cz, tx, tz);
            const ok = !!path && path.length > 0;
            legs.push({ from: [cx, cz], to: [tx, tz], steps: ok ? path.length : 0, ok });
            if (!ok) {
                break;
            }
            // advance along the interpolated line (approximation of staged walking)
            cx = tx;
            cz = tz;
        }
        const reached = legs.length > 0 && legs[legs.length - 1].ok && legs[legs.length - 1].to[0] === x && legs[legs.length - 1].to[1] === z;
        return { from: { x: p.x, z: p.z }, to: { x, z }, reached, legs };
    });

    // graceful shutdown: orderly logout (flushes player saves + waits for the
    // login server to confirm) then process.exit(0). Restart procedure MUST use
    // this and wait for the process to exit — SIGKILL/Stop-Process -Force skips
    // the flush and vaporizes everything since the last autosave (the 2026-09-10
    // rollback reports). Takes ~15-30s (logout-flush confirm cycle).
    app.post('/shutdown', async () => {
        World.rebootTimer(0);
        return { ok: true, note: 'orderly shutdown started; wait for process exit before relaunching' };
    });

    app.get('/inventory', async () => {
        const bot = getBot();
        if (!bot) {
            return { error: 'no bot attached' };
        }
        const rows = inventorySnapshot(bot);
        return {
            count: rows.length,
            free_slots: (bot.player.invs.get(InvType.INV)?.capacity ?? 28) - rows.length,
            items: rows
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
            case 'friend_add': {
                const res = bot.addFriend(String(args.target ?? args.user ?? ''));
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
            case 'interact': {
                const query = String(args.target ?? args.query ?? '').trim();
                const op = args.op === undefined ? 1 : typeof args.op === 'number' ? args.op : String(args.op);
                if (!query) {
                    return { action, ok: false, reason: 'no_target' };
                }
                bot.clearRoutines();
                bot.enqueue(new InteractRoutine(query, op as string | number));
                return { action, ok: true, target: query, op: String(op) };
            }
            case 'use_item': {
                const item = String(args.item ?? '').trim();
                const on = String(args.on ?? '').trim();
                if (!item || !on) {
                    return { action, ok: false, reason: 'need_item_and_target' };
                }
                const onKind = String(args.kind ?? 'loc')
                    .trim()
                    .toLowerCase();
                const kind = (['item', 'loc', 'npc', 'obj'].includes(onKind) ? onKind : 'loc') as 'item' | 'loc' | 'npc' | 'obj';
                bot.clearRoutines();
                bot.enqueue(new UseItemRoutine(item, kind, on));
                return { action, ok: true, item, on, kind };
            }
            case 'item_op': {
                const item = String(args.item ?? '').trim();
                const op = String(args.op ?? '').trim();
                if (!item || !op) {
                    return { action, ok: false, reason: 'need_item_and_op' };
                }
                bot.clearRoutines();
                bot.enqueue(new ItemOpRoutine(item, op));
                return { action, ok: true, item, op };
            }
            case 'dialog_pick': {
                const comId = Number(args.comId);
                if (!Number.isInteger(comId)) {
                    return { action, ok: false, reason: 'need_comId' };
                }
                const pending = dialogChoicePending();
                if (!pending) {
                    return { action, ok: false, reason: 'nothing_pending' };
                }
                const ok = resolveDialogChoice(comId);
                return { action, ok, comId, pending };
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
