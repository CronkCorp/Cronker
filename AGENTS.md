# Cronker

A simpler rewrite of Cronk (`CronkCorp/Cronk`): a self-hosted platform where humans and AI agents share Tickets, Documents, Terms, Decisions and Artifacts, and where Cronk launches agent Runs on delegated Tickets itself.

- `CONTEXT.md`: the vocabulary. Use its terms and avoid the listed synonyms.
- `docs/adr/`: decisions that are hard to reverse.
- `docs/roadmap.md`: what is settled, the milestones, and what is left out for now.
- `docs/ui.md`: how the web client looks. Read it before changing the web client.
- `docs/releasing.md`: how a version is cut; `docs/setup.md` says how installations upgrade.

The old Cronk's code and docs are a reference to copy from; where this repo's docs differ, this repo wins.

## Agent skills

`.agents/skills/` holds the skills ticket agents use (see its README); `.claude/skills/` links to them for Claude Code.

### Issue tracker

Tickets and specs live in the CRONK Project on the maintainer's Cronker, reached through the `cronk` MCP connector; code and pull requests stay on GitHub (`CronkCorp/Cronker`). See `docs/agents/issue-tracker.md`.

### Triage labels

Triage happens in Cronk itself: filed Tickets wait in the Inbox and a User delegates them. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
