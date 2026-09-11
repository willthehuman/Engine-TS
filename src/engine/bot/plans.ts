// Pepe bot — plans as DATA. One executor for any multi-step activity:
//   plan:<name>   e.g. plan:milk
// A plan is an ordered list of goal-DSL steps (goto/find_npc/interact/use/
// item_op/gather/buy/wait — every primitive we have), stored in
// data/bot_plans.json. The steps reuse compileGoal, so plans compose the
// SAME machinery as one-shot goals; the only difference is the library grows
// by data (learn_plan action), never by new routine classes.
//
// Plan format:
//   { "milk": { "steps": ["buy:bucket@lumbridge general store",
//                         "use:bucket_empty|npc:Cow"] } }

import World from '#/engine/World.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { botLog } from './EventLog.js';
import { compileGoal } from './goals.js';
import type { BotPlayer } from './BotPlayer.js';
import type { Routine, RoutineStatus } from './routines.js';

interface Plan {
    steps: string[];
}

let PLANS: Record<string, Plan> | null = null;
function plans(): Record<string, Plan> {
    if (PLANS) return PLANS;
    PLANS = {};
    try {
        const path = 'data/bot_plans.json';
        if (existsSync(path)) {
            PLANS = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Plan>;
        }
    } catch {
        PLANS = {};
    }
    return PLANS;
}

/** Register a plan discovered/composed in-game; persists to data/bot_plans.json. */
export function learnPlan(name: string, steps: string[]): { ok: boolean; error?: string } {
    const key = name.trim().toLowerCase();
    const s = (steps ?? []).map(x => String(x).trim()).filter(Boolean);
    if (!/^[a-z0-9_-]{1,40}$/.test(key)) {
        return { ok: false, error: `bad plan name: "${key}"` };
    }
    if (!s.length) {
        return { ok: false, error: 'need at least one step' };
    }
    const routines = compileGoal(s);
    if (!routines.length) {
        return { ok: false, error: 'unparseable steps' };
    }
    plans()[key] = { steps: s };
    try {
        writeFileSync('data/bot_plans.json', JSON.stringify(plans(), null, 2));
    } catch (e: any) {
        return { ok: false, error: `persist failed: ${e.message}` };
    }
    return { ok: true };
}

/** Plan names known to the executor. */
export function planNames(): string[] {
    return Object.keys(plans());
}

/**
 * PlanRoutine: runs a named plan's steps in order with the exact goal-DSL
 * semantics. Abort reports WHICH step failed (index + verb) so the soul can
 * learn/repair the data row, not the code.
 */
export class PlanRoutine implements Routine {
    private name: string;
    private routines: Routine[] = [];
    private idx = 0;
    private startedAt = 0;

    constructor(name: string) {
        this.name = name.trim().toLowerCase();
        const plan = plans()[this.name];
        if (plan) {
            this.routines = compileGoal(plan.steps);
        }
    }

    get label(): string {
        return `PlanRoutine:${this.name}`;
    }

    step(bot: BotPlayer): RoutineStatus {
        if (this.routines.length === 0) {
            botLog.append('reflex', { kind: 'plan_fail', plan: this.name, reason: 'unknown_plan', known: planNames().join('|') });
            return 'aborted';
        }
        if (this.startedAt === 0) {
            this.startedAt = World.currentTick;
        }
        if (World.currentTick - this.startedAt > 3600) {
            botLog.append('reflex', { kind: 'plan_fail', plan: this.name, reason: 'timeout', step: this.idx });
            return 'aborted';
        }
        const r = this.routines[this.idx];
        const s = r.step(bot);
        if (s === 'done') {
            this.idx++;
            if (this.idx >= this.routines.length) {
                botLog.append('action', { action: 'plan_done', plan: this.name, steps: this.routines.length });
                return 'done';
            }
            return 'running';
        }
        if (s === 'aborted') {
            botLog.append('reflex', {
                kind: 'plan_fail',
                plan: this.name,
                reason: 'step_aborted',
                step: this.idx,
                stepText: (this.routines[this.idx] as any)?.label ?? '?'
            });
            return 'aborted';
        }
        return 'running';
    }
}
