# Gemini CLI Adapter

Gemini CLI supports hierarchical context files and configurable `context.fileName`. The main
challenge for a persistent multi-worktree team is keeping individual identity local without
clobbering a tracked project `GEMINI.md`.

## Helper strategy

`teamctl setup --harness gemini-cli` creates:

- worktree-local, untracked `AGENT.bootstrap.md` importing the durable Agent bootstrap;
- Agent-home `gemini-settings.json` containing:

```json
{
  "context": {
    "fileName": ["GEMINI.md", "AGENT.bootstrap.md"]
  }
}
```

- Agent-home launcher `launch-gemini.sh` that sets `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to that
  Agent-specific settings file and executes `gemini`.

This keeps any project `GEMINI.md` active while adding the local identity only to this Agent.

## Alternative

If your harness already owns Gemini settings/launch, configure `context.fileName` to include a
worktree-local identity context file and have that file import/read the durable bootstrap.

## Do not

- overwrite a tracked project `.gemini/settings.json` just to install identity;
- replace the project `GEMINI.md` with an individual persona;
- make the identity record itself Gemini-specific.
