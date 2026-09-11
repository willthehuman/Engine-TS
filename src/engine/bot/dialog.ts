// Pepe bot — dialog capture. Dialog text/option buttons stream to the client via
// Player.write(IfSetText/IfOpenChat...), which no-ops for Pepe's NullClientSocket.
// We intercept writes at the BotPlayer level: bot.ts patches pepe.write to sniff
// dialog-relevant messages and keep a rolling "current dialog" snapshot.
//
// Option buttons: scripts call IF_ADDRESUMEBUTTON (component ids land in
// player.resumeButtons) and IF_SETTEXT each button's label. We record the
// comId->text map as IfSetText passes through, then resolve options against
// the live resumeButtons list.

import IfSetText from '#/network/game/server/model/IfSetText.js';
import IfOpenChat from '#/network/game/server/model/IfOpenChat.js';
import IfClose from '#/network/game/server/model/IfClose.js';
import MessageGame from '#/network/game/server/model/MessageGame.js';

export interface DialogOption {
    comId: number;
    text: string;
}

export interface DialogSnapshot {
    openedAt: number;
    lines: string[]; // narrative text lines (non-button components)
    textByCom: Map<number, string>; // comId -> latest text set on that component
}

let current: DialogSnapshot | null = null;
let unreachable = false;

/**
 * Strategist dialog callback (questing unlock). When the soul routes a dialog
 * choice, talk.ts forwards the options via webhook and parks here waiting for
 * the agent's pick (via /act dialog_pick). Single slot — one bot, one dialog.
 */
let pendingSig: string | null = null;
let pendingPick: number | null = null;

/** Park the current options page, awaiting the soul's pick. Idempotent per sig. */
export function requestDialogChoice(sig: string): boolean {
    if (pendingSig === sig) {
        return false; // already forwarded
    }
    pendingSig = sig;
    pendingPick = null;
    return true;
}

/** Agent's answer: the comId to click (must still be among resumeButtons).
 * Pass the callback sig back: a pick for a SUPERSEDED page is rejected as 'stale'
 * instead of hijacking the current page (two runs answering one dialog). */
export function resolveDialogChoice(comId: number, expectedSig?: string): 'ok' | 'stale' | 'nothing_pending' {
    if (!pendingSig) {
        return 'nothing_pending';
    }
    if (expectedSig && expectedSig !== pendingSig) {
        return 'stale';
    }
    pendingPick = comId;
    return 'ok';
}

/** Consume the pick if it answers the given dialog page, else null. */
export function consumeDialogChoice(sig: string): number | null {
    if (pendingSig !== sig || pendingPick === null) {
        return null;
    }
    const pick = pendingPick;
    pendingSig = null;
    pendingPick = null;
    return pick;
}

/** Drop a stale request (timeout fallback / dialog closed). */
export function clearDialogChoice(): void {
    pendingSig = null;
    pendingPick = null;
}

export function dialogChoicePending(): string | null {
    return pendingSig;
}

/** Called from the write-intercept in bot.ts for every ServerGameMessage Pepe "sends". */
export function captureDialogText(msg: unknown): void {
    if (msg instanceof MessageGame) {
        if (msg.msg.includes("can't reach")) {
            unreachable = true;
        }
        return;
    }
    if (msg instanceof IfSetText) {
        if (!current) {
            current = { openedAt: Date.now(), lines: [], textByCom: new Map() };
        }
        const clean = msg.text.replace(/@\w+@/g, '').replace(/\\n/g, ' ').trim();
        if (clean.length === 0) {
            return;
        }
        current.textByCom.set(msg.component, clean);
        // chatbox narrative components (large negative ids / roots) — keep a flat tail too
        current.lines.push(clean);
        if (current.lines.length > 40) {
            current.lines.shift();
        }
    } else if (msg instanceof IfOpenChat) {
        current = { openedAt: Date.now(), lines: [], textByCom: new Map() };
    } else if (msg instanceof IfClose) {
        current = null;
    }
}

export function resetDialog(): void {
    current = null;
}

export function wasUnreachable(): boolean {
    return unreachable;
}

export function clearDialogFlags(): void {
    unreachable = false;
}

/** Resolve the current dialog's clickable options from the player's resumeButtons. */
export function currentDialog(resumeButtons: number[]): (DialogSnapshot & { options: DialogOption[] }) | null {
    if (!current) {
        return null;
    }
    const options: DialogOption[] = [];
    for (const comId of resumeButtons) {
        const text = current.textByCom.get(comId);
        if (text) {
            options.push({ comId, text });
        }
    }
    return { ...current, options };
}
