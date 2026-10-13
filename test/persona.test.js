'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, REPO_ROOT } = require('./helpers/support');

describe('loadPersona', () => {
  let sandbox;
  let loadPersona;
  let warn;

  beforeEach(() => {
    sandbox = createSandbox();
    warn = mock.method(console, 'warn', () => {});
    ({ loadPersona } = sandbox.load('src/persona.js'));
  });

  afterEach(() => {
    mock.restoreAll();
    sandbox.cleanup();
  });

  it('joins profile and knowledge under their headings, trimmed', () => {
    sandbox.write('persona/profile.md', '\n名字: 小安\n口吻: 親切\n\n');
    sandbox.write('persona/knowledge.md', '  FAQ: 營業時間 10:00-18:00  \n');

    assert.strictEqual(
      loadPersona(),
      '# Profile\n名字: 小安\n口吻: 親切\n\n# Knowledge\nFAQ: 營業時間 10:00-18:00'
    );
    assert.strictEqual(warn.mock.callCount(), 0);
  });

  it('falls back to the built-in text and warns when both files are missing', () => {
    const prompt = loadPersona();

    assert.match(prompt, /^# Profile\n名字: LINE AI 分身/);
    assert.match(prompt, /\n# Knowledge\nFAQ:\n/);
    assert.strictEqual(warn.mock.callCount(), 2);
    assert.match(String(warn.mock.calls[0].arguments[0]), /persona\/profile\.md not found/);
    assert.match(String(warn.mock.calls[1].arguments[0]), /persona\/knowledge\.md not found/);
  });

  it('only falls back for the file that is missing', () => {
    sandbox.write('persona/profile.md', '名字: 阿福');

    const prompt = loadPersona();

    assert.match(prompt, /^# Profile\n名字: 阿福\n\n# Knowledge\nFAQ:/);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /persona\/knowledge\.md not found/);
  });

  it('rethrows read errors other than "file not found"', () => {
    // A directory where the file should be: reading it fails, but not with ENOENT.
    fs.mkdirSync(sandbox.path('persona', 'profile.md'), { recursive: true });

    assert.throws(() => loadPersona(), (error) => error.code !== 'ENOENT');
  });
});

describe('shipped persona templates', () => {
  it('exist and are non-empty, so a fresh clone can start', () => {
    for (const name of ['profile.md', 'knowledge.md']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, 'persona', name), 'utf8');
      assert.ok(text.trim().length > 0, `persona/${name} is empty`);
    }
  });

  it('profile.md keeps the "名字: ..." line that the group wake-word fallback reads', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'persona', 'profile.md'), 'utf8');
    assert.match(text, /名字\s*[:：]\s*\S+/);
  });
});
