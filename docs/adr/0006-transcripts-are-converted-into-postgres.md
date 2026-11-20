# Transcripts are converted into one format in Postgres

A Transcript arrives either as Claude Code's JSONL, uploaded by the Transcript hook, or as Managed Agents session events, fetched by Cronk. Cronk converts both on arrival into one list of entries (role, text, tool name and input, tool result, time) stored in Postgres, scrubbing known secret patterns first, and keeps no raw file. One format gives one Transcript view and one search index whatever the source, and a backup stays the database plus the Attachments directory. Long tool results are cut at 20 KB and a Transcript past 50 MB keeps its start and end, so Transcripts can't swell the database.

## Considered Options

- **Raw files in the Attachments directory**, parsed when shown or searched: lossless and cheap to write, but every reader would handle two formats, and search would have to parse files.
- **Both raw files and entries**: a lossless download, at twice the storage and a second place where a missed secret lives. Left out until someone needs the raw file.

## Consequences

- A new source of Transcripts needs a converter, and a format change in Claude Code's JSONL or the Managed Agents events needs the converter changed; Transcripts already stored keep their entries.
