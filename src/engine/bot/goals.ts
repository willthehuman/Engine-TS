// Pepe bot — goals: deterministic compiler from a goal spec to a routine queue.
// The LLM only ever produces the spec (e.g. ["goto:3221,3219", "find_npc:Hans"]);
// compilation to steps is pure code. Steps run sequentially; a failed step
// aborts the rest (Pepe goes back to wandering).

import { botLog } from './EventLog.js';
import { WalkRoutine, WaitRoutine, type Routine } from './routines.js';
import { TalkRoutine } from './talk.js';

/**
 * Accepted step forms:
 *   goto:<x>,<z>          — walk to a tile
 *   find_npc:<name>       — walk to + talk to the nearest NPC whose name matches
 *   wait:<seconds>        — stand still
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
