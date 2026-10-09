'use strict';

// Webhook tests for src/server.js: signature check, event routing, limits, group policy.
// The app is loaded from a sandbox copy, served on 127.0.0.1 with an ephemeral port, and
// called with node:http. The LINE reply API and the LLM are mocked; the secret and token
// below are made-up test values.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const line = require('@line/bot-sdk');
const { createSandbox, isolateEnv, installFetch, request, sign } = require('./helpers/support');

const SECRET = 'test-secret-not-real';
const TOKEN = 'test-token-not-real';

const textEvent = (text, extra) => ({
  type: 'message',
  mode: 'active',
  timestamp: 1700000000000,
  webhookEventId: 'evt-1',
  deliveryContext: { isRedelivery: false },
  replyToken: 'reply-token-1',
  source: { type: 'user', userId: 'Uuser1' },
  message: { type: 'text', id: 'msg-1', text },
  ...extra
});

const groupTextEvent = (text, groupId, userId) => textEvent(text, {
  source: { type: 'group', groupId, userId: userId || 'Uuser1' }
});

describe('server webhook', () => {
  let sandbox;
  let restoreEnv;
  let net;
  let replies;
  let replyMessage;
  let chatCalls;
  let chatImpl;
  let server;
  let port;

  async function boot(env) {
    Object.assign(process.env, env || {});
    const { app } = sandbox.load('src/server.js');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }

  function webhook(events, options) {
    const opts = options || {};
    const body = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify({ destination: 'Udest', events });
    const headers = { 'content-type': 'application/json' };
    if (opts.signature !== null) headers['x-line-signature'] = opts.signature || sign(SECRET, body);
    return request(port, { method: 'POST', path: '/webhook', headers, body });
  }

  const sentTexts = () => replies.map((r) => r.messages[0].text);

  beforeEach(() => {
    restoreEnv = isolateEnv({ NODE_ENV: 'test', LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: TOKEN });
    sandbox = createSandbox();
    net = installFetch(); // any real network call throws
    replies = [];
    chatCalls = [];
    chatImpl = async () => '這是回覆';

    // dotenv would read a real .env from the working directory; keep it out of the test.
    mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
    replyMessage = mock.method(line.messagingApi.MessagingApiClient.prototype, 'replyMessage', async (request) => {
      replies.push(request);
      return { sentMessages: [{ id: 'sent-1' }] };
    });
    sandbox.write('persona/profile.md', '名字: 小安\n口吻: 親切');
    sandbox.write('persona/knowledge.md', 'FAQ: 週一公休');
    sandbox.stubLlm(async (messages) => {
      chatCalls.push(messages);
      return chatImpl(messages);
    });
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    mock.restoreAll();
    net.restore();
    sandbox.cleanup();
    restoreEnv();
  });

  it('exports the app without opening a port when required (only `node src/server.js` listens)', () => {
    const listen = mock.method(http.Server.prototype, 'listen');

    const exported = sandbox.load('src/server.js');

    assert.strictEqual(typeof exported.app, 'function');
    assert.strictEqual(listen.mock.callCount(), 0);
  });

  it('answers the health check', async () => {
    await boot();
    const res = await request(port, { path: '/' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, 'line-persona is running');
  });

  describe('signature check', () => {
    it('accepts the empty-events request the LINE console sends when you press Verify', async () => {
      await boot();
      const res = await webhook([]);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), []);
    });

    it('rejects a request with no signature before anything runs', async () => {
      await boot();

      const res = await webhook([textEvent('hi')], { signature: null });

      assert.ok(res.status >= 400, `status ${res.status}`);
      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(replies.length, 0);
    });

    it('rejects a signature made with the wrong secret', async () => {
      await boot();
      const body = JSON.stringify({ destination: 'Udest', events: [textEvent('hi')] });

      const res = await webhook(null, { rawBody: body, signature: sign('some-other-secret', body) });

      assert.ok(res.status >= 400, `status ${res.status}`);
      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(replies.length, 0);
    });

    it('rejects a body that was changed after signing', async () => {
      await boot();
      const signed = JSON.stringify({ destination: 'Udest', events: [textEvent('hi')] });
      const tampered = signed.replace('"hi"', '"ho"');

      const res = await webhook(null, { rawBody: tampered, signature: sign(SECRET, signed) });

      assert.ok(res.status >= 400, `status ${res.status}`);
      assert.strictEqual(chatCalls.length, 0);
    });

    it('answers 503 and never reaches the brain when LINE_CHANNEL_SECRET is not set', async () => {
      await boot({ LINE_CHANNEL_SECRET: '' });

      const res = await webhook([textEvent('hi')], { signature: null });

      assert.strictEqual(res.status, 503);
      assert.deepStrictEqual(JSON.parse(res.text), { error: 'LINE_CHANNEL_SECRET is not configured' });
      assert.strictEqual(chatCalls.length, 0);
      assert.match(String(console.warn.mock.calls[0].arguments[0]), /LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET is not set/);
    });
  });

  describe('event routing', () => {
    it('sends a text message through the brain with the persona and replies with the answer', async () => {
      await boot();
      chatImpl = async () => '週一公休喔';

      const res = await webhook([textEvent('週一有開嗎')]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(chatCalls.length, 1);
      const [system, user] = chatCalls[0];
      assert.strictEqual(system.role, 'system');
      assert.ok(system.content.includes('名字: 小安') && system.content.includes('FAQ: 週一公休'), 'persona files are in the prompt');
      assert.deepStrictEqual(user, { role: 'user', content: '週一有開嗎' });
      assert.deepStrictEqual(replies, [{ replyToken: 'reply-token-1', messages: [{ type: 'text', text: '週一公休喔' }] }]);
      assert.strictEqual(JSON.parse(res.text).length, 1);
    });

    it('replies with a fixed notice to images and other non-text messages, without calling the brain', async () => {
      await boot();

      await webhook([textEvent('', { message: { type: 'image', id: 'img-1' } })]);

      assert.strictEqual(chatCalls.length, 0);
      assert.deepStrictEqual(sentTexts(), ['目前只處理文字訊息']);
    });

    it('ignores events that are not messages', async () => {
      await boot();

      const res = await webhook([
        { type: 'follow', replyToken: 'rt', source: { type: 'user', userId: 'Uuser1' }, timestamp: 1 },
        { type: 'unfollow', source: { type: 'user', userId: 'Uuser1' }, timestamp: 2 }
      ]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), [null, null]);
      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(replies.length, 0);
    });

    it('does not call the reply API for an event without a replyToken', async () => {
      await boot();

      const res = await webhook([textEvent('hi', { replyToken: undefined })]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), [null]);
      assert.strictEqual(replyMessage.mock.callCount(), 0);
    });

    it('cuts a reply to the 5000 characters LINE accepts', async () => {
      await boot();
      chatImpl = async () => 'a'.repeat(6000);

      await webhook([textEvent('long please')]);

      assert.strictEqual(replies[0].messages[0].text.length, 5000);
    });

    it('handles several events in one request, in order', async () => {
      await boot();
      chatImpl = async (messages) => `echo:${messages.at(-1).content}`;

      const res = await webhook([
        textEvent('one', { replyToken: 'rt-1', source: { type: 'user', userId: 'Ua' } }),
        textEvent('two', { replyToken: 'rt-2', source: { type: 'user', userId: 'Ub' } })
      ]);

      assert.strictEqual(JSON.parse(res.text).length, 2);
      assert.deepStrictEqual(replies.map((r) => [r.replyToken, r.messages[0].text]), [
        ['rt-1', 'echo:one'],
        ['rt-2', 'echo:two']
      ]);
    });

    it('turns a failing LINE reply into a 500 instead of crashing', async () => {
      await boot();
      replyMessage.mock.mockImplementation(async () => {
        throw new Error('LINE is down');
      });

      const res = await webhook([textEvent('hi')]);

      assert.strictEqual(res.status, 500);
      assert.match(String(console.error.mock.calls[0].arguments[1]), /LINE is down/);
    });

    it('keeps serving after a model failure: the user gets the fallback sentence', async () => {
      await boot();
      chatImpl = async () => {
        throw new Error('model offline');
      };

      const res = await webhook([textEvent('hi')]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(sentTexts(), ['大腦暫時沒有回應，請稍後再試。']);
    });
  });

  describe('webhook limits', () => {
    it('rejects an oversized request with 413 before the signature is even checked', async () => {
      await boot({ WEBHOOK_MAX_BODY_BYTES: '300' });
      const big = JSON.stringify({ destination: 'Udest', events: [textEvent('x'.repeat(500))] });

      const res = await webhook(null, { rawBody: big, signature: 'not-checked' });

      assert.strictEqual(res.status, 413);
      assert.strictEqual(chatCalls.length, 0);
    });

    it('still accepts a request under the limit', async () => {
      await boot({ WEBHOOK_MAX_BODY_BYTES: '5000' });
      assert.strictEqual((await webhook([textEvent('hi')])).status, 200);
    });

    it('drops messages over the per-user rate limit without calling the model or replying', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '2' });

      const res = await webhook([
        textEvent('1', { replyToken: 'rt-1' }),
        textEvent('2', { replyToken: 'rt-2' }),
        textEvent('3', { replyToken: 'rt-3' })
      ]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(JSON.parse(res.text)[2], null, 'the third message is dropped');
      assert.strictEqual(chatCalls.length, 2);
      assert.deepStrictEqual(replies.map((r) => r.replyToken), ['rt-1', 'rt-2']);
    });

    it('counts per user and ignores events that are not messages', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '1' });
      const follow = { type: 'follow', replyToken: 'rt', source: { type: 'user', userId: 'Uuser1' }, timestamp: 1 };

      await webhook([follow, follow, follow]);
      await webhook([textEvent('mine', { replyToken: 'rt-a' })]);
      await webhook([textEvent('mine again', { replyToken: 'rt-b' })]);
      await webhook([textEvent('someone else', { replyToken: 'rt-c', source: { type: 'user', userId: 'Uother' } })]);

      assert.deepStrictEqual(replies.map((r) => r.replyToken), ['rt-a', 'rt-c']);
    });

    it('WEBHOOK_RATE_LIMIT_MAX=0 turns the limit off', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '0' });
      const events = Array.from({ length: 30 }, (_v, i) => textEvent(`m${i}`, { replyToken: `rt-${i}` }));

      await webhook(events);

      assert.strictEqual(replies.length, 30);
    });
  });

  describe('groups', () => {
    const groupsFile = () => JSON.parse(sandbox.read('data/groups.json'));

    it('answers every group message by default and remembers each groupId once', async () => {
      await boot();

      await webhook([groupTextEvent('a', 'Ggroup1'), groupTextEvent('b', 'Ggroup1')]);
      await webhook([groupTextEvent('c', 'Ggroup2')]);

      assert.strictEqual(replies.length, 3);
      assert.deepStrictEqual(groupsFile(), ['Ggroup1', 'Ggroup2']);
    });

    it('does not create data/ for one-to-one chats', async () => {
      await boot();
      await webhook([textEvent('hi')]);
      assert.strictEqual(sandbox.exists('data'), false);
    });

    it('recreates a corrupt or non-list groups.json', async () => {
      await boot();
      sandbox.write('data/groups.json', '{not json');
      await webhook([groupTextEvent('a', 'Ggroup1')]);
      assert.deepStrictEqual(groupsFile(), ['Ggroup1']);

      sandbox.write('data/groups.json', JSON.stringify({ not: 'a list' }));
      await webhook([groupTextEvent('b', 'Ggroup2')]);
      assert.deepStrictEqual(groupsFile(), ['Ggroup2']);
    });

    it('GROUP_MODE=silent: no answer in groups, but one-to-one chats still work', async () => {
      await boot({ GROUP_MODE: 'silent' });

      const res = await webhook([groupTextEvent('hello group', 'Ggroup1'), textEvent('hello me', { replyToken: 'rt-me' })]);

      assert.deepStrictEqual(JSON.parse(res.text).map((r) => r === null), [true, false]);
      assert.deepStrictEqual(replies.map((r) => r.replyToken), ['rt-me']);
      assert.deepStrictEqual(groupsFile(), ['Ggroup1'], 'the group is still remembered');
    });

    it('GROUP_MODE=mention: answers only when the persona name is called, and stays quiet for media', async () => {
      await boot({ GROUP_MODE: 'mention' });

      await webhook([
        groupTextEvent('午餐吃什麼', 'Ggroup1'),
        groupTextEvent('小安，週一有開嗎', 'Ggroup1'),
        textEvent('', { source: { type: 'group', groupId: 'Ggroup1', userId: 'Uuser1' }, message: { type: 'image', id: 'img-1' } })
      ]);

      assert.strictEqual(chatCalls.length, 1);
      assert.strictEqual(chatCalls[0].at(-1).content, '小安，週一有開嗎');
      assert.strictEqual(replies.length, 1, 'no "text only" notice for group images');
    });

    it('GROUP_COLLECT=1: saves group text to the inbox with a hashed sender, and leaves private chats out', async () => {
      await boot({ GROUP_COLLECT: '1' });

      await webhook([groupTextEvent('菜單改了', 'Ggroup1', 'Uuser1'), textEvent('私訊', { replyToken: 'rt-dm' })]);

      const dir = sandbox.path('data', 'inbox', 'Ggroup1');
      const [file] = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      const content = fs.readFileSync(`${dir}/${file}`, 'utf8');
      const rows = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].text, '菜單改了');
      assert.strictEqual(rows[0].user_hash, crypto.createHash('sha256').update('Uuser1').digest('hex').slice(0, 8));
      assert.strictEqual(content.includes('Uuser1'), false, 'raw userId is never stored');
      assert.strictEqual(replies.length, 2, 'collecting alone does not silence the bot');
      assert.deepStrictEqual(fs.readdirSync(sandbox.path('data', 'inbox')), ['Ggroup1']);
    });
  });
});
