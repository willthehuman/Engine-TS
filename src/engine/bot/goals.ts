// Pepe bot — goals: deterministic compiler from a goal spec to a routine queue.
// The LLM only ever produces the spec (e.g. ["goto:3221,3219", "find_npc:Hans"]);
// compilation to steps is pure code. Steps run sequentially; a failed step
// aborts the rest (Pepe goes back to wandering).

import { botLog } from './EventLog.js';
import { WalkRoutine, WaitRoutine, type Routine } from './routines.js';
import { TalkRoutine } from './talk.js';
import { CombatTrainRoutine } from './combat.js';
import { InteractRoutine } from './interact.js';
import { UseItemRoutine, ItemOpRoutine } from './use_item.js';

/**
 * Accepted step forms:
 *   goto:<x>,<z>              — walk to a tile
 *   find_npc:<name>           — walk to + talk to the nearest NPC whose name matches
 *   train:<npc>[:<kills>]     — defence-train on a nearby NPC type (e.g. train:chicken:25)
 *   interact:<target>[:<op>]  — walk to the nearest matching entity (npc/loc/obj) and
 *                               fire its op (1-based number or name, underscores =
 *                               spaces; e.g. interact:tree:chop_down, interact:hans:talk-to)
 *   use:<item>|<target>       — use an inventory item on a target: another item name,
 *                               or kind:name (loc|npc|obj) e.g. use:raw_chicken|loc:range
 *   item_op:<item>:<op>       — fire a held-item op instantly (Bury/Eat/Drop/light...)
 *   wait:<seconds>            — stand still
 */
export function compileGoal(steps: string[]): Routine[] {
    const queue: Routine[] = [];
    for (const raw of steps.slice(0, 8)) {
        const step = raw.trim().toLowerCase();
        try {
            if (step.startsWith('goto:')) {
                const [x, z] = step.slice(5).split(',').map(Number);
                if (Number.isInteger(x) && Number.isInteger(z)) {
                    queue.push(new WalkRoutine(x, z));
                    continue;
                }
            } else if (step.startsWith('find_npc:')) {
                const name = raw.trim().slice(9).trim();
                if (name.length > 0) {
                    queue.push(new TalkRoutine(name));
                    continue;
                }
            } else if (step.startsWith('train:')) {
                const parts = step.slice(6).split(':');
                const name = parts[0].trim();
                const kills = parts.length > 1 ? Number(parts[1]) : 0;
                if (name.length > 0) {
                    queue.push(new CombatTrainRoutine(name, Number.isFinite(kills) && kills > 0 ? Math.round(kills) : 0));
                    continue;
                }
            } else if (step.startsWith('interact:')) {
                const rest = raw.trim().slice(9);
                const ci = rest.indexOf(':');
                const name = (ci === -1 ? rest : rest.slice(0, ci)).trim();
                const opRaw = ci === -1 ? '1' : rest.slice(ci + 1).trim();
                const op = /^\d+$/.test(opRaw) ? Number(opRaw) : opRaw.replace(/_/g, ' ');
                if (name.length > 0) {
                    queue.push(new InteractRoutine(name, op));
                    continue;
                }
            } else if (step.startsWith('use:')) {
                const rest = raw.trim().slice(4);
                const pi = rest.indexOf('|');
                if (pi > 0) {
                    const item = rest.slice(0, pi).trim();
                    const target = rest.slice(pi + 1).trim();
                    if (item && target) {
                        const ki = target.indexOf(':');
                        if (ki > 0 && ['item', 'loc', 'npc', 'obj'].includes(target.slice(0, ki))) {
                            queue.push(new UseItemRoutine(item, target.slice(0, ki) as 'item' | 'loc' | 'npc' | 'obj', target.slice(ki + 1)));
                        } else {
                            queue.push(new UseItemRoutine(item, 'item', target));
                        }
                        continue;
                    }
                }
            } else if (step.startsWith('item_op:') || step.startsWith('use_held:')) {
                // item_op:<item>:<op> — fire a held-item op (Bury/Eat/Drop...) instantly
                const rest = raw.trim().slice(step.startsWith('item_op:') ? 8 : 9);
                const ci = rest.indexOf(':');
                if (ci > 0) {
                    const item = rest.slice(0, ci).trim();
                    const op = rest
                        .slice(ci + 1)
                        .trim()
                        .replace(/_/g, ' ');
                    if (item && op) {
                        queue.push(new ItemOpRoutine(item, op));
                        continue;
                    }
                }
            } else if (step.startsWith('wait:')) {
                const secs = Number(step.slice(5));
                if (Number.isFinite(secs) && secs > 0 && secs <= 300) {
                    queue.push(new WaitRoutine(Math.round(secs * 1.67)));
                    continue;
                }
            }
        } catch {
            // fall through: invalid step skipped
        }
        botLog.append('error', { where: 'compileGoal', step: raw, reason: 'unparseable' });
    }
    return queue;
}
