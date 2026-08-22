# Generic Harness Adapter

A harness adapter only needs to guarantee one property:

> At Agent start/resume, the model receives a tiny instruction that identifies the Agent and
> points it to the durable bootstrap before substantive work.

## Preferred mechanisms

Use the first mechanism your harness supports:

1. per-worktree local instruction file;
2. per-process/system-prompt append file;
3. per-Agent config directory/home;
4. startup hook that injects/reads `AGENT.bootstrap.md`;
5. explicit first message from your external harness.

`teamctl setup --harness generic` creates an untracked worktree `AGENT.bootstrap.md` that
points to the durable Agent bootstrap.

## Adapter contract

An adapter must not:

- redefine the role;
- copy volatile task state into stable identity;
- become the source of project truth;
- silently grant tools/capabilities;
- require the role to be tied to one model/vendor.

It may include harness-specific tool/permission configuration, but that remains binding
metadata outside the stable identity.
