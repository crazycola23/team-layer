#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { roleIds, isRole, roleFile, roleVersion } from '../src/roles.mjs';
import { Ledger, LedgerError, SESSION_STATUSES, TASK_STATUSES, HANDOFF_ACTIONS } from '../src/ledger.mjs';
import { SlugError } from '../src/slug.mjs';
import { DigestError } from '../src/digest.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const SKILL_NAME = 'persistent-agent-team';
const MANAGED_START = '<!-- persistent-agent-team:managed:start -->';
const MANAGED_END = '<!-- persistent-agent-team:managed:end -->';

function die(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function writeAtomic(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function normalizeHarness(value) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'claude' || v === 'claude-code') return 'claude-code';
  if (v === 'codex') return 'codex';
  if (v === 'gemini' || v === 'gemini-cli') return 'gemini-cli';
  if (v === 'generic' || v === 'other') return 'generic';
  die(`unsupported harness ${JSON.stringify(value)}; expected claude-code, codex, gemini-cli, or generic`);
}

function agentTeamHome() {
  const configured = process.env.AGENT_TEAM_HOME;
  return path.resolve(configured || path.join(os.homedir(), '.agent-team'));
}

function skillVersion() {
  return readText(path.join(SKILL_ROOT, 'VERSION')).trim();
}

function roleFileOrDie(role) {
  try {
    return roleFile(role);
  } catch (error) {
    die(error.message);
  }
}

function roleVersionOrDie(role) {
  try {
    return roleVersion(role);
  } catch (error) {
    die(error.message);
  }
}

function assertAgentId(id) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    die('agent-id must be 3-64 lowercase letters/numbers/hyphens and start with alphanumeric');
  }
}

function assertRole(role) {
  if (!isRole(role)) die(`unsupported role ${JSON.stringify(role)}; expected ${roleIds().join(', ')}`);
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    die(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function repoInfo(repoArg) {
  const cwd = path.resolve(repoArg || '.');
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const commonDirRaw = git(['rev-parse', '--git-common-dir'], root);
  const commonDir = path.resolve(root, commonDirRaw);
  const exclude = git(['rev-parse', '--git-path', 'info/exclude'], root);
  const excludePath = path.isAbsolute(exclude) ? exclude : path.resolve(root, exclude);
  return { root, commonDir, excludePath };
}

function ensureLocalExclude(excludePath, repoRelativePath) {
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const normalized = `/${repoRelativePath.replaceAll('\\', '/')}`;
  const existing = fs.existsSync(excludePath) ? readText(excludePath) : '';
  const lines = new Set(existing.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  if (lines.has(normalized)) return;
  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludePath, `${separator}${normalized}\n`, 'utf8');
}

function upsertManagedBlock(file, body) {
  const block = `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}`;
  if (!fs.existsSync(file)) {
    writeAtomic(file, `${block}\n`);
    return;
  }
  const existing = readText(file);
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  let next;
  if (start === -1 && end === -1) {
    const sep = existing.length && !existing.endsWith('\n') ? '\n\n' : existing.length ? '\n' : '';
    next = `${existing}${sep}${block}\n`;
  } else if (start !== -1 && end !== -1 && end > start) {
    const after = end + MANAGED_END.length;
    next = `${existing.slice(0, start)}${block}${existing.slice(after)}`;
    if (!next.endsWith('\n')) next += '\n';
  } else {
    die(`managed markers are malformed in ${file}; refusing to overwrite it`);
  }
  writeAtomic(file, next);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function bootstrapText(identity) {
  const rolePath = roleFileOrDie(identity.role);
  const corePath = path.join(SKILL_ROOT, 'protocol', 'core.md');
  const recoveryPath = path.join(SKILL_ROOT, 'protocol', 'recovery.md');
  const collaborationPath = path.join(SKILL_ROOT, 'protocol', 'collaboration.md');
  const specSuitePath = path.join(SKILL_ROOT, 'protocol', 'spec-suite.md');
  return `# Persistent Agent Bootstrap\n\n` +
    `You are persistent Agent **${identity.agentId}** with role **${identity.role}**.\n\n` +
    `This identity is durable. The current harness/model is replaceable. Conversation memory is volatile.\n\n` +
    `Before substantive work:\n\n` +
    `1. Read your role manual: \`${rolePath}\`.\n` +
    `2. Read the shared core protocol: \`${corePath}\`.\n` +
    `3. On restart, compaction, or uncertain state, execute: \`${recoveryPath}\`.\n` +
    `4. In team mode, read: \`${collaborationPath}\`.\n` +
    `5. If the repository adopts spec-suite, read its installed instructions plus: \`${specSuitePath}\`.\n` +
    `6. Read current task/canonical/Git state before trusting remembered conversation.\n\n` +
    `Never invent a missing cross-agent fact. Persist decisions another Agent must rely on.\n`;
}

function identityPaths(agentId) {
  const dir = path.join(agentTeamHome(), 'agents', agentId);
  return {
    dir,
    identity: path.join(dir, 'identity.json'),
    bootstrap: path.join(dir, 'bootstrap.md'),
  };
}

function createOrRefreshIdentity(agentId, role) {
  assertAgentId(agentId);
  assertRole(role);
  const paths = identityPaths(agentId);
  const now = new Date().toISOString();
  const currentRoleVersion = roleVersionOrDie(role);
  const currentSkillVersion = skillVersion();
  let createdAt = now;
  if (fs.existsSync(paths.identity)) {
    const existing = readJson(paths.identity);
    if (existing.agentId !== agentId) die(`identity file ${paths.identity} contains a different agentId`);
    if (existing.role !== role) {
      die(`agent ${agentId} is already role ${existing.role}; role reassignment must be explicit and is not performed by setup`);
    }
    createdAt = existing.createdAt || now;
  }
  const identity = {
    schemaVersion: 1,
    agentId,
    role,
    roleVersion: currentRoleVersion,
    skill: SKILL_NAME,
    skillVersion: currentSkillVersion,
    createdAt,
    updatedAt: now,
  };
  writeJsonAtomic(paths.identity, identity);
  writeAtomic(paths.bootstrap, bootstrapText(identity));
  return { identity, ...paths };
}

function adapterInline(agentId, role, bootstrapPath) {
  return `# Persistent Agent Identity (local)\n\n` +
    `You are **${agentId}**, role **${role}**.\n` +
    `Before substantive work and after context loss, read the durable bootstrap at:\n` +
    `\`${bootstrapPath}\`\n\n` +
    `Durable task/canonical/Git state overrides remembered conversation.\n`;
}

function installAdapter({ harness, repo, agentId, role, bootstrapPath, agentDir }) {
  if (harness === 'claude-code') {
    const file = path.join(repo.root, 'CLAUDE.local.md');
    upsertManagedBlock(file, `# Persistent Agent Identity (local)\n\n@${bootstrapPath}`);
    ensureLocalExclude(repo.excludePath, 'CLAUDE.local.md');
    return { adapterPath: file, launchHint: 'Launch Claude Code normally in this worktree.' };
  }

  if (harness === 'codex') {
    const file = path.join(repo.root, 'AGENTS.override.md');
    upsertManagedBlock(file, adapterInline(agentId, role, bootstrapPath));
    ensureLocalExclude(repo.excludePath, 'AGENTS.override.md');
    return { adapterPath: file, launchHint: 'Launch Codex normally in this worktree.' };
  }

  if (harness === 'gemini-cli') {
    const file = path.join(repo.root, 'AGENT.bootstrap.md');
    upsertManagedBlock(file, `# Persistent Agent Identity (local)\n\n@${bootstrapPath}`);
    ensureLocalExclude(repo.excludePath, 'AGENT.bootstrap.md');

    const settings = path.join(agentDir, 'gemini-settings.json');
    writeJsonAtomic(settings, { context: { fileName: ['GEMINI.md', 'AGENT.bootstrap.md'] } });
    const launcher = path.join(agentDir, 'launch-gemini.sh');
    const script = `#!/usr/bin/env bash\nset -euo pipefail\nexport GEMINI_CLI_SYSTEM_SETTINGS_PATH=${shellQuote(settings)}\ncd ${shellQuote(repo.root)}\nexec gemini "$@"\n`;
    writeAtomic(launcher, script, 0o755);
    return { adapterPath: file, settingsPath: settings, launcherPath: launcher, launchHint: launcher };
  }

  const file = path.join(repo.root, 'AGENT.bootstrap.md');
  upsertManagedBlock(file, adapterInline(agentId, role, bootstrapPath));
  ensureLocalExclude(repo.excludePath, 'AGENT.bootstrap.md');
  return {
    adapterPath: file,
    launchHint: `Configure your harness to load ${file} (or ${bootstrapPath}) before substantive work.`,
  };
}

function setup(args) {
  const agentId = String(args['agent-id'] || '');
  const role = String(args.role || '');
  const harness = normalizeHarness(args.harness);
  if (!agentId) die('--agent-id is required');
  if (!role) die('--role is required');

  const repo = repoInfo(args.repo || '.');
  const state = createOrRefreshIdentity(agentId, role);
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  if (fs.existsSync(bindingPath)) {
    const existing = readJson(bindingPath);
    if (existing.agentId !== agentId && !args.force) {
      die(`worktree is already bound to ${existing.agentId}; use a different worktree or --force to replace the local binding`);
    }
  }

  const adapter = installAdapter({
    harness,
    repo,
    agentId,
    role,
    bootstrapPath: state.bootstrap,
    agentDir: state.dir,
  });

  const binding = {
    schemaVersion: 1,
    agentId,
    identityPath: state.identity,
    bootstrapPath: state.bootstrap,
    harness,
    adapterPath: adapter.adapterPath,
    worktreeRoot: repo.root,
    gitCommonDir: repo.commonDir,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(bindingPath, binding);
  ensureLocalExclude(repo.excludePath, '.agent-team-binding.json');

  console.log(JSON.stringify({
    status: 'ready',
    identity: state.identity,
    role,
    roleVersion: state.identity.roleVersion,
    harness,
    binding: bindingPath,
    adapter: adapter.adapterPath,
    launchHint: adapter.launchHint,
  }, null, 2));
}

function doctor(args) {
  const repo = repoInfo(args.repo || '.');
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!fs.existsSync(bindingPath)) {
    check('binding', false, `${bindingPath} does not exist`);
  } else {
    check('binding', true, bindingPath);
    let binding;
    try {
      binding = readJson(bindingPath);
      check('binding-json', true, `agentId=${binding.agentId}, harness=${binding.harness}`);
    } catch (error) {
      check('binding-json', false, error.message);
    }

    if (binding) {
      const identityExists = fs.existsSync(binding.identityPath);
      check('identity-file', identityExists, binding.identityPath);
      if (identityExists) {
        try {
          const identity = readJson(binding.identityPath);
          check('identity-agent', identity.agentId === binding.agentId, `identity=${identity.agentId}, binding=${binding.agentId}`);
          check('identity-role', isRole(identity.role), identity.role);
          if (isRole(identity.role)) {
            const expectedRoleVersion = roleVersionOrDie(identity.role);
            check('role-version', identity.roleVersion === expectedRoleVersion, `installed=${identity.roleVersion}, current=${expectedRoleVersion}`);
          }
          check('skill-version', identity.skillVersion === skillVersion(), `installed=${identity.skillVersion}, current=${skillVersion()}`);
          check('identity-harness-neutral', !('harness' in identity) && !('model' in identity) && !('taskId' in identity), 'identity has no harness/model/task fields');
        } catch (error) {
          check('identity-json', false, error.message);
        }
      }
      check('bootstrap-file', fs.existsSync(binding.bootstrapPath), binding.bootstrapPath);
      check('adapter-file', fs.existsSync(binding.adapterPath), binding.adapterPath);
    }
  }

  const ok = checks.every((x) => x.ok);
  console.log(JSON.stringify({ status: ok ? 'healthy' : 'unhealthy', checks }, null, 2));
  if (!ok) process.exit(2);
}

function show(args) {
  const repo = repoInfo(args.repo || '.');
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  if (!fs.existsSync(bindingPath)) die(`no binding found at ${bindingPath}`);
  const binding = readJson(bindingPath);
  const identity = readJson(binding.identityPath);
  console.log(JSON.stringify({ identity, binding }, null, 2));
}

// --------------------------------------------------------------------- ledger
// Everything below drives src/ledger.mjs. The ledger lives in the Git common
// dir, which linked worktrees share, so these commands are how three Agent
// windows on one machine see one session without any server.

/**
 * Who to record as the actor.
 *
 * The bound agent id is preferred over anything passed on the command line: an
 * audit log where the actor is whatever the caller felt like typing is not
 * evidence of anything.
 */
function actorFor(repo, args) {
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  if (fs.existsSync(bindingPath)) {
    const binding = readJson(bindingPath);
    if (binding.agentId) return `agent:${binding.agentId}`;
  }
  if (typeof args.actor === 'string') return args.actor;
  die('no agent binding found in this worktree; run `teamctl setup` first, or pass --actor for a one-off');
}

function ledgerFor(args) {
  const repo = repoInfo(args.repo || '.');
  const ledger = new Ledger({
    commonDir: repo.commonDir,
    actor: actorFor(repo, args),
    ...(args['lock-timeout'] ? { lockTimeoutMs: Number(args['lock-timeout']) } : {}),
  });
  return { repo, ledger };
}

function requireFlag(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value === '') die(`--${name} is required`);
  return value;
}

function optionalRevision(args, name = 'expect-revision') {
  if (args[name] === undefined) return null;
  const value = Number(args[name]);
  if (!Number.isInteger(value)) die(`--${name} must be an integer`);
  return value;
}

function emit(value) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Run a ledger command, translating a refusal into an exit code.
 *
 * Retryable refusals get their own code because the caller's correct response is
 * different: re-read and try again, rather than fix the input. A wrapper script
 * that cannot tell "someone else got there first" from "your packet is wrong"
 * will eventually paper over one of them.
 */
const RETRYABLE = new Set(['REVISION_CONFLICT', 'LOCK_HELD']);

function runLedger(fn) {
  try {
    fn();
  } catch (error) {
    const code = error?.code;
    if (!code || !(error instanceof LedgerError || error instanceof SlugError || error instanceof DigestError)) throw error;
    console.error(JSON.stringify({ status: 'refused', code, message: error.message, ...(error.details ? { details: error.details } : {}) }, null, 2));
    process.exit(RETRYABLE.has(code) ? 4 : 3);
  }
}

function sessionCommand(args) {
  const sub = args._[1];
  const { ledger } = ledgerFor(args);
  runLedger(() => {
    if (sub === 'start') {
      emit(ledger.createSession({
        sessionId: requireFlag(args, 'session'),
        integrationTarget: requireFlag(args, 'target'),
        canonicalProvider: typeof args.provider === 'string' ? args.provider : null,
        notes: typeof args.note === 'string' ? args.note : null,
      }));
    } else if (sub === 'list') {
      emit(ledger.listSessions().map((sessionId) => {
        const session = ledger.readSession(sessionId);
        return { sessionId, status: session.status, integrationTarget: session.integrationTarget, updatedAt: session.updatedAt };
      }));
    } else if (sub === 'show') {
      const sessionId = requireFlag(args, 'session');
      const session = ledger.readSession(sessionId);
      emit({
        session,
        tasks: ledger.listTasks(sessionId).map((taskId) => {
          const record = ledger.readTask(sessionId, taskId);
          return { taskId, status: record.state.status, generation: record.state.generation, inputSnapshotDigest: record.inputSnapshotDigest };
        }),
        // expectSeq is passed on purpose: showing a session is the cheapest
        // place to notice that the audit log has been truncated.
        events: ledger.readEvents(sessionId, { expectSeq: session.eventSeq }).length,
      });
    } else if (sub === 'set-status') {
      emit(ledger.setSessionStatus(requireFlag(args, 'session'), requireFlag(args, 'status'), {
        expectedRevision: optionalRevision(args),
        note: typeof args.note === 'string' ? args.note : null,
      }));
    } else if (sub === 'events') {
      const sessionId = requireFlag(args, 'session');
      const session = ledger.readSession(sessionId);
      const events = ledger.readEvents(sessionId, { expectSeq: session.eventSeq });
      emit(typeof args.kind === 'string' ? events.filter((event) => event.kind === args.kind) : events);
    } else {
      die('usage: teamctl session <start|list|show|set-status|events>');
    }
  });
}

function taskCommand(args) {
  const sub = args._[1];
  const { ledger } = ledgerFor(args);
  runLedger(() => {
    if (sub === 'issue' || sub === 'reissue') {
      const packet = readJson(path.resolve(requireFlag(args, 'packet')));
      const sessionId = typeof args.session === 'string' ? args.session : packet.sessionId;
      if (!sessionId) die('--session is required when the packet does not name one');
      if (sub === 'issue') {
        emit(ledger.issueTask({ sessionId, packet, expectedRevision: optionalRevision(args) }));
        return;
      }
      const record = ledger.reissueTask({
        sessionId,
        packet,
        reason: requireFlag(args, 'reason'),
        expectedGeneration: args['expect-generation'] === undefined ? null : Number(args['expect-generation']),
      });
      // Surface `unchanged` from the audit event rather than the record, because
      // it is a property of the transition and not of the task: whether anything
      // moved is only knowable by comparing against the superseded digest, which
      // the record no longer carries. It is also the answer the caller acts on —
      // a restatement that changed nothing must not trigger re-notifying an Agent
      // or discarding work in progress.
      //
      // Searched from the end because a no-op restatement leaves the generation
      // where it was, so repeated freshness checks all carry the same one and
      // only their position distinguishes them. The lock is already released by
      // now, so the last matching event is the closest thing to "ours" available.
      const event = ledger.readEvents(sessionId).findLast((e) => e.kind === 'task-reissued'
        && e.taskId === record.frozen.taskId && e.generation === record.state.generation);
      emit({
        unchanged: event?.unchanged ?? null,
        supersededDigest: event?.supersededDigest ?? null,
        record,
      });
    } else if (sub === 'show') {
      emit(ledger.readTask(requireFlag(args, 'session'), requireFlag(args, 'task')));
    } else if (sub === 'set-status') {
      emit(ledger.setTaskStatus(requireFlag(args, 'session'), requireFlag(args, 'task'), requireFlag(args, 'status'), {
        expectedRevision: optionalRevision(args),
        note: typeof args.note === 'string' ? args.note : null,
      }));
    } else {
      die('usage: teamctl task <issue|reissue|show|set-status>');
    }
  });
}

/**
 * "Where am I?" — the answer after a context loss.
 *
 * Deliberately one command with no arguments: an Agent that has just lost its
 * context cannot be expected to know the session id it was working on, so the
 * binding in the worktree is what identifies it.
 */
function status(args) {
  const { repo, ledger } = ledgerFor(args);
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  const binding = fs.existsSync(bindingPath) ? readJson(bindingPath) : null;
  const subject = binding ? `agent:${binding.agentId}` : null;

  runLedger(() => {
    const sessions = ledger.listSessions().map((sessionId) => {
      const session = ledger.readSession(sessionId);
      const tasks = ledger.listTasks(sessionId)
        .map((taskId) => ledger.readTask(sessionId, taskId))
        .filter((record) => subject === null || record.frozen.subject === subject)
        .map((record) => ({
          taskId: record.frozen.taskId,
          status: record.state.status,
          generation: record.state.generation,
          role: record.frozen.role,
          baseRevision: record.frozen.baseRevision,
          inputSnapshotDigest: record.inputSnapshotDigest,
        }));
      return { sessionId, status: session.status, integrationTarget: session.integrationTarget, tasks };
    });
    emit({
      agent: binding ? { agentId: binding.agentId, role: binding.role } : null,
      repo: { root: repo.root, commonDir: repo.commonDir },
      // Only sessions this agent has work in, unless it has no binding at all.
      sessions: sessions.filter((session) => subject === null || session.tasks.length > 0),
    });
  });
}

/**
 * The agent bound to this worktree as `{ agentId, role }`, or null if there is none.
 *
 * Kept separate from `actorFor` because a handoff needs the *role* as well as the
 * id: who published a state transfer and in what capacity are different facts, and
 * the role is what the recipient's inbox filters on.
 *
 * The role is read through the binding rather than from it. `.agent-team-binding.json`
 * deliberately does not carry one — identity.json is the single authority, and a
 * second copy here would be the copy that goes stale after `setup --role` moves an
 * agent, leaving handoffs addressed in a capacity the agent no longer holds.
 */
function bindingFor(repo) {
  const bindingPath = path.join(repo.root, '.agent-team-binding.json');
  if (!fs.existsSync(bindingPath)) return null;
  const binding = readJson(bindingPath);
  const identity = readJson(binding.identityPath);
  return { ...binding, role: identity.role };
}

/**
 * The role this worktree acts in.
 *
 * Same precedence as `actorFor`: the binding wins, and `--role` is the one-off for
 * a worktree that has none. The binding must win rather than merely be a default,
 * because both callers use this as an authorisation input — a publisher that could
 * assert any role would make `to.role` addressing meaningless, and an acknowledger
 * that could would be able to clear another role's queue.
 */
function roleFor(binding, args) {
  if (binding?.role) return binding.role;
  if (typeof args.role === 'string' && args.role !== '') return args.role;
  die('no agent binding found in this worktree; run `teamctl setup` first, or pass --role for a one-off');
}

function handoffCommand(args) {
  const sub = args._[1];
  const { repo, ledger } = ledgerFor(args);
  const binding = bindingFor(repo);
  runLedger(() => {
    if (sub === 'publish') {
      const draft = readJson(path.resolve(requireFlag(args, 'handoff')));
      const sessionId = typeof args.session === 'string' ? args.session : draft.sessionId;
      if (!sessionId) die('--session is required when the draft does not name one');
      emit(ledger.publishHandoff({ sessionId, draft, actorRole: roleFor(binding, args) }));
    } else if (sub === 'ack') {
      emit(ledger.ackHandoff({
        sessionId: requireFlag(args, 'session'),
        handoffId: requireFlag(args, 'handoff'),
        actorRole: roleFor(binding, args),
      }));
    } else if (sub === 'show') {
      const sessionId = requireFlag(args, 'session');
      if (typeof args.handoff === 'string') {
        emit(ledger.readHandoff(sessionId, args.handoff));
        return;
      }
      emit(ledger.listHandoffs(sessionId));
    } else {
      die(`unknown handoff subcommand ${sub ?? '(none)'}`);
    }
  });
}

/**
 * The queue: handoffs addressed to this worktree's agent that it has not acked.
 *
 * Takes no arguments for the same reason `status` does not — an Agent that has
 * lost its context cannot be asked which session it was working in.
 */
function inbox(args) {
  const { repo, ledger } = ledgerFor(args);
  const binding = bindingFor(repo);
  const role = roleFor(binding, args);
  runLedger(() => {
    emit(ledger.inbox({ role, subject: binding ? `agent:${binding.agentId}` : null }));
  });
}

function usage() {
  console.log(`Persistent Agent Team helper\n\n` +
    `Identity:\n` +
    `  setup  --agent-id <id> --role <${roleIds().join('|')}> --harness <claude-code|codex|gemini-cli|generic> [--repo .] [--force]\n` +
    `  doctor [--repo .]\n` +
    `  show   [--repo .]\n\n` +
    `Session ledger (in the Git common dir, so all linked worktrees share one):\n` +
    `  status                        Where am I? Sessions and tasks belonging to this worktree's agent\n` +
    `  session start      --session <id> --target <branch> [--provider spec-suite] [--note ...]\n` +
    `  session list\n` +
    `  session show       --session <id>\n` +
    `  session set-status --session <id> --status <status> [--expect-revision N] [--note ...]\n` +
    `  session events     --session <id> [--kind <event-kind>]\n` +
    `  task issue         --packet <file.json> [--session <id>] [--expect-revision N]\n` +
    `  task reissue       --packet <file.json> --reason <why> [--expect-generation N]\n` +
    `  task show          --session <id> --task <id>\n` +
    `  task set-status    --session <id> --task <id> --status <status> [--expect-revision N] [--note ...]\n\n` +
    `Handoffs (state transfer between roles, not a transcript):\n` +
    `  inbox                         What is waiting for me? Unacked handoffs addressed to this agent\n` +
    `  handoff publish    --handoff <draft.json> [--session <id>]\n` +
    `  handoff ack        --session <id> --handoff <handoff-id>\n` +
    `  handoff show       --session <id> [--handoff <handoff-id>]\n\n` +
    `  next action:    ${HANDOFF_ACTIONS.join(', ')}\n` +
    `  session status: ${SESSION_STATUSES.join(', ')}\n` +
    `  task status:    ${TASK_STATUSES.join(', ')}\n\n` +
    `Exit codes:\n` +
    `  0 ok   1 usage error   2 unhealthy (doctor)   3 ledger refused   4 refused but retryable (re-read, retry)\n\n` +
    `Environment:\n` +
    `  AGENT_TEAM_HOME   Durable identity root (default ~/.agent-team)\n`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || command === 'help' || args.help) {
  usage();
  process.exit(0);
}
if (command === 'setup') setup(args);
else if (command === 'doctor') doctor(args);
else if (command === 'show') show(args);
else if (command === 'status') status(args);
else if (command === 'session') sessionCommand(args);
else if (command === 'task') taskCommand(args);
else if (command === 'handoff') handoffCommand(args);
else if (command === 'inbox') inbox(args);
else die(`unknown command ${command}`);
