const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id from a request could be a record's id; anything else answers as if it didn't exist. */
export function isUuid(id: string): boolean {
  return uuid.test(id);
}
