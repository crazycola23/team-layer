# Identity Protocol

## Purpose

Persistent identity exists so a context window can be destroyed without destroying who an
Agent is.

## Stable record

Default location:

```text
$AGENT_TEAM_HOME/agents/<agentId>/identity.json
```

where `AGENT_TEAM_HOME` defaults to `~/.agent-team`.

Identity contains stable semantics only:

<!-- validate: identity.schema.json -->
```json
{
  "schemaVersion": 1,
  "agentId": "fullstack-01",
  "role": "fullstack",
  "roleVersion": "1.0.0",
  "skill": "persistent-agent-team",
  "skillVersion": "0.1.0",
  "createdAt": "2026-02-14T09:12:03.117Z",
  "updatedAt": "2026-02-14T09:12:03.117Z"
}
```

`createdAt` and `updatedAt` are part of the stable object rather than session state because they
describe the identity itself: when this Agent came into existence, and when its role or skill
version last changed. Neither moves when a conversation ends.

Do not encode model, provider, harness, current worktree, branch, or current task into the
stable identity object. Those are bindings/session state.

## Worktree binding

Each worktree gets an untracked:

```text
.agent-team-binding.json
```

which may contain:

```json
{
  "schemaVersion": 1,
  "agentId": "fullstack-01",
  "identityPath": "/home/me/.agent-team/agents/fullstack-01/identity.json",
  "bootstrapPath": "/home/me/.agent-team/agents/fullstack-01/bootstrap.md",
  "harness": "codex"
}
```

The harness field is **binding metadata**, not identity.

## Bootstrap

`bootstrap.md` is deliberately short. It establishes:

- agentId and role;
- paths to the current role/core protocol;
- recovery rule;
- instruction to prefer durable state over remembered conversation.

It is safe to regenerate when the skill or role version changes.

## Reassignment

Changing harness/model does not change identity.

Changing role is a real reassignment. Do not silently rewrite `role` in an existing identity.
Create an explicit reassignment/migration process so audit/history can distinguish:

```text
same Agent, new body        → bind another harness
same Agent, upgraded manual → refresh version
same Agent, new job         → explicit role reassignment
new Agent                   → new agentId
```

## Security/privacy

Identity files should contain role/configuration data, not secrets, API keys, passwords, or
personal credentials. Tool/harness credentials remain in their native secure configuration.
