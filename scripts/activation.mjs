#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  activationDecision, CONTINUITY_VALUES, WORK_VALUES, ActivationError,
} from '../src/activation.mjs';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)}`);
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

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    die(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    die(`${file} is missing or invalid JSON: ${error.message}`);
  }
}

function bindingFor(repo) {
  const bindingPath = path.join(repo, '.agent-team-binding.json');
  if (!fs.existsSync(bindingPath)) return null;
  const local = readJson(bindingPath);
  if (typeof local.identityPath !== 'string' || local.identityPath === '') {
    die(`${bindingPath} has no identityPath`);
  }
  const identity = readJson(local.identityPath);
  return { agentId: identity.agentId, role: identity.role };
}

function usage() {
  console.log(`Identity activation advisor\n\n` +
    `Usage:\n` +
    `  node scripts/activation.mjs [--repo .] [--continuity <${CONTINUITY_VALUES.join('|')}>] [--work <${WORK_VALUES.join('|')}>]\n\n` +
    `This command never creates or changes an identity. It only says whether an unbound window\n` +
    `should stay ephemeral or suggest one durable role. Existing bindings always win.\n\n` +
    `continuity:\n` +
    `  one-off     No meaningful value in resuming this responsibility later\n` +
    `  persistent  The work should survive compaction/restarts/future sessions\n` +
    `  unknown     Persistence value has not been established (default)\n\n` +
    `work:\n` +
    `  product         WHAT / WHY / acceptance / shared-boundary ownership\n` +
    `  implementation  Local implementation HOW / tested candidate ownership\n` +
    `  review          Independent correctness decision on an existing candidate\n` +
    `  mixed           More than one role owns the current request\n` +
    `  unknown         Ownership is not clear enough to persist (default)\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const cwd = path.resolve(typeof args.repo === 'string' ? args.repo : '.');
const repo = git(['rev-parse', '--show-toplevel'], cwd);
const binding = bindingFor(repo);

try {
  const decision = activationDecision({
    binding,
    continuity: typeof args.continuity === 'string' ? args.continuity : 'unknown',
    work: typeof args.work === 'string' ? args.work : 'unknown',
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    ...decision,
    observed: {
      bound: binding !== null,
      continuity: typeof args.continuity === 'string' ? args.continuity : 'unknown',
      work: typeof args.work === 'string' ? args.work : 'unknown',
    },
  }, null, 2));
} catch (error) {
  if (error instanceof ActivationError) die(`${error.code}: ${error.message}`);
  throw error;
}
