/** Whether a Ticket's key or title contains the needle, which is already trimmed and lower-cased. */
export function matchesText(ticket: { key: string; title: string }, needle: string): boolean {
  return ticket.key.toLowerCase().includes(needle) || ticket.title.toLowerCase().includes(needle);
}
