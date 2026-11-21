-- Whether a tool call's input was cut at 20 KB: kept as a JSON string of its JSON's first 20 KB. `cut` goes on saying
-- whether its tool result was cut, or, for a message, its text.
alter table transcript_entries add column tool_input_cut boolean not null default false;
