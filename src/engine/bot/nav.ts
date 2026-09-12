// Pepe bot — navigation v2: door-aware routing.
//
// The engine's findPath refuses closed doors/gates, so door-heavy routes
// (castle interiors, walled cities, the mill, fenced fields) failed, and the
// old fallback (walkSegment's "nearest door <= 14 tiles, try again")
// repeatedly chose wrong doors or unreachable stands.
//
// nav.ts plans the FULL route up front on a collision grid where door/gate
// tiles are passable at a COST, producing:
//   - tile waypoints (queued through the engine's normal waypoint machinery), and
//   - ORDERED crossing events (blocked tile + the loc op that frees it).
// The executor (stepNav, driven from BotPlayer.walkSegment) walks to each
// crossing, fires its op (engine exec + direct-run fallback for the rsmod
// reach-check quirks), verifies (tile freed OR player teleported through),
// then continues. One stuck crossing => blacklist + replan.

import World from '#/engine/World.js';
import LocType from '#/cache/config/LocType.js';
import { canTravel } from '#/engine/GameMap.js';
import { CollisionType } from '#/engine/routefinder/index.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import type Entity from '#/engine/entity/Entity.js';
import type { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';

export interface Crossing {
    x: number;
    z: number;
    locType: number;
    locName: string;
    opIndex: number;
    opName: string;
    tileIdx: number; // index in NavPlan.tiles of the crossing tile
}

export interface NavPlan {
    tiles: { x: number; z: number }[]; // excludes the start tile
    crossings: Crossing[]; // ordered along the path
    idx: number; // executor cursor: index of the next tile to reach
    destX: number;
    destZ: number;
    firedCross: number; // index into crossings; -1 = none in flight
    firedAt: number;
    firedTile: number; // tileIdx captured at fire time
}

const DIRS: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
];
const DOOR_COST = 30;
const MAX_QUEUE = 40;

/** Plan a door-aware route. Returns null when no route (even through doors). */
export function planRoute(level: number, sx: number, sz: number, dx: number, dz: number, blacklist: Set<string>): NavPlan | null {
    const pad = 10;
    const minX = Math.min(sx, dx) - pad;
    const maxX = Math.max(sx, dx) + pad;
    const minZ = Math.min(sz, dz) - pad;
    const maxZ = Math.max(sz, dz) + pad;
    const w = maxX - minX + 1;
    const h = maxZ - minZ + 1;
    const size = w * h;
    const idxOf = (x: number, z: number) => (x - minX) * h + (z - minZ);
    const inBox = (x: number, z: number) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;

    // ---- door/gate index inside the bbox ----
    const doorAt = new Map<number, { x: number; z: number; locType: number; locName: string; opIndex: number; opName: string }>();
    for (const zone of World.gameMap.allZones()) {
        for (const loc of zone.getAllLocsSafe()) {
            if (loc.level !== level) continue;
            if (loc.x < minX || loc.x > maxX || loc.z < minZ || loc.z > maxZ) continue;
            const lt = LocType.get(loc.type);
            const name = (lt?.name ?? '').toLowerCase();
            if (!/door|gate/.test(name)) continue;
            if (blacklist.has(loc.x + ',' + loc.z)) continue;
            const opsRaw = (lt?.op ?? []) as (string | null)[];
            let opIndex = 1;
            let opName = 'open';
            let found = false;
            for (let i = 0; i < opsRaw.length; i++) {
                const o = (opsRaw[i] ?? '').toLowerCase();
                if (!o || o === 'hidden') continue;
                opIndex = i + 1;
                opName = o;
                found = true;
                if (o.includes('open')) break;
            }
            if (!found) continue;
            const key = idxOf(loc.x, loc.z);
            if (!doorAt.has(key)) {
                doorAt.set(key, { x: loc.x, z: loc.z, locType: loc.type, locName: lt?.name ?? 'door', opIndex, opName });
            }
        }
    }

    // ---- dijkstra over the collision grid (doors = passable at a cost) ----
    const dist = new Float64Array(size).fill(Infinity);
    const prev = new Int32Array(size).fill(-1);
    const heap: number[] = [];
    const hcost: number[] = [];
    const push = (n: number, c: number) => {
        heap.push(n);
        hcost.push(c);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (hcost[p] <= hcost[i]) break;
            [heap[p], heap[i]] = [heap[i], heap[p]];
            [hcost[p], hcost[i]] = [hcost[i], hcost[p]];
            i = p;
        }
    };
    const pop = (): [number, number] => {
        const n = heap[0];
        const c = hcost[0];
        const lastN = heap.pop()!;
        const lastC = hcost.pop()!;
        if (heap.length) {
            heap[0] = lastN;
            hcost[0] = lastC;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let s = i;
                if (l < heap.length && hcost[l] < hcost[s]) s = l;
                if (r < heap.length && hcost[r] < hcost[s]) s = r;
                if (s === i) break;
                [heap[s], heap[i]] = [heap[i], heap[s]];
                [hcost[s], hcost[i]] = [hcost[i], hcost[s]];
                i = s;
            }
        }
        return [n, c];
    };

    const start = idxOf(sx, sz);
    dist[start] = 0;
    push(start, 0);
    const wanted = idxOf(dx, dz);
    while (heap.length) {
        const [n, c] = pop();
        if (c > dist[n]) continue;
        if (n === wanted) break;
        const x = minX + Math.floor(n / h);
        const z = minZ + (n % h);
        for (const [ox, oz] of DIRS) {
            const nx = x + ox;
            const nz = z + oz;
            if (!inBox(nx, nz)) continue;
            const nn = idxOf(nx, nz);
            let step = NaN;
            if (canTravel(level, x, z, ox, oz, 1, 0, CollisionType.NORMAL)) {
                step = ox !== 0 && oz !== 0 ? 1.414 : 1;
            } else if (doorAt.has(nn)) {
                step = DOOR_COST;
            }
            if (Number.isNaN(step)) continue;
            const nc = c + step;
            if (nc < dist[nn]) {
                dist[nn] = nc;
                prev[nn] = n;
                push(nn, nc);
            }
        }
    }

    // ---- destination fallback: dest tile itself may be a loc tile (blocked) ----
    let endNode = wanted;
    if (dist[endNode] === Infinity) {
        let best = -1;
        let bestC = Infinity;
        for (const [ox, oz] of DIRS) {
            const nx = dx + ox;
            const nz = dz + oz;
            if (!inBox(nx, nz)) continue;
            const nn = idxOf(nx, nz);
            if (dist[nn] < bestC) {
                bestC = dist[nn];
                best = nn;
            }
        }
        if (best === -1 || dist[best] === Infinity) return null;
        endNode = best;
    }

    // ---- extract path ----
    const rev: number[] = [];
    let n = endNode;
    while (n !== -1) {
        rev.push(n);
        n = prev[n];
    }
    rev.reverse();
    const tiles: { x: number; z: number }[] = [];
    for (let i = 1; i < rev.length; i++) {
        const nn = rev[i];
        tiles.push({ x: minX + Math.floor(nn / h), z: minZ + (nn % h) });
    }
    const crossings: Crossing[] = [];
    for (let i = 0; i < tiles.length; i++) {
        const nn = idxOf(tiles[i].x, tiles[i].z);
        const d = doorAt.get(nn);
        if (d) {
            crossings.push({ ...d, tileIdx: i });
        }
    }
    return { tiles, crossings, idx: 0, destX: dx, destZ: dz, firedCross: -1, firedAt: 0, firedTile: -1 };
}

function queueRange(p: NetworkPlayer, tiles: { x: number; z: number }[], from: number, to: number): void {
    const out: number[] = [];
    for (let i = Math.max(0, from); i <= to && i < tiles.length && out.length < MAX_QUEUE; i++) {
        out.push(CoordGrid.packCoord(p.level, tiles[i].x, tiles[i].z));
    }
    if (out.length) {
        p.queueWaypoints(Uint32Array.from(out));
    }
}

/** Fire the crossing op (engine exec + direct-run fallback). */
function fireCrossing(p: NetworkPlayer, c: Crossing): boolean {
    p.clearWaypoints();
    const loc = World.getLoc(c.x, c.z, p.level, c.locType);
    if (!loc) {
        return true; // already gone — treat as free
    }
    const trigger = ServerTriggerType.APLOC1 + (c.opIndex - 1);
    const ok = p.setInteraction(Interaction.ENGINE, loc as unknown as Entity, trigger);
    if (!ok) {
        return false;
    }
    p.opcalled = true;
    try {
        const le = loc as unknown as Entity;
        if (!p.inOperableDistance(le)) {
            const opScript = p.getOpTrigger();
            if (opScript) {
                p.runScript(ScriptRunner.init(opScript, p, le), true);
            }
        }
    } catch {
        /* engine handles it */
    }
    botLog.append('action', { action: 'nav_cross', loc: c.locName, x: c.x, z: c.z });
    return true;
}

/**
 * Advance a nav plan by one tick. Returns true while progressing (waypoints
 * queued / crossing fired / waiting on a crossing op); false when stuck.
 */
export function stepNav(bot: BotPlayer, plan: NavPlan): boolean {
    const p = bot.player;

    // track progress along the planned tiles
    while (plan.idx < plan.tiles.length && plan.tiles[plan.idx].x === p.x && plan.tiles[plan.idx].z === p.z) {
        plan.idx++;
    }
    if (plan.idx >= plan.tiles.length) {
        return true; // tail reached; callers apply their own arrival tolerance
    }

    // a crossing fire in flight: verify
    if (plan.firedCross >= 0) {
        const c = plan.crossings[plan.firedCross];
        const advanced = plan.idx > plan.firedTile;
        if (advanced || (p.x === c.x && p.z === c.z)) {
            plan.firedCross = -1;
            return true;
        }
        if (World.currentTick - plan.firedAt > 12) {
            bot.navBlacklist.add(c.x + ',' + c.z);
            botLog.append('reflex', { kind: 'nav_cross_failed', x: c.x, z: c.z, loc: c.locName });
            plan.firedCross = -1;
            bot.navPlan = null; // replan without this door
        }
        return true;
    }

    // next crossing ahead?
    const next = plan.crossings.find(c => c.tileIdx >= plan.idx);
    if (next) {
        const dist = Math.max(Math.abs(next.x - p.x), Math.abs(next.z - p.z));
        if (dist <= 1) {
            const ok = fireCrossing(p, next);
            plan.firedCross = plan.crossings.indexOf(next);
            plan.firedAt = World.currentTick;
            plan.firedTile = plan.idx;
            return ok;
        }
        if (!p.hasWaypoints()) {
            const approach = Math.max(plan.idx, next.tileIdx - 1);
            queueRange(p, plan.tiles, plan.idx, approach);
        }
        return true;
    }

    // no crossings left: walk out the rest
    if (!p.hasWaypoints()) {
        queueRange(p, plan.tiles, plan.idx, Math.min(plan.tiles.length - 1, plan.idx + MAX_QUEUE - 1));
    }
    return true;
}
