// Pepe bot — in-game → Hermes soul routing (Phase 5).
// Forwards direct PMs and 'interesting' public chat to the pepe profile's
// Hermes webhook, which wakes the agent (same profile = same soul/memory/tools
// as the room). The agent replies IN-GAME via mcp__pepe__pm / mcp__pepe__say,
// and its room-facing line lands in the #pepe room.
//
// Fire-and-forget: never blocks the tick loop. No-op when unconfigured.
// Signature: Generic V2 — X-Webhook-Signature-V2 = hex HMAC-SHA256("<ts>.<body>")
// with X-Webhook-Timestamp (integer seconds).

import crypto from 'crypto';
import fs from 'fs';

import { botLog } from './EventLog.js';

const URL = (process.env.PEPE_WEBHOOK_URL ?? '').trim();
const SECRET = (process.env.PEPE_WEBHOOK_SECRET ?? '').trim();
// test-harness mute: touch D:\lostcity\.nostrategist to silence soul wakes
// (notices) during manual mechanics tests without touching chat/PM routing.
const MUTE_FILE = 'D:/lostcity/.nostrategist';

export function soulRoutingEnabled(): boolean {
    return URL.length > 0 && SECRET.length > 0;
}

export function noticesMuted(): boolean {
    try {
        return fs.existsSync(MUTE_FILE);
    } catch {
        return false;
    }
}

export function forwardIngameEvent(kind: 'pm' | 'chat', from: string, text: string, extra: Record<string, unknown> = {}): void {
    // Batch rapid same-sender messages into ONE wake: without this, "yo" / "yo pepe" /
    // "hey" typed in 10s spawns 3 agent runs that queue on the model, answer minutes
    // late, and each stale run answers anyway (the 'repeats'). 12s window, max 5.
    // Engine notices (forwardNotice) deliberately bypass this — dialog/quest
    // callbacks are time-sensitive and must wake the soul immediately.
    const key = kind + '' + from.toLowerCase();
    let b = pendingBatches.get(key);
    if (!b) {
        b = { kind, from, texts: [], extra: {}, timer: setTimeout(() => flushBatch(key), CHAT_BATCH_MS) };
        pendingBatches.set(key, b);
    }
    b.texts.push(text);
    Object.assign(b.extra, extra); // latest extras (e.g. dist) win
    if (b.texts.length >= CHAT_BATCH_MAX) {
        clearTimeout(b.timer);
        flushBatch(key);
    }
}

const CHAT_BATCH_MS = 2_000; // Will 2026-09-10: responsiveness over burst-catch
const CHAT_BATCH_MAX = 5;
interface PendingBatch {
    kind: 'pm' | 'chat';
    from: string;
    texts: string[];
    extra: Record<string, unknown>;
    timer: ReturnType<typeof setTimeout>;
}
const pendingBatches = new Map<string, PendingBatch>();

function flushBatch(key: string): void {
    const b = pendingBatches.get(key);
    if (!b) {
        return;
    }
    pendingBatches.delete(key);
    const text = b.texts.length === 1 ? b.texts[0] : b.texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
    postWebhook({ kind: b.kind, from: b.from, text, ts: Date.now(), batched: b.texts.length, ...b.extra });
}

/**
 * Strategist notices: engine-side events the Hermes soul should decide on —
 * train_done (incl. aborts), death, level_up, train_retreat, unreachable paths.
 * Same wake path as player chat (one subscription); payload kind 'notice' with a
 * human-readable text so the existing prompt handles it. Fire-and-forget.
 */
export function forwardNotice(text: string, extra: Record<string, unknown> = {}): void {
    postWebhook({ kind: 'notice', from: 'engine', text, ts: Date.now(), ...extra });
}

/** One-line summary for a notable bot-log event, or null when not notable. */
export function summarizeNotable(ev: { type: string; data: Record<string, unknown> }): string | null {
    const d = ev.data;
    if (ev.type === 'action' && d.action === 'train_done') {
        const bits: string[] = [`${d.kills ?? 0} kills`];
        if (d.defence_xp) bits.push(`+${d.defence_xp} def xp`);
        if (d.prayer_xp) bits.push(`+${d.prayer_xp} prayer xp`);
        if (d.hitpoints_xp) bits.push(`+${d.hitpoints_xp} hp xp`);
        return `Training session ended (${d.reason ?? '?'}): ${bits.join(', ')} vs ${d.target ?? '?'}, hp ${d.hp ?? '?'}.`;
    }
    if (ev.type === 'action' && d.action === 'level_up') {
        return `Pepe leveled ${d.skill ?? '?'} to ${d.level ?? '?'}!`;
    }
    if (ev.type === 'action' && d.action === 'goal_superseded') {
        // Both involved runs already know (the superseder acted; the superseded sees
        // the event). No wake — a wake here spawns a third rival.
        return null;
    }
    if (ev.type === 'action' && d.action === 'goal_done') {
        // Only failures wake the soul: the acting run watches events and sees its own
        // completion. Forwarding 'done' wakes a rival run that sets a new goal, whose
        // completion wakes another run... (2026-09-11: self-sustaining Diango loop.)
        if ((d.outcome ?? 'done') !== 'aborted') {
            return null;
        }
        const steps = Array.isArray(d.steps) ? d.steps.join('; ') : '';
        return `Goal FAILED (${d.goal ?? '?'}). Steps: ${steps}. Replan or report.`;
    }
    if (ev.type === 'reflex') {
        switch (d.kind) {
            case 'death':
                return 'Pepe died and respawned. Check where he is and whether his goal still makes sense.';
            case 'train_retreat':
                return `Pepe retreated from training at low HP (${d.hp ?? '?'}). He may need food or a safer spot.`;
            case 'train_no_target':
                return `Pepe can't find any ${d.npc ?? '?'} to train on. Pick a different target or place.`;
            case 'npc_not_found':
                return `Pepe can't find ${d.npc ?? '?'} to talk to (${d.candidates ?? 0} nearby — the rest are out of range or unreachable). Walk him closer with goto() first, or pick someone visible via state.`;
            case 'interact_unreachable':
                return `Pepe can't reach the ${d.target ?? '?'} (${d.dist ?? '?'} tiles away — gate, door, fence or river in the way?). Compose a way through or pick another target. Query was '${d.query ?? '?'}'.`;
            case 'interact_no_target':
                return `Nothing matching '${d.query ?? '?'}' exists for Pepe to interact with. Try locate() for the right name.`;
            case 'item_op_failed':
                return `Pepe couldn't ${d.op ?? '?'} the ${d.item ?? '?'} (${d.reason ?? '?'}). Check inventory() and replan.`;
            case 'use_no_item':
                return `Pepe has no ${d.item ?? '?'} in his backpack. Check inventory() and replan.`;
            case 'use_no_target':
                return `Pepe can't find ${d.target ?? '?'} to use the item on. Try locate() for the right name.`;
            case 'dialog_loop':
                return `Pepe is stuck picking the same reply with ${d.npc ?? '?'} (${d.repeats ?? '?'}x) — the conversation is NOT advancing. Pick a DIFFERENT option with dialog_pick, or walk away. Do not pick the same comId again.`;
            default:
                return null;
        }
    }
    return null;
}

function postWebhook(payload: Record<string, unknown>): void {
    if (!soulRoutingEnabled()) {
        return;
    }

    // wall-clock send time so the soul can discount stale messages (a run that wakes
    // 10 min late should see the message is old, not treat it as this-second).
    payload.clock = new Date().toLocaleTimeString('en-US', { hour12: false });

    const kind = String(payload.kind ?? '?');
    const from = String(payload.from ?? '?');
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto
        .createHmac('sha256', SECRET)
        .update(ts + '.' + body)
        .digest('hex');

    void fetch(URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Timestamp': ts,
            'X-Webhook-Signature-V2': sig
        },
        body,
        signal: AbortSignal.timeout(10_000)
    })
        .then(res => {
            botLog.append('action', { action: 'soul_forward', kind, from, ok: res.ok, status: res.status });
        })
        .catch(err => {
            botLog.append('error', { where: 'soul_forward', kind, from, err: String(err).slice(0, 200) });
        });
}
