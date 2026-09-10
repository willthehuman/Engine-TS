// Pepe bot — perception honesty layer.
// Hard rule: Pepe only ever perceives what a real player standing on its tile could.
//  - public chat: only senders within hearDistance tiles on the same height level
//  - a sender whose public chat mode is HIDE (3) is never perceived
//  - other players' inventories/stats/private messages are NEVER exposed (no API for them, by design)
// hearDistance note: rev-274 clients render overhead chat across the whole 104x104 viewport;
// we deliberately use a tighter radius so Pepe feels local, not psychic. Tunable in persona.

import type Player from '#/engine/entity/Player.js';
import { ChatModePublic } from '#/engine/entity/ChatModes.js';
import type { BotPlayer } from './BotPlayer.js';

export interface NearbyPlayer {
    username: string;
    displayName: string;
    dx: number;
    dz: number;
    dist: number;
    combatLevel: number;
}

export const Percept = {
    canHear(bot: BotPlayer, sender: Player): boolean {
        if (sender.username === bot.player.username) {
            return true; // own words
        }
        if (sender.level !== bot.player.level) {
            return false; // different height level = can't see/hear
        }
        if (sender.publicChat === ChatModePublic.HIDE) {
            return false; // sender chose to hide from others
        }
        const dx = sender.x - bot.player.x;
        const dz = sender.z - bot.player.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        return dist <= bot.persona.hearDistance;
    },

    // Nearby players within perception radius (own height level only).
    nearby(bot: BotPlayer, worldPlayers: Player[]): NearbyPlayer[] {
        const out: NearbyPlayer[] = [];
        for (const p of worldPlayers) {
            if (p.username === bot.player.username || p.level !== bot.player.level) {
                continue;
            }
            const dx = p.x - bot.player.x;
            const dz = p.z - bot.player.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist <= bot.persona.hearDistance) {
                out.push({
                    username: p.username,
                    displayName: p.displayName ?? p.username,
                    dx,
                    dz,
                    dist,
                    combatLevel: p.combatLevel ?? 3
                });
            }
        }
        return out.sort((a, b) => a.dist - b.dist);
    },

    // Self snapshot — Pepe's own body is fully knowable.
    snapshot(bot: BotPlayer, nearby: NearbyPlayer[]): Record<string, unknown> {
        const p = bot.player;
        return {
            name: p.username,
            displayName: p.displayName,
            tile: { x: p.x, z: p.z, level: p.level },
            hp: { current: p.levels[3], base: p.baseLevels[3] },
            runEnergy: p.runenergy,
            playtimeTicks: p.playtime,
            brainState: bot.brainState,
            routine: bot.currentRoutineName,
            persona: bot.persona,
            nearby,
            ts: Date.now()
        };
    }
};
