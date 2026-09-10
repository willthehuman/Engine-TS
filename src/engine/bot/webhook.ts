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

import { botLog } from './EventLog.js';

const URL = (process.env.PEPE_WEBHOOK_URL ?? '').trim();
const SECRET = (process.env.PEPE_WEBHOOK_SECRET ?? '').trim();

export function soulRoutingEnabled(): boolean {
    return URL.length > 0 && SECRET.length > 0;
}

export function forwardIngameEvent(kind: 'pm' | 'chat', from: string, text: string, extra: Record<string, unknown> = {}): void {
    if (!soulRoutingEnabled()) {
        return;
    }

    const payload = { kind, from, text, ts: Date.now(), ...extra };
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
