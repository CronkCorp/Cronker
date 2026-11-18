/** Every read of the current time goes through a Clock, so tests can control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
