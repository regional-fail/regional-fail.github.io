// The site re-scores multi-day periods from archived totals; these must agree with the logger's own math.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyAgg, mergeAgg, score, rates } from '../logger/lib/summary.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logger', 'lib');

test('shared scoring modules are browser-safe (no Node imports)', () => {
  for (const f of ['summary.mjs', 'classify.mjs', 'rules.mjs', 'geo.mjs']) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    assert.ok(!/from ['"]node:/.test(src), `${f} imports a Node module`);
    for (const m of src.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
      assert.ok(['./classify.mjs', './rules.mjs', './geo.mjs', './summary.mjs'].includes(m[1]), `${f} imports ${m[1]}`);
    }
  }
});

test('merging two days and re-scoring equals scoring the combined totals', () => {
  const day = (ran, ghosts, onTime, lateSum, w = 1) => ({ ...emptyAgg(), due: ran + ghosts, ran, ghosts, finished: ran, on_time: onTime, late_sum: lateSum, late_max: 20,
    ghost_kinds: ghosts ? { inferred: ghosts } : {}, w_ran: ran * w, w_ghost: ghosts * w, w_finished: ran * w, w_on_time: onTime * w, w_late_sum: lateSum * w });
  const a = day(40, 2, 30, 200), b = day(35, 5, 20, 300);
  const merged = mergeAgg(a, b);
  const combined = day(75, 7, 50, 500);
  assert.deepEqual(score(merged), score(combined));
  assert.deepEqual(rates(merged), rates(combined));
  assert.deepEqual(merged.ghost_kinds, { inferred: 7 });
  assert.equal(merged.late_max, 20);
});
