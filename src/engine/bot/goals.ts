// Pepe bot — goals: deterministic compiler from a goal spec to a routine queue.
// The LLM only ever produces the spec (e.g. ["goto:3221,3219", "find_npc:Hans"]);
// compilation to steps is pure code. Steps run sequentially; a failed step
// aborts the rest (Pepe goes back to wandering).

import { WalkRoutine, WaitRoutine, type Routine } from './routines.js';
import { TalkRoutine } from './talk.js';
import { CombatTrainRoutine } from './combat.js';
import { InteractRoutine } from './interact.js';
import { UseItemRoutine, ItemOpRoutine } from './use_item.js';
import { GatherRoutine, gatherItems } from './gather.js';

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
 *   gather:<item>             — effect-verified gathering from the known source
 *                               (egg; milk/flour once shop-buy lands). Sources
 *                               are data, see data/bot_sources.json.
 */
/** Single-line DSL grammar. THE reference: errors and goal_help print this. */
export const GOAL_FORMS = 'goto:x,z | find_npc:name | train:npc[:kills] | interact:target[:op] | use:item|target | item_op:item:op | wait:sec | gather:item';

const KNOWN_VERBS = ['goto', 'find_npc', 'train', 'interact', 'use', 'item_op', 'use_held', 'wait', 'gather'];

/** One-line correction for a bad step, or the bare grammar when nothing matches. */
export function suggestStep(raw: string): string {
    const step = raw.trim();
    const ci = step.indexOf(':');
    const verb = (ci === -1 ? step : step.slice(0, ci)).trim().toLowerCase();
    const arg = (ci === -1 ? '' : step.slice(ci + 1)).trim();
    if (KNOWN_VERBS.includes(verb)) {
        // right verb, bad args (e.g. goto:Lumbridge bank)
        if (verb === 'goto') {
            return `"${step}" invalid — goto needs x,z tiles ("goto:3222,3216"); locate the place first`;
        }
        return `"${step}" invalid args — forms: ${GOAL_FORMS}`;
    }
    if (['talk', 'speak', 'chat', 'meet', 'visit'].includes(verb) && arg) {
        return `"${step}" invalid — try "find_npc:${arg}"`;
    }
    if (['go', 'walk', 'move', 'run', 'travel', 'head'].includes(verb)) {
        if (/^-?\d+\s*,\s*-?\d+$/.test(arg)) {
            return `"${step}" invalid — try "goto:${arg.replace(/\s+/g, '')}"`;
        }
        return `"${step}" invalid — goto needs x,z tiles; locate the place first`;
    }
    if (['kill', 'attack', 'fight'].includes(verb) && arg) {
        return `"${step}" invalid — try "train:${arg}"`;
    }
    if (['buy', 'sell', 'bank', 'cook', 'mine', 'chop', 'fish', 'open', 'take'].includes(verb)) {
        return `"${step}" invalid — try "interact:${arg || step}"`;
    }
    if (verb === 'gather') {
        const known = gatherItems().join('|');
        return arg ? `"${step}" invalid — unknown item; can gather: ${known}` : `"${step}" invalid — needs an item (gather:egg)`;
    }
    return `"${step}" invalid — forms: ${GOAL_FORMS}`;
}

export interface CompiledGoal {
    routines: Routine[];
    /** Compact, capped (3 + overflow count). Empty when all steps parsed. */
    errors: string[];
}

/** Verbose compile: routines + terse per-step diagnostics. */
/** Parse one step; null when invalid (caller reports via suggestStep). */
function parseStep(raw: string): Routine | null {
    const step = raw.trim().toLowerCase();
    try {
        if (step.startsWith('goto:')) {
            const [x, z] = step.slice(5).split(',').map(Number);
            if (Number.isInteger(x) && Number.isInteger(z)) {
                return new WalkRoutine(x, z);
            }
        } else if (step.startsWith('find_npc:')) {
            const name = raw.trim().slice(9).trim();
            if (name.length > 0) {
                return new TalkRoutine(name);
            }
        } else if (step.startsWith('train:')) {
            const parts = step.slice(6).split(':');
            const name = parts[0].trim();
            const kills = parts.length > 1 ? Number(parts[1]) : 0;
            if (name.length > 0) {
                return new CombatTrainRoutine(name, Number.isFinite(kills) && kills > 0 ? Math.round(kills) : 0);
            }
        } else if (step.startsWith('interact:')) {
            const rest = raw.trim().slice(9);
            const ci = rest.indexOf(':');
            const name = (ci === -1 ? rest : rest.slice(0, ci)).trim();
            const opRaw = ci === -1 ? '1' : rest.slice(ci + 1).trim();
            const op = /^\d+$/.test(opRaw) ? Number(opRaw) : opRaw.replace(/_/g, ' ');
            if (name.length > 0) {
                return new InteractRoutine(name, op);
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
                        return new UseItemRoutine(item, target.slice(0, ki) as 'item' | 'loc' | 'npc' | 'obj', target.slice(ki + 1));
                    }
                    return new UseItemRoutine(item, 'item', target);
                }
            }
        } else if (step.startsWith('item_op:') || step.startsWith('use_held:')) {
            const rest = raw.trim().slice(step.startsWith('item_op:') ? 8 : 9);
            const ci = rest.indexOf(':');
            if (ci > 0) {
                const item = rest.slice(0, ci).trim();
                const op = rest
                    .slice(ci + 1)
                    .trim()
                    .replace(/_/g, ' ');
                if (item && op) {
                    return new ItemOpRoutine(item, op);
                }
            }
        } else if (step.startsWith('wait:')) {
            const secs = Number(step.slice(5));
            if (Number.isFinite(secs) && secs > 0 && secs <= 300) {
                return new WaitRoutine(Math.round(secs * 1.67));
            }
        } else if (step.startsWith('gather:')) {
            const item = raw.trim().slice(7).trim();
            if (item.length > 0) {
                return new GatherRoutine(item);
            }
        }
    } catch {
        return null;
    }
    return null;
}

/** Verbose compile: routines + terse per-step diagnostics (capped). No botLog spam. */
export function compileGoalVerbose(steps: string[]): CompiledGoal {
    const routines: Routine[] = [];
    const errors: string[] = [];
    let bad = 0;
    for (const raw of steps.slice(0, 8)) {
        const r = parseStep(raw);
        if (r) {
            routines.push(r);
            continue;
        }
        bad++;
        if (errors.length < 3) {
            errors.push(suggestStep(raw));
        }
    }
    if (bad > errors.length) {
        errors.push(`(+${bad - errors.length} more bad steps)`);
    }
    return { routines, errors };
}

export function compileGoal(steps: string[]): Routine[] {
    return compileGoalVerbose(steps).routines;
}
