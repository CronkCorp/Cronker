-- A Ticket closed as a duplicate of another (CRONK-177): stored from the duplicate (`ticket_id`) to the original
-- (`other_ticket_id`). Kept alone in its migration, since a new enum value can't be used in the transaction adding it.
alter type relation_kind add value 'duplicates';
