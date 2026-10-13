'use strict';

// src/absorb.js is a CLI that runs on require, so these tests run it as a child
// process against a sandbox copy. No network, nothing outside the temp directory.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
const { createSandbox, childEnv } = require('./helpers/support');

// Fake secrets are assembled at run time so this file contains no secret-shaped literal.
const FAKE_TOKEN = ['sk', 'A1b2C3d4E5f6'].join('-');
const FAKE_PASSWORD = 'not-a-real-' + 'pw';

describe('absorb CLI', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function run(...args) {
    const result = spawnSync(process.execPath, [sandbox.path('src', 'absorb.js'), ...args], {
      cwd: sandbox.root,
      env: childEnv(),
      encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, `absorb exited with ${result.status}: ${result.stderr}`);
    return result.stdout;
  }

  function inbox(groupId, day, records) {
    const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
    sandbox.write(`data/inbox/${groupId}/${day}.jsonl`, lines.join('\n') + '\n');
  }

  const text = (t, hash) => ({ ts: '2026-01-01T00:00:00.000Z', user_hash: hash || 'abcd1234', type: 'text', text: t });
  const watermarkPath = 'data/inbox/.absorb_watermark.json';

  it('reports zero items when there is no inbox yet', () => {
    const out = run();

    assert.match(out, /^# 群組新素材（待讀清單）/);
    assert.match(out, /新素材 0 筆；PII 命中 0 筆。/);
    assert.doesNotMatch(out, /水位/);
    assert.strictEqual(sandbox.exists('data'), false, 'a read-only run must not create data/');
  });

  it('lists each kind of record by group, file and line number', () => {
    inbox('Gaaa', '2026-01-01', [
      text('週五公休\n改週六'),
      { type: 'image', user_hash: 'abcd1234', media_path: 'data/inbox/Gaaa/media/m1.jpg' },
      { type: 'image', user_hash: 'abcd1234', media_error: 'expired', message_id: '77' },
      { type: 'sticker', message_id: '9' },
      'this line is not json'
    ]);

    const out = run();

    assert.match(out, /^## 群組 Gaaa$/m);
    assert.match(out, /^### 2026-01-01$/m);
    assert.match(out, /^- L1 \[abcd1234\] 週五公休 改週六$/m, 'whitespace is collapsed');
    assert.match(out, /^- L2 \[abcd1234\] image → data\/inbox\/Gaaa\/media\/m1\.jpg$/m);
    assert.match(out, /^- L3 \[abcd1234\] image 下載失敗（message_id=77）$/m);
    assert.match(out, /^- L4 \[--------\] sticker$/m, 'unknown sender shows a placeholder');
    assert.match(out, /^- L5 （無法解析的行）$/m);
    assert.match(out, /新素材 5 筆；PII 命中 0 筆。/);
    assert.match(out, /水位未推進；讀完後加 --commit 標記為已讀。/);
  });

  it('orders groups and days alphabetically and ignores hidden folders and non-jsonl files', () => {
    inbox('Gbbb', '2026-01-02', [text('b-day2')]);
    inbox('Gbbb', '2026-01-01', [text('b-day1')]);
    inbox('Gaaa', '2026-01-01', [text('a-day1')]);
    inbox('.hidden', '2026-01-01', [text('should not appear')]);
    sandbox.write('data/inbox/Gaaa/media/m1.jpg', 'binary');
    sandbox.write('data/inbox/Gaaa/notes.txt', 'ignored');

    const out = run();

    const order = ['a-day1', 'b-day1', 'b-day2'].map((needle) => out.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), 'all three lines are listed');
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    assert.doesNotMatch(out, /should not appear/);
    assert.match(out, /新素材 3 筆/);
  });

  describe('PII screen', () => {
    // One line per pattern, screened in a single run (each run is a child process).
    const cases = [
      ['CRED', `password: ${FAKE_PASSWORD}`],
      ['CRED', `密碼：${FAKE_PASSWORD}`],
      ['TOKEN', `key is ${FAKE_TOKEN}`],
      ['TOKEN', 'Bearer abcdefghij0123456789'],
      ['TOKEN', `api_key=${FAKE_PASSWORD}`],
      ['OAUTH', 'https://auth.example.com/oauth2/authorize?x=1'],
      ['OAUTH', 'https://app.example.com/cb?access_token=abc'],
      ['EMAIL', 'mail me at someone@example.com'],
      ['PHONE', '打 0900-000-000 找我']
    ];

    it('flags each pattern by line and code, and masks the matching lines', () => {
      inbox('Gpii', '2026-01-01', cases.map(([, sample]) => text(sample)));

      const out = run();

      assert.match(out, /PII 快篩/);
      cases.forEach(([code], i) => {
        const n = i + 1;
        assert.match(out, new RegExp(`^- Gpii/2026-01-01\\.jsonl:${n} ${code}$`, 'm'), `line ${n}: reported as ${code}`);
        assert.match(out, new RegExp(`^- L${n} \\[abcd1234\\] （已遮蔽：${code}）$`, 'm'), `line ${n}: masked as ${code}`);
      });
      assert.match(out, new RegExp(`PII 命中 ${cases.length} 筆。`));
      for (const secret of [FAKE_PASSWORD, FAKE_TOKEN, 'someone@example.com', '0900-000-000', 'abcdefghij0123456789']) {
        assert.strictEqual(out.includes(secret), false, `${secret} leaked into the output`);
      }
    });

    it('lists every pattern one line hits, and leaves ordinary lines readable', () => {
      inbox('Gpii', '2026-01-01', [
        text('下週三公休，請改約週四'),
        text('mail someone@example.com or call 0900-000-000')
      ]);

      const out = run();

      assert.match(out, /^- L1 \[abcd1234\] 下週三公休，請改約週四$/m);
      assert.match(out, /^- Gpii\/2026-01-01\.jsonl:2 EMAIL,PHONE$/m);
      assert.match(out, /PII 命中 1 筆。/);
    });

    it('prints no PII section when nothing matches', () => {
      inbox('Gpii', '2026-01-01', [text('下週三公休，請改約週四')]);
      assert.doesNotMatch(run(), /PII 快篩/);
    });
  });

  describe('watermark', () => {
    it('does not move without --commit, so the same items show up again', () => {
      inbox('Gaaa', '2026-01-01', [text('one'), text('two')]);

      const first = run();
      const second = run();

      assert.match(first, /新素材 2 筆/);
      assert.match(second, /新素材 2 筆/);
      assert.strictEqual(sandbox.exists(watermarkPath), false);
    });

    it('--commit records how many lines were read and the next run lists only new lines', () => {
      inbox('Gaaa', '2026-01-01', [text('one'), text('two')]);

      assert.match(run('--commit'), /水位已推進（--commit）。/);
      assert.deepStrictEqual(JSON.parse(sandbox.read(watermarkPath)), { 'Gaaa/2026-01-01.jsonl': 2 });
      assert.match(run(), /新素材 0 筆/);

      fs.appendFileSync(sandbox.path('data/inbox/Gaaa/2026-01-01.jsonl'), JSON.stringify(text('three')) + '\n');
      inbox('Gaaa', '2026-01-02', [text('next day')]);
      const out = run();

      assert.match(out, /新素材 2 筆/);
      assert.match(out, /^- L3 \[abcd1234\] three$/m, 'numbering continues where the last read stopped');
      assert.match(out, /^- L1 \[abcd1234\] next day$/m);
      assert.doesNotMatch(out, /- L[12] \[abcd1234\] (one|two)$/m);
    });

    it('--commit with no inbox at all still writes a valid, empty watermark', () => {
      run('--commit');
      assert.deepStrictEqual(JSON.parse(sandbox.read(watermarkPath)), {});
    });
  });

  describe('--group', () => {
    it('shows one group and leaves the others out', () => {
      inbox('Gaaa', '2026-01-01', [text('from-a')]);
      inbox('Gbbb', '2026-01-01', [text('from-b')]);

      const only = run('--group', 'Gbbb');

      assert.match(only, /from-b/);
      assert.doesNotMatch(only, /from-a/);
      assert.match(only, /新素材 1 筆/);
    });

    it('does not advance the watermark of groups it skipped', () => {
      inbox('Gaaa', '2026-01-01', [text('from-a')]);
      inbox('Gbbb', '2026-01-01', [text('from-b')]);

      run('--group', 'Gbbb', '--commit');
      const rest = run();

      assert.match(rest, /from-a/);
      assert.doesNotMatch(rest, /from-b/);
    });

    it('an unknown group is simply empty', () => {
      inbox('Gaaa', '2026-01-01', [text('from-a')]);
      assert.match(run('--group', 'Gnope'), /新素材 0 筆/);
    });
  });
});
