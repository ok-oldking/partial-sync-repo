const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSyncList } = require('../sync-list');

test('normalizes line endings and surrounding whitespace', () => {
    assert.deepEqual(
        parseSyncList('src\r\nok\n pyappify \rassets\r\n\r\n'),
        ['src', 'ok', 'pyappify', 'assets'],
    );
});
