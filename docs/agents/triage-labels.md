# Triage in Cronk

The skills speak in terms of five canonical triage roles. In the CRONK Project these are not Labels, since an Agent can't set Labels outside a Run and Cronk already has a place for each role:

| Role in mattpocock/skills | In Cronk                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| `needs-triage`            | A Discovered Ticket waiting in its Assignee's Inbox (every filed Ticket) |
| `needs-info`              | A Comment on the Ticket asking for what's missing                        |
| `ready-for-agent`         | The User delegates the Ticket to an Agent                                |
| `ready-for-human`         | The User keeps it undelegated and moves it out of Backlog                |
| `wontfix`                 | The User dismisses it, or moves it to a Canceled Status                  |

When a skill says to apply a role, file the Ticket and say in your reply which role you'd give it (for example "ready for an agent"); the User makes the change. A Ticket that needs a human can say so in its description.
