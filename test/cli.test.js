import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACCEPTED_FLAGS, HELP, checkEnvironment, parseEvolveArgs } from '../src/evolve/cli.js';
import { UserError } from '../src/util/userError.js';

test('--help documents every flag the parser accepts', () => {
  const missing = ACCEPTED_FLAGS.filter((flag) => !HELP.includes(`--${flag}`));
  assert.deepEqual(missing, []);
});

test('bad input is a UserError naming the problem and the fix, not a stack trace', () => {
  const cases = [
    [[], /no collection CSV/],
    [['a.csv', '--bogus'], /unknown option --bogus/],
    [['a.csv', '--population', 'abc'], /--population must be a non-negative integer/],
    [['a.csv', '--curated-ratio', '2'], /--curated-ratio must be a number in \[0,1\]/],
    [['a.csv', '--config', 'no-such-file.json'], /cannot read --config/],
  ];
  for (const [argv, message] of cases) {
    assert.throws(() => parseEvolveArgs(argv), (err) => err instanceof UserError && message.test(err.message) && !!err.fix);
  }
});

test('checkEnvironment rejects a missing collection and an unsupported cp', () => {
  assert.throws(() => checkEnvironment('no-such.csv', { cp: 1500, cup: 'all' }), /collection file not found/);
  assert.throws(() => checkEnvironment('fixtures/sample-pokegenie.csv', { cp: 999, cup: 'all' }), (e) => e instanceof UserError);
  checkEnvironment('fixtures/sample-pokegenie.csv', { cp: 1500, cup: 'all' });
});
