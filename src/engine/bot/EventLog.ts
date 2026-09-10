// Pepe bot — append-only event log with cursor-based diff API.
// Consumers (MCP tools, heartbeat) poll with a cursor and only ever see deltas.

export interface BotEvent {
    seq: number;
    ts: number; // Date.now()
    type: 'chat' | 'attach' | 'detach' | 'action' | 'reflex' | 'admin' | 'error';
    data: Record<string, unknown>;
}

const CAP = 2000;

export class EventLog {
    private seq = 0;
    private log: BotEvent[] = [];

    append(type: BotEvent['type'], data: Record<string, unknown>): BotEvent {
        const ev: BotEvent = { seq: ++this.seq, ts: Date.now(), type, data };
        this.log.push(ev);
        if (this.log.length > CAP) {
            this.log.splice(0, this.log.length - CAP);
        }
        return ev;
    }

    since(cursor: number, cap = 200): { events: BotEvent[]; cursor: number } {
        const events = this.log.filter(e => e.seq > cursor).slice(0, cap);
        return { events, cursor: events.length > 0 ? events[events.length - 1].seq : cursor };
    }

    tail(type: BotEvent['type'] | null, n: number): BotEvent[] {
        const src = type === null ? this.log : this.log.filter(e => e.type === type);
        return src.slice(-n);
    }
}

export const botLog = new EventLog();
