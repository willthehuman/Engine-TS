// Pepe bot — shop buying. One generic verb for every shop in the game:
//   buy:<item>[:@<shop>]   e.g. buy:pot@Lumbridge_General_Store
// Walk to the shopkeeper, fire the Trade op (content script opens the shop),
// read the open shop's stock from the INV listener (the engine serves the
// stock over the shop_template:inv component — com 3900 in this content
// rev), then fire INV_BUTTON2 exactly like the real client's "Buy 1".
// Effect-verified: done only when the item lands in the inventory.
//
// Shops are DATA (data/bot_shops.json), grown via the learn_shop /act
// action — adding a shop never requires code.

import World from '#/engine/World.js';
import InvType from '#/cache/config/InvType.js';
import InvButton from '#/network/game/client/model/InvButton.js';
import InvButtonHandler from '#/network/game/client/handler/InvButtonHandler.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { botLog } from './EventLog.js';
import { findTarget, InteractRoutine } from './interact.js';
import { inventorySnapshot } from './use_item.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine, RoutineStatus } from './routines.js';

export interface ShopDef {
    npc: string;
    op: string | number;
    com: number; // shop stock component (shop_template:inv)
}

const BUILTIN_SHOPS: Record<string, ShopDef> = {};
let SHOPS: Record<string, ShopDef> | null = null;
function shops(): Record<string, ShopDef> {
    if (SHOPS) return SHOPS;
    SHOPS = { ...BUILTIN_SHOPS };
    try {
        const path = 'data/bot_shops.json';
        if (existsSync(path)) {
            const loaded = JSON.parse(readFileSync(path, 'utf-8'));
            for (const [name, def] of Object.entries(loaded)) {
                SHOPS[name.toLowerCase()] = def as ShopDef;
            }
        }
    } catch {
        // corrupt table: keep builtins
    }
    return SHOPS;
}

/** Register a shop discovered in-game; persists to data/bot_shops.json. */
export function learnShop(name: string, def: ShopDef): { ok: boolean; error?: string } {
    const key = name.trim().toLowerCase();
    if (!/^[a-z0-9 _-]{1,60}$/.test(key) || !def?.npc || !Number.isInteger(def.com)) {
        return { ok: false, error: 'need shop name + {npc, op, com}' };
    }
    shops()[key] = { npc: def.npc, op: def.op ?? 'trade', com: def.com };
    try {
        writeFileSync('data/bot_shops.json', JSON.stringify(shops(), null, 2));
    } catch (e: any) {
        return { ok: false, error: `persist failed: ${e.message}` };
    }
    return { ok: true };
}

/** Which shops the buy verb knows (for diagnostics / goal_help). */
export function shopNames(): string[] {
    return Object.keys(shops());
}

interface StockView {
    inv: { capacity: number; get(slot: number): { id: number; count: number } | null };
}

function stockInv(bot: BotPlayer, comId: number): StockView | null {
    const p = bot.player;
    const listener = p.invListeners.find((l: any) => l.com === comId);
    if (!listener) {
        return null;
    }
    const inv = p.getInventoryFromListener(listener);
    return inv ? ({ inv } as unknown as StockView) : null;
}

enum Phase {
    OPEN,
    WAIT_SHOP,
    FIND_ITEM,
    BUY,
    DONE
}

/**
 * BuyRoutine: buy one unit of an item from a shop. Generic across shops:
 * open via the shopkeeper's Trade op, read stock from the INV listener,
 * fire the exact client INV_BUTTON2, verify the inventory delta.
 */
export class BuyRoutine implements Routine {
    private itemQuery: string;
    private shopName: string;
    private opener: Routine | null = null;
    private phase: Phase = Phase.OPEN;
    private waitTicks = 0;
    private buyTicks = 0;
    private readonly COM = 3900; // shop_template:inv
    private startedAt = 0;
    private shopDef: ShopDef | null = null;
    private buySlot = -1;
    private buyObj = -1;
    private fireCooldown = 0;

    constructor(itemQuery: string, shopName = '') {
        this.itemQuery = itemQuery.trim().toLowerCase();
        this.shopName = shopName.trim().toLowerCase();
    }

    get label(): string {
        return `BuyRoutine:${this.itemQuery}@${this.shopName || 'nearest'}`;
    }

    step(bot: BotPlayer): RoutineStatus {
        const p = bot.player;
        if (this.startedAt === 0) {
            this.startedAt = World.currentTick;
        }
        if (World.currentTick - this.startedAt > 900) {
            return this.abort('timeout', { item: this.itemQuery, phase: Phase[this.phase] });
        }
        if (this.fireCooldown > 0) {
            this.fireCooldown--;
        }

        // Already carrying it? Effect-verified done, no work needed.
        if (this.stepWait(bot)) {
            botLog.append('action', { action: 'buy_done', item: this.itemQuery, source: 'inventory' });
            return 'done';
        }

        switch (this.phase) {
            case Phase.OPEN: {
                if (!this.opener) {
                    this.shopDef = this.resolveShopDef(bot);
                    if (!this.shopDef) {
                        return this.abort('unknown_shop', { shops: shopNames().join('|') });
                    }
                    this.opener = new InteractRoutine(this.shopDef.npc, this.shopDef.op);
                }
                const s = this.opener.step(bot);
                if (s === 'aborted') {
                    this.opener = null; // retry the open (npc may have moved)
                    return 'running';
                }
                if (stockInv(bot, this.COM)) {
                    this.phase = Phase.WAIT_SHOP;
                    this.waitTicks = 0;
                }
                return 'running';
            }
            case Phase.WAIT_SHOP: {
                if (stockInv(bot, this.COM)) {
                    this.phase = Phase.FIND_ITEM;
                    return 'running';
                }
                if (++this.waitTicks > 120) {
                    return this.abort('shop_not_open', { npc: this.shopDef?.npc ?? '?' });
                }
                return 'running';
            }
            case Phase.FIND_ITEM: {
                const st = stockInv(bot, this.COM);
                if (!st) {
                    this.phase = Phase.WAIT_SHOP;
                    return 'running';
                }
                for (let slot = 0; slot < st.inv.capacity; slot++) {
                    const item = st.inv.get(slot);
                    if (!item || item.id <= 0) continue;
                    const id = item.id;
                    const name = InvType.get(id)?.debugname?.toLowerCase() ?? '';
                    if (name.includes(this.itemQuery)) {
                        this.buySlot = slot;
                        this.buyObj = id;
                        this.phase = Phase.BUY;
                        this.buyTicks = 0;
                        botLog.append('action', { action: 'buy_found', item: name, slot, id });
                        return 'running';
                    }
                }
                return this.abort('not_in_stock', { item: this.itemQuery });
            }
            case Phase.BUY: {
                if (this.buyTicks > 60) {
                    return this.abort('buy_failed', { item: this.itemQuery, note: 'no coins / out of stock / full inv?' });
                }
                const st = stockInv(bot, this.COM);
                if (!st) {
                    return this.abort('shop_closed', { item: this.itemQuery });
                }
                if (this.fireCooldown === 0) {
                    const msg = new InvButton(2, this.buyObj, this.buySlot, this.COM);
                    const handler = new InvButtonHandler();
                    if (!handler.handle(msg, p)) {
                        return this.abort('buy_rejected', { item: this.itemQuery, slot: this.buySlot });
                    }
                    botLog.append('action', { action: 'buy_fire', item: this.itemQuery, slot: this.buySlot, id: this.buyObj });
                    this.fireCooldown = 10; // 1 buy attempt / ~6s while waiting for the effect
                }
                // effect check happens at the top of step(); the buy consumed
                // coins+stock and the item arrives within a few ticks
                this.buyTicks++;
                return 'running';
            }
            case Phase.DONE:
                return 'done';
        }
    }

    private stepWait(bot: BotPlayer): boolean {
        return inventorySnapshot(bot).some(i => i.name.toLowerCase().includes(this.itemQuery));
    }

    private resolveShopDef(bot: BotPlayer): ShopDef | null {
        if (this.shopName) {
            const direct = shops()[this.shopName];
            if (direct) return direct;
            const fuzzy = Object.entries(shops()).find(([k]) => k.includes(this.shopName));
            if (fuzzy) return fuzzy[1];
            return null;
        }
        // no shop named: nearest shop from the table via its NPC
        const p = bot.player;
        let best: ShopDef | null = null;
        let bestDist = Infinity;
        for (const def of Object.values(shops())) {
            const t = findTarget(bot, def.npc, def.op, ['npc']);
            if (!t) continue;
            const d = Math.max(Math.abs(t.x - p.x), Math.abs(t.z - p.z));
            if (d < bestDist) {
                bestDist = d;
                best = def;
            }
        }
        return best;
    }

    private abort(reason: string, extra?: Record<string, unknown>): RoutineStatus {
        botLog.append('reflex', { kind: 'buy_fail', reason, ...(extra ?? {}) });
        return 'aborted';
    }
}
