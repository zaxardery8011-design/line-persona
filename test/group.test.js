'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const line = require('@line/bot-sdk');
const { createSandbox, isolateEnv, installFetch } = require('./helpers/support');

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
});
