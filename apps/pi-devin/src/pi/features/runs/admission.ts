import { Deferred, Effect, Exit } from "effect";

interface Ticket {
  turn: Deferred.Deferred<void>;
  hasLeft: boolean;
}

export interface AdmissionTicket {
  /** Waits until everyone who entered earlier has left. */
  readonly turn: Effect.Effect<void>;
  /** Idempotent. Also used by a request that gives up before its turn; those behind it still wait for everyone ahead of it. */
  readonly leave: Effect.Effect<void>;
}

/** Admits one request at a time, strictly in the order they entered. A new arrival never takes a turn ahead of a waiting one. */
export class AdmissionLine {
  private readonly line: Ticket[] = [];

  enter(): AdmissionTicket {
    const ticket: Ticket = { turn: Deferred.makeUnsafe<void>(), hasLeft: false };
    this.line.push(ticket);
    if (this.line.length === 1) Deferred.doneUnsafe(ticket.turn, Exit.void);
    return {
      turn: Deferred.await(ticket.turn),
      leave: Effect.sync(() => this.leave(ticket)),
    };
  }

  private leave(ticket: Ticket): void {
    if (ticket.hasLeft) return;
    ticket.hasLeft = true;
    while (this.line[0]?.hasLeft) this.line.shift();
    const front = this.line[0];
    if (front) Deferred.doneUnsafe(front.turn, Exit.void);
  }
}
