# Set up Cronk's routines for Cronker

You are Claude Code, run by the User to set up the claude.ai routines that Cronk (https://cronk.example.com) fires for the Project
**Cronker** (`CRONK`). Cronk never holds a claude.ai credential: you create the routines
here, with your `RemoteTrigger` tool, on the User's own account, and report their trigger ids back to Cronk.

Follow these steps in order. Tell the User what you do as you go. Never reuse, change or delete a routine that
already exists, except the one you create in step 2 yourself. If a step fails, stop and tell the User why.

## 1. Choose the cloud environment

Every routine runs in a claude.ai cloud environment, and claude.ai refuses a routine without an `environment_id`.
Ask the User which environment to use. Recommend one kept for Cronk's routines: the Transcript hook's token goes
into its variables (step 5), so every session in it can act as the Agent **claude-max**.

Offer the User's environments by name, never asking them to find an id:

- Load your built-in `schedule` skill with your `Skill` tool, only to read two lists from it: the account's
  environments with their ids, and the account's claude.ai connectors with their `connector_uuid`, which step 2
  needs. Follow these instructions, not the skill's own steps, and create nothing through it.
- You may also `list` the User's routines with `RemoteTrigger` and name the environments they use.
- If the User wants a new environment for Cronk, ask them to create it in Claude Code on the web
  (https://claude.ai/code), then list the environments again to find its id.
- Only if none of these finds the environment the User wants, ask them for its id.

Use the chosen environment's id (`env_…`) as `<ENVIRONMENT_ID>` below.

## 2. Find the Cronk connector

Each routine gets only the Cronk connector, given in `mcp_connections`, which needs the connector's
`connector_uuid`. Look for it in this order:

- The connectors your `schedule` skill listed in step 1: use the `connector_uuid` of the one whose URL is
  `https://cronk.example.com/mcp` as `<CRONK_CONNECTOR_UUID>`.
- Otherwise `list` the User's routines with `RemoteTrigger`. If one has an `mcp_connections` entry whose `url`
  is `https://cronk.example.com/mcp`, use its `connector_uuid`.
- If none has, create the first routine below **without** its `mcp_connections` field. claude.ai then attaches
  every connector the User has connected. `get` it, take the `connector_uuid` of the connection whose `url` is
  `https://cronk.example.com/mcp`, and at once `update` that routine so its `mcp_connections` holds only the Cronk entry, as below.
  If no attached connection has that `url`, the User hasn't added Cronk to claude.ai as a connector: stop, and
  ask them to add it (Settings → Connectors, a custom connector named `Cronk` at `https://cronk.example.com/mcp`) and run this again.

## 3. Create the routines

Create these 3 routines with `RemoteTrigger`'s `create`, one per model label
Cronker's board uses. Send each body exactly as given, with `<ENVIRONMENT_ID>`,
`<CRONK_CONNECTOR_UUID>` and `<A FRESH UUID>` (a new random UUID for each) filled in. Each has no schedule (Cronk
fires it), only the Project's Repository, only the Cronk connector, and a `claude/…` branch prefix, so each
fire starts on a branch of its own. Note each routine's trigger id (`trig_…`) from the answer.

### haiku: claude-haiku-5-5

```json
{
  "name": "Cronk · Cronker · haiku",
  "cron_expression": "",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "<ENVIRONMENT_ID>",
      "events": [
        {
          "data": {
            "message": {
              "role": "user",
              "content": "You are started by Cronk. The text this session was fired with is a Brief from Cronk,\nwhere this Repository's work is planned. Follow its instructions:\nreach Cronk through the Cronk connector, work on the Ticket it names, and end by\ncalling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.\nIf the session was started without a Brief, stop without doing anything."
            },
            "parent_tool_use_id": null,
            "session_id": "",
            "type": "user",
            "uuid": "<A FRESH UUID>"
          }
        }
      ],
      "session_context": {
        "model": "claude-haiku-5-5",
        "allowed_tools": [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch"
        ],
        "sources": [
          {
            "git_repository": {
              "url": "https://github.com/cronkcorp/cronker"
            }
          }
        ],
        "outcomes": [
          {
            "git_repository": {
              "git_info": {
                "repo": "cronkcorp/cronker",
                "branches": ["claude/cronk-cronk-haiku"]
              }
            }
          }
        ]
      }
    }
  },
  "mcp_connections": [
    {
      "connector_uuid": "<CRONK_CONNECTOR_UUID>",
      "name": "Cronk",
      "url": "https://cronk.example.com/mcp",
      "permitted_tools": []
    }
  ]
}
```

### sonnet: claude-sonnet-5-5

```json
{
  "name": "Cronk · Cronker · sonnet",
  "cron_expression": "",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "<ENVIRONMENT_ID>",
      "events": [
        {
          "data": {
            "message": {
              "role": "user",
              "content": "You are started by Cronk. The text this session was fired with is a Brief from Cronk,\nwhere this Repository's work is planned. Follow its instructions:\nreach Cronk through the Cronk connector, work on the Ticket it names, and end by\ncalling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.\nIf the session was started without a Brief, stop without doing anything."
            },
            "parent_tool_use_id": null,
            "session_id": "",
            "type": "user",
            "uuid": "<A FRESH UUID>"
          }
        }
      ],
      "session_context": {
        "model": "claude-sonnet-5-5",
        "allowed_tools": [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch"
        ],
        "sources": [
          {
            "git_repository": {
              "url": "https://github.com/cronkcorp/cronker"
            }
          }
        ],
        "outcomes": [
          {
            "git_repository": {
              "git_info": {
                "repo": "cronkcorp/cronker",
                "branches": ["claude/cronk-cronk-sonnet"]
              }
            }
          }
        ]
      }
    }
  },
  "mcp_connections": [
    {
      "connector_uuid": "<CRONK_CONNECTOR_UUID>",
      "name": "Cronk",
      "url": "https://cronk.example.com/mcp",
      "permitted_tools": []
    }
  ]
}
```

### opus: claude-opus-5-5

```json
{
  "name": "Cronk · Cronker · opus",
  "cron_expression": "",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "<ENVIRONMENT_ID>",
      "events": [
        {
          "data": {
            "message": {
              "role": "user",
              "content": "You are started by Cronk. The text this session was fired with is a Brief from Cronk,\nwhere this Repository's work is planned. Follow its instructions:\nreach Cronk through the Cronk connector, work on the Ticket it names, and end by\ncalling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.\nIf the session was started without a Brief, stop without doing anything."
            },
            "parent_tool_use_id": null,
            "session_id": "",
            "type": "user",
            "uuid": "<A FRESH UUID>"
          }
        }
      ],
      "session_context": {
        "model": "claude-opus-5-5",
        "allowed_tools": [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch"
        ],
        "sources": [
          {
            "git_repository": {
              "url": "https://github.com/cronkcorp/cronker"
            }
          }
        ],
        "outcomes": [
          {
            "git_repository": {
              "git_info": {
                "repo": "cronkcorp/cronker",
                "branches": ["claude/cronk-cronk-opus"]
              }
            }
          }
        ]
      }
    }
  },
  "mcp_connections": [
    {
      "connector_uuid": "<CRONK_CONNECTOR_UUID>",
      "name": "Cronk",
      "url": "https://cronk.example.com/mcp",
      "permitted_tools": []
    }
  ]
}
```

## 4. Report the trigger ids back to Cronk

Once every routine is created, send all their trigger ids to Cronk in one request. This setup works once: it makes
each a trigger of the User's Runner for Cronker, waiting for its token, in place of the Project's earlier
ones.

```sh
curl -fsS -X POST 'https://cronk.example.com/api/runner-setups/cronk_runner_setup_…/triggers' \
  -H 'content-type: application/json' \
  -d '{"triggers": [{"label": "haiku", "triggerId": "<trig_… of haiku>"}, {"label": "sonnet", "triggerId": "<trig_… of sonnet>"}, {"label": "opus", "triggerId": "<trig_… of opus>"}]}'
```

If Cronk refuses it, show the User its answer.

## 5. Tell the User what is left

claude.ai keeps no environment variables on a routine, and has no documented way to make a routine's token, so tell
the User, in this order:

1. The routines you created, each with its link, `https://claude.ai/code/routines/<trig_…>`.
2. For each, to open that link, generate an API token for it, and paste the token into the trigger waiting for it on
   the Runner's card in Cronk (https://cronk.example.com/runners). Generating a new token revokes the routine's previous one.
3. To add the Transcript hook token below to the variables of the environment they chose, as one line:

   ```
   CRONK_TOKEN=cronk_agent_…
   ```

   It is claude-max's token, listed on its page in Cronk as *Transcript hook · Cronker*, where
   revoking it stops only the hook. Show it to the User only; never write it into a file or the Repository.
4. To give that environment **Full** network access, or add `cronk.example.com` to its **Limited** allowlist,
   so the hook can reach Cronk.
5. If the Repository has no `.claude/settings.json` running Cronk's Transcript hook yet, to commit this snippet as
   `.claude/settings.json` in cronkcorp/cronker, merging it into any hooks already there:

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "f=\"${TMPDIR:-/tmp}/cronk-transcript-hook.mjs\"; curl -fsS 'https://cronk.example.com/hooks/transcript.mjs' -o \"$f.part\" && mv \"$f.part\" \"$f\"; if [ -s \"$f\" ]; then CRONK_URL='https://cronk.example.com' node \"$f\"; else echo \"Cronk's Transcript hook: couldn't fetch https://cronk.example.com/hooks/transcript.mjs\" >&2; fi; exit 0",
               "timeout": 60
             }
           ]
         }
       ],
       "PostToolUse": [
         {
           "matcher": "*",
           "hooks": [
             {
               "type": "command",
               "command": "f=\"${TMPDIR:-/tmp}/cronk-transcript-hook.mjs\"; [ -s \"$f\" ] || { curl -fsS 'https://cronk.example.com/hooks/transcript.mjs' -o \"$f.part\" && mv \"$f.part\" \"$f\"; }; if [ -s \"$f\" ]; then CRONK_URL='https://cronk.example.com' node \"$f\"; else echo \"Cronk's Transcript hook: couldn't fetch https://cronk.example.com/hooks/transcript.mjs\" >&2; fi; exit 0",
               "timeout": 15
             }
           ]
         }
       ]
     }
   }
   ```
