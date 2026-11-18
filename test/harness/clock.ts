import type { Clock } from "../../server/clock.js";

/** A clock that only moves when the test says so. */
export class TestClock implements Clock {
  #now: Date;

  constructor(start = new Date("2026-01-01T09:00:00Z")) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

export const days = (n: number) => n * 24 * 60 * 60 * 1000;
export const hours = (n: number) => n * 60 * 60 * 1000;
