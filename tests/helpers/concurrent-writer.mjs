/**
 * One concurrent ledger writer, for the plan §17 Scenario 7 test.
 *
 * Lives in a separate process on purpose: the lock exists to coordinate across
 * processes, so exercising it from several threads-of-one-process would test the
 * wrong thing. It waits on a start file so every writer is inside the contended
 * region at the same time instead of politely finishing before the next begins.
 *
 *   node concurrent-writer.mjs <commonDir> <sessionId> <index> <count> <goFile>
 *
 * Exits 0 only if every one of its own writes was accepted. A LOCK_HELD here is
 * a failure, not a tolerated outcome: `count` writers each holding the lock for
 * microseconds must not exhaust a multi-second timeout.
 */
import fs from 'node:fs';

import { Ledger } from '../../src/ledger.mjs';

const [commonDir, sessionId, index, count, goFile] = process.argv.slice(2);
const writers = Number(count);

function waitForGo(deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(goFile)) {
    if (Date.now() >= until) throw new Error('start file never appeared');
    Atomics.wait(idle, 0, 0, 1);
  }
}

const ledger = new Ledger({ commonDir, actor: `writer-${index}`, lockTimeoutMs: 60_000 });

waitForGo();

for (let n = 0; n < writers; n += 1) {
  ledger.issueTask({
    sessionId,
    packet: {
      schemaVersion: 2,
      taskId: `task:w${index}-${n}`,
      subject: `agent:fullstack-${index}`,
      role: 'fullstack',
      baseRevision: 'git:abc1234',
      readSet: ['src/**'],
      writeSet: [`src/w${index}/**`],
      inputs: [{ id: 'contract:coupon', revision: `sha256:${String(n).repeat(64).slice(0, 64)}`, authority: 'product-architect' }],
      acceptance: ['AC-1'],
      validationPlan: [
        { checkId: 'unit-tests', kind: 'command', requiredAt: ['merge'], argv: ['node', '--test', 'tests/'] },
      ],
    },
  });
}
