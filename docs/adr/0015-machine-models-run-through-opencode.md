# Machine models run through OpenCode and never fall back to Claude

A `local` Runner can run Steps on models other than Claude, such as gpt-oss or Qwen: to spare a Claude subscription's limits, to keep work away from Anthropic, to use Cronk with no Anthropic account, or to pick a model with other restrictions. Its Machine's config lists its **Machine models**, each with a server's address, a model id, a context size and optionally a key. The Runner's Owner maps model labels to them on the Runner, so boards keep their labels, other Users' Runners are unaffected, and one Ticket's Steps can mix Machine models and Claude.

The daemon runs a Machine model's Runs with **OpenCode** (V2), and Claude's with Claude Code as before. The daemon announces its Machine models' names, their limits on Runs at once and whether each is up, and nothing else of them: their addresses and keys stay on the Machine, as its claude.ai sign-in does (ADR 0009, ADR 0014). A mapped label **never falls back to Claude**. While its Machine model is down, or its Machine offline, the Ticket waits; once no Machine serving the Runner has it set up, the Run is refused, saying which label to map again. A fallback would send work to Anthropic that its User chose to keep from it.

## Considered Options

- **Claude Code pointed at another server** (`ANTHROPIC_BASE_URL`). It would reuse the allowlist, Transcripts and stream format, and needs no second program. Anthropic doesn't support routing Claude Code to other models, so an upgrade could break it.
- **Codex.** It brings an OS sandbox, but its documentation names the Responses API as the only one a custom server may speak, and doesn't say that its allowlist can deny by default.
- **An agent loop of Cronk's own.** Everything under our control, and everything ours to build and keep up.
- **Model servers in the Workspace's settings.** One place for an Admin to set them up, but Cronk would hold keys and private addresses, and a label's meaning would change for every User's Runner.
- **Mapping by Agent, with no mix within a Ticket.** Simpler, but Triage couldn't run on a small model while Implement runs on Claude.

## Consequences

- OpenCode is a second program to follow: its version is checked in the preflight, its events are a third Transcript format, and the daemon configures it by `OPENCODE_CONFIG_CONTENT`, which its V2 documentation didn't mention when this was decided. Claude Code and OpenCode are each needed only on a Machine that uses them.
- The Runner's allowlist covers both programs. It is translated for OpenCode with everything unlisted denied; a rule that can't be translated is left out, never widened. A Repository's committed Claude Code settings don't add to it.
- A Machine model's Run gets a home and environment of its own, without the User's sign-ins. That guards against accidents and isn't a sandbox: a program run as the User can still read their files. Work that needs one gets a VM paired as its own Machine.
- Cronk never installs, starts or downloads models, adds no content filter, and records no cost for these Runs. A Run records the Machine model that ran it, so a label's name doesn't pass for Claude.
- *Not Anthropic* is all that is promised. A hosted API is a Machine model like any other, Cronk and GitHub hold the work as always, and other Steps of the same Ticket may run on Claude.
- A prototype on a 16 GB GPU finished all 18 Triage Runs of one clear Ticket (`qwen3.5:9b`, `gpt-oss:20b`, `qwen3-coder:30b`). Implement was barely tried, so Triage is what is recommended first.
