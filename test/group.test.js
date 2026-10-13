'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const line = require('@line/bot-sdk');
const { spawnSync } = require('node:child_process');
const { createSandbox, isolateEnv, installFetch, childEnv } = require('./helpers/support');

const PERSONA = '# Profile\n- 名字: 小安\n';
const TOKEN = 'test-token-not-real';

// Local noon, so the expected file name does not depend on the machine's time zone.
const WHEN = new Date(2026, 0, 15, 12, 0, 0);
const DAY_FILE = '2026-01-15.jsonl';

const textEvent = (text, extra) => ({
  type: 'message',
  timestamp: WHEN.getTime(),
  source: { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' },
  message: { type: 'text', id: 'm1', text },
  ...extra
});

const mediaEvent = (message) => ({
  type: 'message',
  timestamp: WHEN.getTime(),
  source: { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' },
  message
});

describe('group feed', () => {
  let sandbox;
  let restoreEnv;
  let net;
  let group;
  let download;

  const handle = (event, persona) => group.handleGroupEvent(event, { persona: persona === undefined ? PERSONA : persona, channelAccessToken: TOKEN });
  const inboxLines = (groupDir, file) => fs.readFileSync(sandbox.path('data', 'inbox', groupDir, file || DAY_FILE), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // A media file another program holds open, as on Windows (viewer, sync client, antivirus):
  // deleting it fails with EBUSY until the returned release() is called. Every other rm goes through.
  const holdOpen = (name) => {
    const realRm = fsp.rm;
    let held = true;
    mock.method(fsp, 'rm', (target, options) => (held && String(target).endsWith(name)
      ? Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${target}'`), { code: 'EBUSY' }))
      : realRm.call(fsp, target, options)));
    return () => {
      held = false;
    };
  };
  const refuse = (code) => async () => {
    throw Object.assign(new Error(`${code}: the file is held open by another program`), { code });
  };

  beforeEach(() => {
    restoreEnv = isolateEnv();
    sandbox = createSandbox();
    net = installFetch(); // any real network call throws
    // Never let the LINE SDK download anything: the blob client is mocked on the shared prototype.
    download = mock.method(line.messagingApi.MessagingApiBlobClient.prototype, 'getMessageContent', async () => Buffer.from('BYTES'));
    mock.method(console, 'warn', () => {});
    group = sandbox.load('src/group.js');
  });

  afterEach(() => {
    mock.restoreAll();
    net.restore();
    sandbox.cleanup();
    restoreEnv();
  });

  describe('enabled', () => {
    it('is off by default and for GROUP_MODE=reply (current behaviour: every line answered)', () => {
      assert.strictEqual(group.enabled(), false);
      process.env.GROUP_MODE = 'reply';
      assert.strictEqual(group.enabled(), false);
    });

    it('is on for mention and silent, ignoring case and spaces', () => {
      process.env.GROUP_MODE = 'mention';
      assert.strictEqual(group.enabled(), true);
      process.env.GROUP_MODE = ' SILENT ';
      assert.strictEqual(group.enabled(), true);
    });

    it('is on when GROUP_COLLECT is exactly 1, even in reply mode', () => {
      process.env.GROUP_COLLECT = '1';
      assert.strictEqual(group.enabled(), true);
      process.env.GROUP_MODE = 'reply';
      assert.strictEqual(group.enabled(), true);
      process.env.GROUP_COLLECT = 'true';
      process.env.GROUP_MODE = '';
      assert.strictEqual(group.enabled(), false, 'only "1" turns collection on');
    });
  });

  describe('reply policy', () => {
    it('reply mode lets everything through', async () => {
      process.env.GROUP_MODE = 'reply';
      assert.strictEqual(await handle(textEvent('隨便說說')), false);
    });

    it('silent mode swallows every message, text or not', async () => {
      process.env.GROUP_MODE = 'silent';
      assert.strictEqual(await handle(textEvent('小安你好')), true);
      assert.strictEqual(await handle(mediaEvent({ type: 'image', id: 'i1' })), true);
    });

    it('never swallows events that are not messages (follow, join, ...)', async () => {
      process.env.GROUP_MODE = 'silent';
      assert.strictEqual(await handle({ type: 'join', source: { groupId: 'Ggroup1' } }), false);
      assert.strictEqual(await handle({ type: 'message', source: { groupId: 'Ggroup1' } }), false, 'no message body');
    });

    it('mention mode answers only when addressed by a wake word', async () => {
      process.env.GROUP_MODE = 'mention';
      process.env.GROUP_WAKE_WORDS = '小安|阿安';

      assert.strictEqual(await handle(textEvent('今天午餐吃什麼')), true, 'not addressed: stay quiet');
      assert.strictEqual(await handle(textEvent('小安 幾點開門？')), false);
      assert.strictEqual(await handle(textEvent('阿安在嗎')), false);
    });

    it('mention mode answers a real @mention of the bot, but not of someone else', async () => {
      process.env.GROUP_MODE = 'mention';
      process.env.GROUP_WAKE_WORDS = '小安';
      const withMention = (isSelf) => textEvent('@bot 在嗎', {
        message: { type: 'text', id: 'm1', text: '@bot 在嗎', mention: { mentionees: [{ index: 0, length: 4, isSelf }] } }
      });

      assert.strictEqual(await handle(withMention(true)), false);
      assert.strictEqual(await handle(withMention(false)), true);
    });

    it('mention mode never answers non-text messages', async () => {
      process.env.GROUP_MODE = 'mention';
      process.env.GROUP_WAKE_WORDS = '小安';
      assert.strictEqual(await handle(mediaEvent({ type: 'image', id: 'i1' })), true);
      assert.strictEqual(await handle(mediaEvent({ type: 'sticker', id: 's1' })), true);
    });

    it('falls back to the persona name when GROUP_WAKE_WORDS is empty', async () => {
      process.env.GROUP_MODE = 'mention';

      assert.strictEqual(await handle(textEvent('小安，幫我看一下')), false);
      assert.strictEqual(await handle(textEvent('大家好')), true);
      assert.strictEqual(await handle(textEvent('阿福在嗎'), '名字：阿福'), false, 'full-width colon works too');
    });

    it('has no wake word at all when there is neither a setting nor a persona name', async () => {
      process.env.GROUP_MODE = 'mention';
      process.env.GROUP_WAKE_WORDS = ' | ';

      assert.strictEqual(await handle(textEvent('小安'), '沒有名字欄位'), true);
      assert.strictEqual(await handle(textEvent('小安'), undefined), false, 'default persona has a name');
      assert.strictEqual(await handle(textEvent('小安'), null), true);
    });
  });

  describe('collecting text', () => {
    beforeEach(() => {
      process.env.GROUP_COLLECT = '1';
    });

    it('writes one JSON line per message under data/inbox/<group>/<date>.jsonl', async () => {
      const shouldStop = await handle(textEvent('週五公休'));

      assert.strictEqual(shouldStop, false, 'reply mode still answers after collecting');
      const [row] = inboxLines('Ggroup1');
      assert.deepStrictEqual(row, {
        ts: WHEN.toISOString(),
        user_hash: crypto.createHash('sha256').update('Uabc').digest('hex').slice(0, 8),
        type: 'text',
        message_id: 'm1', // needed to find the line again when the sender unsends or edits it
        text: '週五公休'
      });
    });

    it('never stores the raw LINE userId', async () => {
      await handle(textEvent('hello'));
      assert.strictEqual(fs.readFileSync(sandbox.path('data', 'inbox', 'Ggroup1', DAY_FILE), 'utf8').includes('Uabc'), false);
    });

    it('appends to the same day file and records null when the sender is unknown', async () => {
      await handle(textEvent('第一句'));
      await handle(textEvent('第二句', { source: { type: 'group', groupId: 'Ggroup1' } }));

      const rows = inboxLines('Ggroup1');
      assert.deepStrictEqual(rows.map((r) => r.text), ['第一句', '第二句']);
      assert.strictEqual(rows[1].user_hash, null);
    });

    it('turns an unsafe group id into a harmless directory name', async () => {
      await handle(textEvent('x', { source: { type: 'group', groupId: '../evil' } }));

      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox')), ['___evil']);
      assert.strictEqual(sandbox.exists('data/evil'), false);
      assert.strictEqual(sandbox.exists('evil'), false);
    });

    it('still collects while staying silent or unaddressed, and then asks to stop', async () => {
      process.env.GROUP_MODE = 'silent';
      assert.strictEqual(await handle(textEvent('悄悄話')), true);
      process.env.GROUP_MODE = 'mention';
      process.env.GROUP_WAKE_WORDS = '小安';
      assert.strictEqual(await handle(textEvent('沒叫它')), true);

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.text), ['悄悄話', '沒叫它']);
    });

    it('does not collect anything when GROUP_COLLECT is off', async () => {
      process.env.GROUP_COLLECT = '';
      process.env.GROUP_MODE = 'silent';
      await handle(textEvent('不收'));
      assert.strictEqual(sandbox.exists('data'), false);
    });

    it('warns instead of throwing when the inbox cannot be written', async () => {
      sandbox.write('data', 'a file where the data directory should be');
      const warn = console.warn;

      assert.strictEqual(await handle(textEvent('寫不進去')), false);
      assert.strictEqual(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /GROUP_COLLECT could not write inbox/);
    });
  });

  describe('collecting media', () => {
    beforeEach(() => {
      process.env.GROUP_COLLECT = '1';
    });

    it('downloads an image right away and logs its relative path', async () => {
      await handle(mediaEvent({ type: 'image', id: 'img123' }));

      assert.strictEqual(download.mock.callCount(), 1);
      assert.deepStrictEqual(download.mock.calls[0].arguments, ['img123']);
      assert.strictEqual(sandbox.read('data/inbox/Ggroup1/media/img123.jpg'), 'BYTES');
      const [row] = inboxLines('Ggroup1');
      assert.strictEqual(row.type, 'image');
      assert.strictEqual(row.media_path, 'data/inbox/Ggroup1/media/img123.jpg');
      assert.strictEqual(row.message_id, 'img123');
      assert.strictEqual('media_error' in row, false);
    });

    it('picks the extension from the message type, or from a safe file name for files', async () => {
      const cases = [
        [{ type: 'video', id: 'v1' }, 'v1.mp4'],
        [{ type: 'audio', id: 'a1' }, 'a1.m4a'],
        [{ type: 'file', id: 'f1' }, 'f1.bin'],
        [{ type: 'file', id: 'f2', fileName: 'menu.pdf' }, 'f2.pdf'],
        [{ type: 'file', id: 'f3', fileName: 'README' }, 'f3.bin'],
        [{ type: 'file', id: 'f4', fileName: 'a.p$f' }, 'f4.pf']
      ];
      for (const [message, expected] of cases) {
        await handle(mediaEvent(message));
        assert.ok(sandbox.exists(`data/inbox/Ggroup1/media/${expected}`), `expected ${expected}`);
      }
    });

    it('keeps a hostile message id inside the media directory', async () => {
      await handle(mediaEvent({ type: 'image', id: '../../escape' }));

      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), ['______escape.jpg']);
      assert.strictEqual(sandbox.exists('escape.jpg'), false);
    });

    it('also handles content that arrives as a stream', async () => {
      download.mock.mockImplementation(async () => Readable.from([Buffer.from('AB'), Buffer.from('CD')]));

      await handle(mediaEvent({ type: 'audio', id: 'stream1' }));

      assert.strictEqual(sandbox.read('data/inbox/Ggroup1/media/stream1.m4a'), 'ABCD');
    });

    it('writes a media_error row when the download fails, so nothing is lost silently', async () => {
      download.mock.mockImplementation(async () => {
        throw new Error('content expired ' + 'x'.repeat(400));
      });

      await handle(mediaEvent({ type: 'image', id: 'gone1' }));

      const [row] = inboxLines('Ggroup1');
      assert.strictEqual(row.type, 'image');
      assert.strictEqual(row.message_id, 'gone1');
      assert.strictEqual('media_path' in row, false);
      assert.match(row.media_error, /^content expired x+$/);
      assert.strictEqual(row.media_error.length, 200, 'error text is capped');
    });

    it('records the message id for types it cannot store, such as stickers', async () => {
      await handle(mediaEvent({ type: 'sticker', id: 'st1' }));

      const [row] = inboxLines('Ggroup1');
      assert.strictEqual(row.type, 'sticker');
      assert.strictEqual(row.message_id, 'st1');
      assert.strictEqual(download.mock.callCount(), 0);
    });
  });

  describe('unsend and edit', () => {
    const HASH = crypto.createHash('sha256').update('Uabc').digest('hex').slice(0, 8);
    const at = (minutes) => new Date(WHEN.getTime() + minutes * 60 * 1000);
    const daysBefore = (n) => new Date(2026, 0, 15 - n, 12, 0, 0);
    const LATER = at(10);

    const say = (id, text, when) => handle(textEvent(text, { timestamp: (when || WHEN).getTime(), message: { type: 'text', id, text } }));
    // Shapes follow the LINE reference: an unsend has no replyToken; an edit (groups only) does.
    const unsendEvent = (messageId, when) => ({
      type: 'unsend',
      mode: 'active',
      timestamp: (when || LATER).getTime(),
      source: { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' },
      unsend: { messageId }
    });
    const editEvent = (id, text, when) => ({
      type: 'messageEdited',
      mode: 'active',
      timestamp: when.getTime(),
      replyToken: 'rt-edit',
      source: { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' },
      message: { type: 'text', id, text }
    });
    const rawLines = (file) => sandbox.read(`data/inbox/Ggroup1/${file || DAY_FILE}`).split('\n');

    beforeEach(() => {
      process.env.GROUP_COLLECT = '1';
    });

    it('masks an unsent text line in place: same line count, the other lines untouched, never a reply', async () => {
      process.env.GROUP_MODE = 'reply';
      await say('m1', '第一句');
      await say('m2', '這句傳錯群了');
      await say('m3', '第三句');
      const before = rawLines();

      assert.strictEqual(await handle(unsendEvent('m2')), true, 'an unsend is never answered, even in reply mode');

      const after = rawLines();
      assert.strictEqual(after.length, before.length);
      assert.strictEqual(after[0], before[0]);
      assert.strictEqual(after[2], before[2]);
      assert.strictEqual(after[3], '', 'the file still ends with a newline');
      const { redacted_at: redactedAt, ...rest } = JSON.parse(after[1]);
      assert.deepStrictEqual(rest, { ts: WHEN.toISOString(), user_hash: HASH, type: 'text', message_id: 'm2', redacted: 'unsend' });
      assert.ok(Math.abs(Date.parse(redactedAt) - Date.now()) < 60000, 'redacted_at is when it was masked');
      assert.strictEqual(after.join('\n').includes('傳錯群'), false);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1')), [DAY_FILE], 'no temp file is left behind');
      assert.strictEqual(console.warn.mock.callCount(), 0);
    });

    it('deletes the media file of an unsent image and keeps the others', async () => {
      await handle(mediaEvent({ type: 'image', id: 'img1' }));
      await handle(mediaEvent({ type: 'image', id: 'img2' }));

      await handle(unsendEvent('img1'));

      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/img1.jpg'), false);
      assert.strictEqual(sandbox.read('data/inbox/Ggroup1/media/img2.jpg'), 'BYTES');
      const [first, second] = inboxLines('Ggroup1');
      assert.strictEqual(first.redacted, 'unsend');
      assert.strictEqual('media_path' in first, false);
      assert.strictEqual(second.media_path, 'data/inbox/Ggroup1/media/img2.jpg');
    });

    it('finds the message in an earlier day file, looking back 7 days from the unsend', async () => {
      await say('d1', '昨天說的', daysBefore(1));
      await say('d7', '七天前說的', daysBefore(7));
      await say('d8', '八天前說的', daysBefore(8));

      for (const id of ['d1', 'd7', 'd8']) {
        await handle(unsendEvent(id, WHEN));
      }

      assert.strictEqual(inboxLines('Ggroup1', '2026-01-14.jsonl')[0].redacted, 'unsend');
      assert.strictEqual(inboxLines('Ggroup1', '2026-01-08.jsonl')[0].redacted, 'unsend');
      assert.strictEqual(inboxLines('Ggroup1', '2026-01-07.jsonl')[0].text, '八天前說的', 'outside the window: not searched');
    });

    it('stays quiet for a message it never stored: nothing created or rewritten, no warning', async () => {
      assert.strictEqual(await handle(unsendEvent('ghost')), true);
      assert.strictEqual(sandbox.exists('data'), false, 'an unsend alone creates nothing');

      await say('m1', '留著');
      const before = sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`);
      assert.strictEqual(await handle(unsendEvent('ghost')), true);
      assert.strictEqual(await handle({ type: 'unsend', source: { type: 'group', groupId: 'Ggroup1' } }), true, 'no unsend body');
      assert.strictEqual(sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`), before);
      assert.strictEqual(console.warn.mock.callCount(), 0);

      process.env.GROUP_COLLECT = '';
      process.env.GROUP_MODE = 'silent';
      assert.strictEqual(await handle(unsendEvent('m1')), true);
      assert.strictEqual(sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`), before, 'GROUP_COLLECT off: the inbox is not touched');
    });

    it('a rewrite that fails leaves the file as it was, warns, and does not hold up the next append', async () => {
      await say('m1', '第一句');
      const file = sandbox.path('data', 'inbox', 'Ggroup1', DAY_FILE);
      fs.mkdirSync(`${file}.${process.pid}.tmp`); // the temp file cannot be written
      const before = fs.readFileSync(file, 'utf8');

      await handle(unsendEvent('m1'));
      await say('m2', '第二句');

      assert.match(String(console.warn.mock.calls[0].arguments[0]), /could not redact an unsent message/);
      assert.match(String(console.warn.mock.calls[0].arguments[1]), /^EISDIR: .*open/, 'the original error, not one from cleaning up the temp path');
      assert.strictEqual(fs.readFileSync(file, 'utf8').startsWith(before), true);
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.text), ['第一句', '第二句']);
    });

    it('loses no line when appends and unsends of one webhook run at the same time (server.js uses Promise.all)', async () => {
      for (const id of ['m1', 'm2', 'm3', 'm4']) {
        await say(id, `old-${id}`);
      }

      const batch = [];
      for (let i = 1; i <= 8; i += 1) {
        batch.push(say(`n${i}`, `new-n${i}`));
        if (i === 2) batch.push(handle(unsendEvent('m1')));
        if (i === 4) batch.push(handle(unsendEvent('n2')));
        if (i === 6) batch.push(handle(unsendEvent('m3')));
      }
      await Promise.all(batch);

      const rows = inboxLines('Ggroup1');
      assert.strictEqual(rows.length, 12);
      assert.deepStrictEqual(rows.filter((r) => r.redacted).map((r) => r.message_id).sort(), ['m1', 'm3', 'n2']);
      assert.deepStrictEqual(
        rows.filter((r) => !r.redacted).map((r) => r.text).sort(),
        ['new-n1', 'new-n3', 'new-n4', 'new-n5', 'new-n6', 'new-n7', 'new-n8', 'old-m2', 'old-m4']
      );
    });

    it('masks a media message that is unsent while it is still downloading, and keeps no file', async () => {
      let release;
      let started;
      const downloading = new Promise((resolve) => { started = resolve; });
      download.mock.mockImplementation(() => {
        started();
        return new Promise((resolve) => { release = resolve; });
      });

      const collecting = handle(mediaEvent({ type: 'image', id: 'slow1' }));
      await downloading;
      await handle(unsendEvent('slow1'));
      release(Buffer.from('BYTES'));
      await collecting;

      const [row] = inboxLines('Ggroup1');
      assert.strictEqual(row.redacted, 'unsend');
      assert.strictEqual(row.message_id, 'slow1');
      assert.strictEqual('media_path' in row, false);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), []);
    });

    it('an edit masks the old line and appends the new text; a late older edit or a redelivery changes nothing', async () => {
      await say('m1', '週五公休');

      assert.strictEqual(await handle(editEvent('m1', '週六公休', at(2))), true, 'an edit is never answered');
      await handle(editEvent('m1', '週日公休', at(1))); // an older edit arriving late
      await handle(editEvent('m1', '週六公休', at(2))); // the same edit delivered again

      const rows = inboxLines('Ggroup1');
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].redacted, 'edited');
      assert.strictEqual('text' in rows[0], false);
      assert.deepStrictEqual(rows[1], { ts: at(2).toISOString(), user_hash: HASH, type: 'text', message_id: 'm1', text: '週六公休', edited: true });
    });

    it('an unsend after an edit masks both versions, and a later edit never brings the text back, even after a restart', async () => {
      await say('m1', '原文');
      await handle(editEvent('m1', '改過', at(1)));
      await handle(unsendEvent('m1', at(2)));
      await handle(editEvent('m1', '又改', at(3)));
      group = sandbox.load('src/group.js'); // restart: what was kept in memory is gone, the inbox still says "unsent"
      await handle(editEvent('m1', '再改', at(4)));

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted), ['edited', 'unsend']);
      const content = sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`);
      for (const text of ['原文', '改過', '又改', '再改']) {
        assert.strictEqual(content.includes(text), false, `${text} is gone`);
      }
    });

    it('absorb lists neither unsent nor replaced lines, still reads the lines added after an unsend, and prints no heading when every new line is masked', async () => {
      const absorb = (...args) => {
        const result = spawnSync(process.execPath, [sandbox.path('src', 'absorb.js'), ...args], { cwd: sandbox.root, env: childEnv(), encoding: 'utf8' });
        assert.strictEqual(result.status, 0, `absorb exited with ${result.status}: ${result.stderr}`);
        return result.stdout;
      };
      await say('m1', 'one');
      await say('m2', 'two');
      await handle(unsendEvent('m2'));

      const first = absorb('--commit');
      assert.match(first, new RegExp(`^- L1 \\[${HASH}\\] one$`, 'm'));
      assert.doesNotMatch(first, /- L2 /);
      assert.match(first, /新素材 1 筆/);

      await say('m3', 'three');
      await handle(unsendEvent('m1'));
      await handle(editEvent('m3', 'three, edited', LATER));
      const second = absorb('--commit');

      assert.match(second, new RegExp(`^- L4 \\[${HASH}\\] three, edited$`, 'm'), 'masking kept the line numbers');
      assert.doesNotMatch(second, /- L[123] /);
      assert.match(second, /新素材 1 筆/);

      // every line new since the last read is masked: no empty group or date heading either
      await say('m5', 'five');
      await handle(unsendEvent('m5'));
      const third = absorb();

      assert.doesNotMatch(third, /^## 群組 /m);
      assert.doesNotMatch(third, /^### /m);
      assert.match(third, /新素材 0 筆/);
    });

    it('lines written before every line carried a message_id (older versions) are not found by an unsend or an edit, but "forget me" still masks them', async () => {
      // what the previous version wrote for a text and a downloaded image: no message_id
      const old = { ts: WHEN.toISOString(), user_hash: HASH };
      sandbox.write(`data/inbox/Ggroup1/${DAY_FILE}`, [
        { ...old, type: 'text', text: '升級前說的' },
        { ...old, type: 'text', text: '升級前說的，之後被編輯' },
        { ...old, type: 'image', media_path: 'data/inbox/Ggroup1/media/old3.jpg' }
      ].map((r) => JSON.stringify(r) + '\n').join(''));
      sandbox.write('data/inbox/Ggroup1/media/old3.jpg', 'BYTES');
      const before = sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`);

      await handle(unsendEvent('old1'));
      await handle(unsendEvent('old3'));
      assert.strictEqual(sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`), before, 'no message_id to match the unsend against');
      assert.strictEqual(sandbox.read('data/inbox/Ggroup1/media/old3.jpg'), 'BYTES');

      await handle(editEvent('old2', '升級後改的', LATER));
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.text || r.media_path), [
        '升級前說的', '升級前說的，之後被編輯', 'data/inbox/Ggroup1/media/old3.jpg', '升級後改的'
      ], 'the old version stays next to the new one');

      assert.deepStrictEqual(await group.forgetUser('Uabc', at(20).getTime()), { removed: 4, failed: 0 }, 'matched by user_hash instead');
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted), ['forget', 'forget', 'forget', 'forget']);
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/old3.jpg'), false);
      assert.strictEqual(console.warn.mock.callCount(), 0);
    });

    it('still masks an unsent line when the file is held open by another program (rename refused, as on Windows), and leaves no temp file', async () => {
      await say('m1', '密碼=hunter2 打錯群了');
      await say('m2', '留著');
      const before = rawLines();
      const rename = mock.method(fsp, 'rename', refuse('EPERM'));

      await handle(unsendEvent('m1'));

      assert.ok(rename.mock.callCount() >= 1, 'the rename was tried first');
      const after = rawLines();
      assert.strictEqual(after.length, before.length);
      assert.strictEqual(after[1], before[1]);
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted || r.text), ['unsend', '留著']);
      assert.strictEqual(after.join('\n').includes('hunter2'), false);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1')), [DAY_FILE], 'no temp file is left behind');
      assert.strictEqual(console.warn.mock.callCount(), 0);
    });

    it('an unsend that cannot be written at all right now is finished by the next group event', async () => {
      await say('m1', '密碼=hunter2 打錯群了');
      const rename = mock.method(fsp, 'rename', refuse('EPERM'));
      const open = mock.method(fsp, 'open', refuse('EBUSY'));

      await handle(unsendEvent('m1'));

      assert.match(String(console.warn.mock.calls[0].arguments[0]), /could not redact an unsent message/);
      assert.strictEqual(inboxLines('Ggroup1')[0].text, '密碼=hunter2 打錯群了', 'nothing could be written yet');
      rename.mock.restore();
      open.mock.restore();
      await say('m2', '下一句');

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted || r.text), ['unsend', '下一句']);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1')), [DAY_FILE], 'no temp file is left behind');
    });

    it('an unsent image whose file cannot be deleted right now keeps its line (still pointing at the file) until the next group event deletes both', async () => {
      await handle(mediaEvent({ type: 'image', id: 'img5' }));
      const release = holdOpen('img5.jpg');

      await handle(unsendEvent('img5'));

      assert.match(String(console.warn.mock.calls[0].arguments[0]), /could not delete a media file/);
      assert.strictEqual(inboxLines('Ggroup1')[0].media_path, 'data/inbox/Ggroup1/media/img5.jpg', 'no file is left that no line points at');
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/img5.jpg'), true);
      release();
      await say('m2', '下一句');

      const [row, next] = inboxLines('Ggroup1');
      assert.deepStrictEqual([row.redacted, row.message_id, 'media_path' in row], ['unsend', 'img5', false]);
      assert.strictEqual(next.text, '下一句');
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/img5.jpg'), false);
    });

    it('an image unsent while downloading whose file cannot be deleted right now is still written, and finished later', async () => {
      let release;
      let started;
      const downloading = new Promise((resolve) => { started = resolve; });
      download.mock.mockImplementation(() => {
        started();
        return new Promise((resolve) => { release = resolve; });
      });
      const unlock = holdOpen('slow2.jpg');

      const collecting = handle(mediaEvent({ type: 'image', id: 'slow2' }));
      await downloading;
      await handle(unsendEvent('slow2'));
      release(Buffer.from('BYTES'));
      await collecting;

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.media_path), ['data/inbox/Ggroup1/media/slow2.jpg'], 'the line is written, not lost');
      unlock();
      await say('m2', '下一句');

      const [row] = inboxLines('Ggroup1');
      assert.deepStrictEqual([row.redacted, 'media_path' in row], ['unsend', false]);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), []);
    });

    it('deletes the half-written file a broken download left behind, on unsend and on "forget me"', async () => {
      const broken = () => {
        let sent = false;
        return new Readable({
          read() {
            if (sent) {
              this.destroy(new Error('socket hang up'));
              return;
            }
            sent = true;
            this.push(Buffer.from('FIRST-HALF-OF-A-PHOTO'));
          }
        });
      };
      download.mock.mockImplementation(async () => broken());
      const mediaDir = sandbox.path('data', 'inbox', 'Ggroup1', 'media');
      await handle(mediaEvent({ type: 'image', id: 'img900' }));
      await handle(mediaEvent({ type: 'image', id: 'img901' }));
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => [r.message_id, r.media_error, 'media_path' in r]), [
        ['img900', 'socket hang up', false], ['img901', 'socket hang up', false]
      ]);
      assert.deepStrictEqual(fs.readdirSync(mediaDir).sort(), ['img900.jpg', 'img901.jpg'], 'part of each photo is on disk');

      await handle(unsendEvent('img900'));
      assert.deepStrictEqual(fs.readdirSync(mediaDir), ['img901.jpg']);
      await group.forgetUser('Uabc', LATER.getTime());
      assert.deepStrictEqual(fs.readdirSync(mediaDir), []);
      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted), ['unsend', 'forget']);
    });

    it('two edits of one message handled at the same time (one webhook, Promise.all) leave only the newest version live, in either order; so does a redelivery arriving at the same time', async () => {
      await say('a', '我的手機 0912345678');
      await say('b', '我的手機 0912345678');
      await say('c', '原文');

      await Promise.all([
        handle(editEvent('a', 'a1 我的手機 0912345678', at(1))),
        handle(editEvent('a', 'a2 （已刪掉電話）', at(2))),
        handle(editEvent('b', 'b2 （已刪掉電話）', at(2))), // the newer edit runs first
        handle(editEvent('b', 'b1 我的手機 0912345678', at(1))),
        handle(editEvent('c', 'c1', at(1))),
        handle(editEvent('c', 'c1', at(1))) // the same edit delivered twice at once
      ]);

      const live = (id) => inboxLines('Ggroup1').filter((r) => r.message_id === id && !r.redacted).map((r) => r.text);
      assert.deepStrictEqual(live('a'), ['a2 （已刪掉電話）']);
      assert.deepStrictEqual(live('b'), ['b2 （已刪掉電話）']);
      assert.deepStrictEqual(live('c'), ['c1']);
      assert.strictEqual(sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`).includes('0912345678'), false);
    });

    it('a message unsent while downloading, whose sender then says "forget me", keeps no sender hash', async () => {
      let release;
      let started;
      const downloading = new Promise((resolve) => { started = resolve; });
      download.mock.mockImplementation(() => {
        started();
        return new Promise((resolve) => { release = resolve; });
      });

      const collecting = handle(mediaEvent({ type: 'image', id: 'slow3' }));
      await downloading;
      await handle(unsendEvent('slow3'));
      await group.forgetUser('Uabc', LATER.getTime());
      release(Buffer.from('BYTES'));
      await collecting;

      const [row] = inboxLines('Ggroup1');
      assert.deepStrictEqual([row.redacted, row.user_hash, 'media_path' in row], ['unsend', null, false]);
      assert.strictEqual(sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`).includes(HASH), false);
    });
  });

  describe('forget me', () => {
    const HASH = crypto.createHash('sha256').update('Uabc').digest('hex').slice(0, 8);
    const at = (minutes) => new Date(WHEN.getTime() + minutes * 60 * 1000);
    const said = (id, text, extra) => handle(textEvent(text, { message: { type: 'text', id, text }, ...extra }));
    const fromOther = { source: { type: 'group', groupId: 'Ggroup1', userId: 'Uother' } };
    const rawLines = (groupDir, file) => sandbox.read(`data/inbox/${groupDir}/${file || DAY_FILE}`).split('\n');

    it('is off unless GROUP_COLLECT=1 or GROUP_FORGET_WORDS is set, matches the whole trimmed sentence only, and never takes a history clear word', () => {
      process.env.GROUP_MODE = 'silent';
      assert.strictEqual(group.isForgetCommand('忘了我'), false, 'all off: never intercepted');

      process.env.GROUP_COLLECT = '1';
      assert.strictEqual(group.isForgetCommand('忘了我'), true);
      assert.strictEqual(group.isForgetCommand('  忘了我 \n'), true);
      for (const text of ['你會忘了我嗎', '忘了我吧', '請忘了我', '', null, undefined]) {
        assert.strictEqual(group.isForgetCommand(text), false, JSON.stringify(text));
      }

      process.env.GROUP_COLLECT = '';
      process.env.GROUP_FORGET_WORDS = ' 刪掉我的資料 | /forget | /clear | 清除對話 | 忘記剛剛 ';
      assert.strictEqual(group.isForgetCommand('/forget'), true, 'the words alone turn it on');
      assert.strictEqual(group.isForgetCommand('刪掉我的資料'), true);
      assert.strictEqual(group.isForgetCommand('忘了我'), false, 'the setting replaces the default');
      for (const word of ['/clear', '清除對話', '忘記剛剛']) {
        assert.strictEqual(group.isForgetCommand(word), false, `${word} stays a history clear word`);
      }
      process.env.HISTORY_CLEAR_WORDS = '刪掉我的資料';
      assert.strictEqual(group.isForgetCommand('刪掉我的資料'), false, 'a custom clear word wins too');
    });

    it('waits for 「確定」 per chat and person: whole trimmed sentence, sent after the command, one use, and asks older than 60 seconds are swept out', () => {
      let now = 1000000;
      group.now = () => now;
      const asker = { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' };
      const SENT = 1700000000000; // LINE timestamp of the command

      assert.strictEqual(group.askForgetConfirm({ type: 'group', groupId: 'Ggroup1' }, '忘了我', SENT), false, 'no userId: nobody to wait for');
      assert.strictEqual(group.askForgetConfirm(undefined, '忘了我', SENT), false);
      assert.strictEqual(group._forgetAsked.size, 0);

      assert.strictEqual(group.askForgetConfirm(asker, ' 刪掉我的資料\n', SENT), true);
      assert.strictEqual(group.takeForgetConfirm(asker, '確定了', SENT + 1), null, 'the whole sentence only');
      // sent before the command (a redelivered or late-handled old one), in the same millisecond, or with no timestamp
      for (const ts of [SENT - 1, SENT, undefined]) {
        assert.strictEqual(group.takeForgetConfirm(asker, '確定', ts), null, `sent at ${ts}: not after the command`);
      }
      assert.strictEqual(group._forgetAsked.size, 1, 'those leave the request waiting for the real answer');
      assert.strictEqual(group.takeForgetConfirm(asker, ' 確定\n', SENT + 1), '刪掉我的資料', 'trimmed, and gives back the word that was used, trimmed');
      assert.strictEqual(group.takeForgetConfirm(asker, '確定', SENT + 2), null, 'used up');

      // exactly 60 seconds is still on time, even when someone else's ask sweeps out stale ones at that very moment
      group.askForgetConfirm(asker, '忘了我', SENT);
      now += 60000;
      group.askForgetConfirm({ type: 'group', groupId: 'Ggroup1', userId: 'Uother' }, '忘了我', SENT + 60000);
      assert.strictEqual(group.takeForgetConfirm(asker, '確定', SENT + 60000), '忘了我');

      // 1 ms late: not a confirmation, and that stale request is dropped on the spot
      group.askForgetConfirm(asker, '忘了我', SENT + 60000);
      now += 60001;
      assert.strictEqual(group.takeForgetConfirm(asker, '確定', SENT + 120001), null);
      assert.strictEqual(group._forgetAsked.has('Ggroup1|Uabc'), false);

      for (const userId of ['U1', 'U2', 'U3']) {
        group.askForgetConfirm({ type: 'user', userId }, '忘了我', SENT);
      }
      now += 60001;
      group.askForgetConfirm({ type: 'room', roomId: 'Rroom1', userId: 'U4' }, '忘了我', SENT);
      assert.deepStrictEqual([...group._forgetAsked.keys()], ['Rroom1|U4'], 'the stale asks are gone');
    });

    it('keeps the waiting list in the order of the latest ask, so the sweep that stops at the first fresh one misses nothing; a late 「確定」 drops its expired request even when it is older than the command', () => {
      let now = 1000000;
      group.now = () => now;
      const SENT = 1700000000000;
      const who = (userId) => ({ type: 'group', groupId: 'Ggroup1', userId });

      group.askForgetConfirm(who('U1'), '忘了我', SENT);
      now += 10000;
      group.askForgetConfirm(who('U2'), '忘了我', SENT + 10000);
      now += 30000;
      group.askForgetConfirm(who('U1'), '忘了我', SENT + 40000); // asking again moves U1 behind U2
      assert.deepStrictEqual([...group._forgetAsked.keys()], ['Ggroup1|U2', 'Ggroup1|U1']);

      now += 35000; // U2 asked 65 s ago, U1 35 s ago
      group.askForgetConfirm(who('U3'), '忘了我', SENT + 75000);
      assert.deepStrictEqual([...group._forgetAsked.keys()], ['Ggroup1|U1', 'Ggroup1|U3'], 'U2 is swept out although U1 asked first');

      // more than 60 s on, a 「確定」 sent before U3's command (a redelivered old one) still drops U3's stale request
      now += 60001;
      assert.strictEqual(group.takeForgetConfirm(who('U3'), '確定', SENT), null);
      assert.strictEqual(group._forgetAsked.has('Ggroup1|U3'), false);
      assert.strictEqual(group._forgetAsked.has('Ggroup1|U1'), true, 'nobody else\'s request is touched');
    });

    it('takes a request back when the command itself is unsent, and only then', () => {
      group.now = () => 1000000;
      const SENT = 1700000000000;
      const asker = { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' };

      group.askForgetConfirm(asker, '忘了我', SENT, 'cmd-1');
      assert.strictEqual(group.cancelForgetConfirm(asker, 'm-other'), false, 'another message');
      assert.strictEqual(group.cancelForgetConfirm(asker, undefined), false);
      assert.strictEqual(group.cancelForgetConfirm({ ...asker, userId: 'Uother' }, 'cmd-1'), false, 'someone else');
      assert.strictEqual(group.cancelForgetConfirm({ type: 'user', userId: 'Uabc' }, 'cmd-1'), false, 'another chat');
      assert.strictEqual(group.cancelForgetConfirm(undefined, 'cmd-1'), false);
      assert.strictEqual(group._forgetAsked.size, 1);

      assert.strictEqual(group.cancelForgetConfirm(asker, 'cmd-1'), true);
      assert.strictEqual(group.takeForgetConfirm(asker, '確定', SENT + 1), null, 'nothing waits any more');

      // a request recorded without a message id cannot be matched by an unsend without one
      group.askForgetConfirm(asker, '忘了我', SENT);
      assert.strictEqual(group.cancelForgetConfirm(asker, undefined), false);
      assert.strictEqual(group.takeForgetConfirm(asker, '確定', SENT + 1), '忘了我');
    });

    it('masks every line of that person in every group and on every date, deletes their media, and leaves everyone else alone', async () => {
      assert.deepStrictEqual(await group.forgetUser('Unobody', WHEN.getTime()), { removed: 0, failed: 0 });
      assert.deepStrictEqual(await group.forgetUser(undefined), { removed: 0, failed: 0 });
      assert.strictEqual(sandbox.exists('data'), false, 'nothing collected yet: nothing created');

      process.env.GROUP_COLLECT = '1';
      await said('m1', '我的電話是 0912');
      await said('m2', '別人的話', fromOther);
      await handle(mediaEvent({ type: 'image', id: 'img1' }));
      await handle({ ...mediaEvent({ type: 'image', id: 'img2' }), ...fromOther });
      await said('m4', '收回過的');
      await handle({ type: 'unsend', timestamp: at(1).getTime(), source: { type: 'group', groupId: 'Ggroup1', userId: 'Uabc' }, unsend: { messageId: 'm4' } });
      // another group, a month earlier: far outside the 7-day unsend window
      await said('m3', '一個月前在別的群說的', { timestamp: new Date(2025, 11, 15, 12).getTime(), source: { type: 'group', groupId: 'Ggroup2', userId: 'Uabc' } });
      const before = rawLines('Ggroup1');

      const result = await group.forgetUser('Uabc', at(2).getTime());

      assert.deepStrictEqual(result, { removed: 3, failed: 0 }, 'm1, img1 and m3; the unsent m4 had no content left');
      const after = rawLines('Ggroup1');
      assert.strictEqual(after.length, before.length, 'no line added or removed');
      assert.strictEqual(after[1], before[1], 'the other member\'s text is byte-for-byte the same');
      assert.strictEqual(after[3], before[3], 'the other member\'s image row too');
      const rows = inboxLines('Ggroup1');
      assert.deepStrictEqual(rows.map((r) => r.redacted || r.text || r.media_path), [
        'forget', '別人的話', 'forget', 'data/inbox/Ggroup1/media/img2.jpg', 'unsend'
      ]);
      const { redacted_at: _at, ...masked } = rows[0];
      assert.deepStrictEqual(masked, { ts: WHEN.toISOString(), user_hash: null, type: 'text', message_id: 'm1', redacted: 'forget' });
      assert.strictEqual(rows[4].user_hash, null, 'an earlier mask loses the sender hash too');
      assert.strictEqual(inboxLines('Ggroup2', '2025-12-15.jsonl')[0].redacted, 'forget');
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/img1.jpg'), false);
      assert.strictEqual(sandbox.read('data/inbox/Ggroup1/media/img2.jpg'), 'BYTES');
      const everything = sandbox.read(`data/inbox/Ggroup1/${DAY_FILE}`) + sandbox.read('data/inbox/Ggroup2/2025-12-15.jsonl');
      for (const gone of [HASH, '0912', '一個月前', '收回過的']) {
        assert.strictEqual(everything.includes(gone), false, `${gone} is gone`);
      }

      assert.deepStrictEqual(await group.forgetUser('Uabc', at(3).getTime()), { removed: 0, failed: 0 }, 'saying it again changes nothing');
      assert.deepStrictEqual(rawLines('Ggroup1'), after);
    });

    it('masks a message sent before the command that is still being written, and keeps what is said after it', async () => {
      process.env.GROUP_COLLECT = '1';
      let release;
      let started;
      const downloading = new Promise((resolve) => { started = resolve; });
      download.mock.mockImplementation(() => {
        started();
        return new Promise((resolve) => { release = resolve; });
      });

      const collecting = handle(mediaEvent({ type: 'image', id: 'slow1' }));
      await downloading;
      assert.deepStrictEqual(await group.forgetUser('Uabc', at(1).getTime()), { removed: 0, failed: 0 });
      release(Buffer.from('BYTES'));
      await collecting;
      await said('m2', '指令之後說的', { timestamp: at(2).getTime() });

      const [early, later] = inboxLines('Ggroup1');
      assert.deepStrictEqual([early.redacted, early.user_hash, 'media_path' in early], ['forget', null, false]);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), []);
      assert.deepStrictEqual([later.text, later.user_hash], ['指令之後說的', HASH]);
    });

    it('counts a file it could not rewrite as failed, warns, and still does the other files', async () => {
      process.env.GROUP_COLLECT = '1';
      await said('m1', '第一群');
      await said('m2', '第二群', { source: { type: 'group', groupId: 'Ggroup2', userId: 'Uabc' } });
      const blocked = sandbox.path('data', 'inbox', 'Ggroup1', DAY_FILE);
      fs.mkdirSync(`${blocked}.${process.pid}.tmp`); // the temp file cannot be written
      const before = fs.readFileSync(blocked, 'utf8');

      assert.deepStrictEqual(await group.forgetUser('Uabc', at(1).getTime()), { removed: 1, failed: 1 });

      assert.match(String(console.warn.mock.calls[0].arguments[0]), /could not forget a member/);
      assert.strictEqual(fs.readFileSync(blocked, 'utf8'), before);
      assert.strictEqual(inboxLines('Ggroup2')[0].redacted, 'forget');
    });

    it('when a media file cannot be deleted right now, keeps that line as it is (still theirs), counts honestly, and the next command finishes it', async () => {
      process.env.GROUP_COLLECT = '1';
      await handle(mediaEvent({ type: 'image', id: 'img1' }));
      await handle(mediaEvent({ type: 'image', id: 'img2' }));
      await said('m3', '一則文字');
      const release = holdOpen('img1.jpg');

      assert.deepStrictEqual(await group.forgetUser('Uabc', at(1).getTime()), { removed: 2, failed: 1 });

      assert.match(String(console.warn.mock.calls[0].arguments[0]), /could not delete a media file/);
      const rows = inboxLines('Ggroup1');
      assert.deepStrictEqual(rows.map((r) => r.redacted || r.media_path), ['data/inbox/Ggroup1/media/img1.jpg', 'forget', 'forget']);
      assert.strictEqual(rows[0].user_hash, HASH, 'still recognisably theirs, so saying it again finds it');
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), ['img1.jpg'], 'img2 was deleted anyway');

      release();
      assert.deepStrictEqual(await group.forgetUser('Uabc', at(2).getTime()), { removed: 1, failed: 0 });

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => [r.redacted, r.user_hash]), [['forget', null], ['forget', null], ['forget', null]]);
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox', 'Ggroup1', 'media')), []);
    });

    it('never deletes a file outside data/inbox/, whatever a line\'s media_path says, and still masks the line', async () => {
      const row = { ts: WHEN.toISOString(), user_hash: HASH, type: 'image' };
      sandbox.write(`data/inbox/Ggroup1/${DAY_FILE}`, [
        { ...row, message_id: 'x1', media_path: 'persona/profile.md' },
        { ...row, message_id: 'x2', media_path: 'data/inbox/../escalations/ticket.json' }
      ].map((r) => JSON.stringify(r) + '\n').join(''));
      sandbox.write('persona/profile.md', 'PROFILE');
      sandbox.write('data/escalations/ticket.json', '{}');

      assert.deepStrictEqual(await group.forgetUser('Uabc', at(1).getTime()), { removed: 2, failed: 0 });

      assert.deepStrictEqual(inboxLines('Ggroup1').map((r) => r.redacted), ['forget', 'forget']);
      assert.strictEqual(sandbox.read('persona/profile.md'), 'PROFILE');
      assert.strictEqual(sandbox.read('data/escalations/ticket.json'), '{}');
    });
  });
});
