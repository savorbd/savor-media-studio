import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff } from './wordDiff';

test('word diff marks only the changed words', () => {
  const d = wordDiff('Date: 1 March, 2026', 'Date: 3 March, 2026 today');
  assert.deepEqual(d, [
    { t: 'eq', s: 'Date: ' }, { t: 'del', s: '1' }, { t: 'add', s: '3' }, { t: 'eq', s: ' March, 2026' }, { t: 'add', s: ' today' },
  ]);
  assert.deepEqual(wordDiff('', 'new'), [{ t: 'add', s: 'new' }]);
  assert.deepEqual(wordDiff('old', ''), [{ t: 'del', s: 'old' }]);
});
