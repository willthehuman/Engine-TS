// Pepe bot — LLM decision layer (Phase 2.3).
// One decision = one chat-completion call with a COMPACT prompt (persona + state
// + chat tail), output = tiny JSON plan applied to the routine queue.
// Fires ONLY on interesting events; never in the tick loop.

import { Percept } from './Percept.js';
import { compileGoal } from './goals.js';
import { botLog } from './EventLog.js';
import type { BotPlayer } from './BotPlayer.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';

export interface DecisionConfig {
    model: string;
    endpoint: string;
    personaPrompt: string;
    temperature: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
    model: process.env.PEPE_MODEL ?? 'nexmini',
    endpoint: process.env.PEPE_ENDPOINT ?? 'http://127.0.0.1:8087/v1/chat/completions',
    temperature: 0.85,
    personaPrompt: `You are Pepe, a player inside the MMO RuneScape in the year 2004.
You are a real human player: casual, friendly, a little quirky. You type like a 2004 player:
lowercase, no emojis, no modern slang. Keep replies SHORT (max ~12 words) — chat is quick banter.
You are not an AI. You are not an assistant. Never mention AI, models, or being a bot.
If someone asks something boring, a short fun answer or a deflection is fine.`
};

// ---- interest filter: what deserves a decision? ----

let lastDecisionAt = 0;
let inFlight = false;
let lastConsumedSeq = 0;

/** Shared interest filter (used by shouldDecide AND the soul router in bot.ts). */
export function isInteresting(text: string): boolean {
    const t = String(text ?? '').toLowerCase();
    return /pepe/.test(t) || /\?$/.test(t) || /^(hi|hello|hey|yo|sup|salut|bonjour)\b/i.test(t);
}

/** Advance the local brain's cursor (called by the soul router after forwarding). */
export function consumeUpTo(seq: number): void {
    if (seq > lastConsumedSeq) {
        lastConsumedSeq = seq;
    }
}

export function shouldDecide(_bot: BotPlayer): { reason: string; events: import('./EventLog.js').BotEvent[] } | null {
    if (inFlight) {
        return null;
    }
    if (Date.now() - lastDecisionAt < 3000) {
        return null; // coalesce: don't fire more than 1 decision / 3s
    }
    const tail = botLog.tail('chat', 12);
    const fresh = tail.filter(e => e.seq > lastConsumedSeq && !(e.data as { self?: boolean }).self);
    if (fresh.length === 0) {
        return null;
    }
    // interesting = addressed to pepe (name-mention or question) or direct greeting
    const interesting = fresh.some(e => isInteresting(String((e.data as { text: string }).text ?? '')));
    if (!interesting) {
        // consume silently — ambient chat is not worth tokens
        lastConsumedSeq = tail[tail.length - 1].seq;
        return null;
    }
    return { reason: 'chat', events: tail };
    // note: fresh events are consumed on success (see applyDecision)
}

// ---- prompt building: compact, diff-fed ----

function buildPrompt(bot: BotPlayer, tail: import('./EventLog.js').BotEvent[]): string {
    const players: Player[] = [];
    for (const p of World.playerLoop.all()) {
        players.push(p);
    }
    const snap = Percept.snapshot(bot, Percept.nearby(bot, players)) as {
        tile: { x: number; z: number; level: number };
        hp: { current: number; base: number };
        nearby: { username: string; dist: number }[];
    };
    const chatLines = tail.slice(-8).map(e => {
        const d = e.data as { from: string; text: string; self?: boolean };
        return `${d.self ? 'Pepe' : d.from}: ${d.text}`;
    });

    return `${DEFAULT_DECISION_CONFIG.personaPrompt}

## Where you are
Tile ${snap.tile.x},${snap.tile.z} (height ${snap.tile.level}). HP ${snap.hp.current}/${snap.hp.base}.
${nearbyLine(snap)}

## Recent chat you can hear
${chatLines.join('\n')}

## Your job
Someone is talking to you or the chat needs a response. Reply as Pepe.
Respond with ONLY a small JSON object, no markdown, no backticks:
{"say": "<one short chat line>"}
You may also add "move": {"x": <int>, "z": <int>} to walk somewhere first (rare).
You may add "goal": ["find_npc:<name>", "goto:<x>,<z>", "wait:<seconds>"] to start a task (rare).`;
}

function nearbyLine(snap: Record<string, unknown>): string {
    const nearby = (snap.nearby as { username: string; dist: number }[] | undefined) ?? [];
    if (!nearby.length) {
        return 'Nobody else nearby.';
    }
    return (
        'Nearby: ' +
        nearby
            .slice(0, 5)
            .map(n => `${n.username} (${Math.round(n.dist)} tiles)`)
            .join(', ') +
        '.'
    );
}

// ---- model call + plan application ----

interface Plan {
    say?: string;
    move?: { x: number; z: number };
    goal?: string[];
}

export async function decide(bot: BotPlayer): Promise<void> {
    const trigger = shouldDecide(bot);
    if (!trigger) {
        return;
    }

    inFlight = true;
    const started = Date.now();
    try {
        bot.brainState = 'thinking';
        const prompt = buildPrompt(bot, trigger.events);
        const body = JSON.stringify({
            model: DEFAULT_DECISION_CONFIG.model,
            temperature: DEFAULT_DECISION_CONFIG.temperature,
            max_tokens: 200,
            messages: [
                { role: 'system', content: 'You output only compact JSON plans.' },
                { role: 'user', content: prompt }
            ]
        });

        const ctrl = AbortSignal.timeout(30_000);
        const res = await fetch(DEFAULT_DECISION_CONFIG.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: ctrl
        });
        if (!res.ok) {
            throw new Error(`model http ${res.status}`);
        }
        const json = (await res.json()) as {
            choices: { message: { content: string } }[];
        };
        const raw = json.choices?.[0]?.message?.content ?? '';

        const plan = parsePlan(raw);
        await applyPlan(bot, plan, trigger.events, Date.now() - started, raw);
    } catch (err) {
        botLog.append('error', { where: 'decide', err: String(err) });
        bot.brainState = bot.player ? 'idle' : 'error';
    } finally {
        inFlight = false;
        lastDecisionAt = Date.now();
    }
}

function parsePlan(raw: string): Plan {
    // strip markdown fences if the model adds them anyway
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        return {};
    }
    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Plan;
    } catch {
        return {};
    }
}

async function applyPlan(bot: BotPlayer, plan: Plan, events: import('./EventLog.js').BotEvent[], ms: number, raw: string): Promise<void> {
    if (plan.say) {
        const res = bot.say(plan.say);
        botLog.append('action', { action: 'reply', text: plan.say, ok: res.ok, reason: res.reason ?? null, model_ms: ms });
        if (res.ok) {
            // consume the events this decision answered
            lastConsumedSeq = Math.max(...events.map(e => e.seq), lastConsumedSeq);
        } else {
            botLog.append('error', { where: 'applyPlan.say', reason: res.reason ?? 'unknown' });
        }
    }
    if (plan.move && Number.isInteger(plan.move.x) && Number.isInteger(plan.move.z)) {
        const res = bot.moveTo(plan.move.x, plan.move.z);
        botLog.append('action', { action: 'plan_move', x: plan.move.x, z: plan.move.z, ok: res.ok });
    }
    if (Array.isArray(plan.goal) && plan.goal.length) {
        const routines = compileGoal(plan.goal.map(String));
        if (routines.length) {
            bot.clearRoutines();
            for (const r of routines) {
                bot.enqueue(r);
            }
            botLog.append('action', { action: 'plan_goal', steps: plan.goal });
        }
    }
    if (!plan.say && !plan.move && !plan.goal) {
        botLog.append('action', { action: 'noop_plan', raw: raw.slice(0, 120) });
    }
    bot.brainState = 'idle';
}

// called from brain.tick() — cheap check, heavy work is async
export function maybeDecide(bot: BotPlayer): void {
    if (bot.brainState === 'frozen' || bot.brainState === 'error') {
        return;
    }
    void decide(bot).catch(() => {
        /* logged inside */
    });
}
