# The board is the pipeline: Steps live on Statuses

Agent work is configured by attaching a Step (a brief and a model) to a Project's Status, rather than as a fixed pipeline next to the board. A delegated Ticket entering a Status with a Step gets a Run; a Run that finishes moves the Ticket to a Status its Step allows, which either starts the next Run or waits for a User. Moving a card is how work starts, the board always shows where each Ticket is in the loop, and adding a step such as an AI code review is adding a column.

## Considered Options

- **A fixed sequence (triage, findings, implement) beside the board**: simpler to explain, but a second picture of progress next to the Statuses, and new steps need code.
