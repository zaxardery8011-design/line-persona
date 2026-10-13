'use strict';

// Webhook tests for src/server.js: signature check, event routing, limits, group policy.
// The app is loaded from a sandbox copy, served on 127.0.0.1 with an ephemeral port, and
// called with node:http. The LINE reply API and the LLM are mocked; the secret and token
// below are made-up test values.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const line = require('@line/bot-sdk');
const { createSandbox, isolateEnv, installFetch, fakeResponse, request, sign } = require('./helpers/support');

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
  let loadings;
  let showLoading;
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

  async function shutdown() {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
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
    loadings = [];
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
    showLoading = mock.method(line.messagingApi.MessagingApiClient.prototype, 'showLoadingAnimation', async (request) => {
      loadings.push(request);
      return {};
    });
    sandbox.write('persona/profile.md', '名字: 小安\n口吻: 親切');
    sandbox.write('persona/knowledge.md', 'FAQ: 週一公休');
    sandbox.stubLlm(async (messages) => {
      chatCalls.push(messages);
      return chatImpl(messages);
    });
  });

  afterEach(async () => {
    await shutdown();
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

    it('replies with a fixed notice to stickers and other non-text messages, without calling the brain', async () => {
      await boot();

      await webhook([textEvent('', { message: { type: 'sticker', id: 'stk-1', packageId: '1', stickerId: '1' } })]);

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

    it('does not call the reply API (nor start the loading animation) for an event without a replyToken', async () => {
      await boot();

      const res = await webhook([textEvent('hi', { replyToken: undefined })]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), [null]);
      assert.strictEqual(replyMessage.mock.callCount(), 0);
      assert.deepStrictEqual(loadings, [], 'no reply is coming, so no "typing" either');
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

    it('GROUP_COLLECT=1: never answers an edit or an unsend, and the unsent text is gone from the inbox', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const source = { type: 'group', groupId: 'Ggroup1', userId: 'Uuser1' };
      await webhook([groupTextEvent('打錯了', 'Ggroup1')]);

      // Both in one webhook, so they run side by side like LINE may deliver them.
      const res = await webhook([
        { type: 'messageEdited', mode: 'active', timestamp: 1700000060000, replyToken: 'rt-edit', source, message: { type: 'text', id: 'msg-1', text: '改好了' } },
        { type: 'unsend', mode: 'active', timestamp: 1700000120000, source, unsend: { messageId: 'msg-1' } }
      ]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), [null, null]);
      assert.strictEqual(replies.length, 1, 'only the original message was answered');
      assert.strictEqual(chatCalls.length, 1);
      const dir = sandbox.path('data', 'inbox', 'Ggroup1');
      const content = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(`${dir}/${n}`, 'utf8')).join('');
      const rows = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(rows.length >= 1 && rows.every((r) => r.message_id === 'msg-1' && r.redacted), 'every version is masked');
      assert.strictEqual(content.includes('打錯了') || content.includes('改好了'), false);
    });

    it('takes an unsent or edited message out of the multi-turn memory, in private chats and groups, even if its answer was still on the way', { timeout: 5000 }, async () => {
      await boot({ HISTORY_TURNS: '5', GROUP_COLLECT: '1' });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      chatImpl = async (messages) => {
        const said = messages.at(-1).content;
        if (said.includes('還在想')) await gate; // the model is still answering when the unsend comes in
        return `echo:${said}`;
      };
      const say = (text, id, source) => textEvent(text, { replyToken: `rt-${id}`, source, message: { type: 'text', id, text } });
      const dm = { type: 'user', userId: 'Ua' };
      const group = { type: 'group', groupId: 'Ggroup1', userId: 'Ua' };
      const unsend = (id, source) => ({ type: 'unsend', mode: 'active', timestamp: 1700000060000, source, unsend: { messageId: id } });

      await webhook([say('密碼=hunter2', 'd1', dm)]);
      await webhook([unsend('d1', dm)]);
      await webhook([say('早安', 'd2', dm)]);
      await webhook([say('我的電話 0912', 'g1', group)]);
      await webhook([{ type: 'messageEdited', mode: 'active', timestamp: 1700000060000, replyToken: 'rt-edit', source: group, message: { type: 'text', id: 'g1', text: '（電話刪掉了）' } }]);
      await webhook([say('剛剛誰說話', 'g2', group)]);
      const slow = webhook([say('還在想的這句', 'd3', dm)]);
      while (chatCalls.length < 5) await new Promise((resolve) => setImmediate(resolve));
      await webhook([unsend('d3', dm)]);
      release();
      await slow;
      await webhook([say('記得什麼', 'd4', dm)]);

      const asked = (n) => chatCalls[n].map((m) => m.content).slice(1);
      assert.deepStrictEqual(asked(1), ['早安'], 'the unsent private message is gone');
      assert.deepStrictEqual(asked(3), ['剛剛誰說話'], 'the old version of the edited group message is gone');
      assert.deepStrictEqual(asked(5), ['早安', 'echo:早安', '記得什麼'], 'the late answer to an unsent message was not written back');
      assert.strictEqual(replies.some((r) => r.replyToken === 'rt-edit'), false, 'an edit is still never answered');
    });
  });

  describe('loading animation (one-to-one chats only)', () => {
    it('starts it through the LINE loading endpoint for the sender, 20 seconds by default, before the brain is asked', async () => {
      // This one goes through the real SDK: drop the prototype mock and answer like LINE does (202, {}).
      showLoading.mock.restore();
      net.restore();
      const order = [];
      net = installFetch(async () => {
        order.push('loading');
        return fakeResponse({ status: 202, text: '{}' });
      });
      chatImpl = async () => {
        order.push('brain');
        return '在的';
      };
      await boot();

      const res = await webhook([textEvent('在嗎')]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(order, ['loading', 'brain']);
      assert.strictEqual(net.calls.length, 1);
      assert.strictEqual(net.calls[0].url, 'https://api.line.me/v2/bot/chat/loading/start');
      assert.strictEqual(net.calls[0].init.method, 'POST');
      assert.strictEqual(net.calls[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.deepStrictEqual(net.calls[0].body, { chatId: 'Uuser1', loadingSeconds: 20 });
      assert.deepStrictEqual(sentTexts(), ['在的']);
    });

    it('is not started for groups, rooms, non-text messages, rate-limited messages or group messages the policy drops', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '1', GROUP_MODE: 'mention' });

      await webhook([
        groupTextEvent('小安，在嗎', 'Ggroup1', 'Ua'),
        groupTextEvent('午餐吃什麼', 'Ggroup1', 'Ub'),
        textEvent('在嗎', { replyToken: 'rt-room', source: { type: 'room', roomId: 'Rroom1', userId: 'Uc' } }),
        textEvent('', { replyToken: 'rt-img', source: { type: 'user', userId: 'Ud' }, message: { type: 'image', id: 'img-1' } }),
        textEvent('first', { replyToken: 'rt-e1', source: { type: 'user', userId: 'Ue' } }),
        textEvent('second', { replyToken: 'rt-e2', source: { type: 'user', userId: 'Ue' } })
      ]);

      assert.deepStrictEqual(loadings, [{ chatId: 'Ue', loadingSeconds: 20 }], 'only the first one-to-one text from Ue');
      // events run concurrently, so compare the set of replies, not their order
      assert.deepStrictEqual(replies.map((r) => r.replyToken).sort(), ['reply-token-1', 'rt-e1', 'rt-img', 'rt-room']);
    });

    it('LINE_LOADING_SECONDS=0 (or a negative number) turns it off and the reply is unchanged', async () => {
      for (const value of ['0', '-5']) {
        await boot({ LINE_LOADING_SECONDS: value });
        await webhook([textEvent('hi')]);
        await shutdown();
      }

      assert.strictEqual(showLoading.mock.callCount(), 0);
      assert.deepStrictEqual(sentTexts(), ['這是回覆', '這是回覆']);
    });

    it('clamps LINE_LOADING_SECONDS to 5–60 in steps of 5, and uses 20 when it is empty (the .env.example line) or not a number', async () => {
      const cases = [['', 20], ['3', 5], ['7', 10], ['45', 45], ['61', 60], ['600', 60], ['twenty', 20]];
      for (const [value] of cases) {
        await boot({ LINE_LOADING_SECONDS: value });
        await webhook([textEvent('hi')]);
        await shutdown();
      }

      assert.deepStrictEqual(loadings.map((r) => r.loadingSeconds), cases.map(([, expected]) => expected));
    });

    it('a failing or never-answering loading call does not hold up or break the reply', { timeout: 2000 }, async () => {
      await boot();
      showLoading.mock.mockImplementation(async () => {
        throw new Error('LINE loading 400');
      });

      const failed = await webhook([textEvent('one', { replyToken: 'rt-1' })]);

      assert.strictEqual(failed.status, 200);
      assert.ok(console.warn.mock.calls.some((c) => c.arguments[0] === 'Loading animation failed:' && c.arguments[1] === 'LINE loading 400'));

      showLoading.mock.mockImplementation(() => new Promise(() => {}));
      const pending = await webhook([textEvent('two', { replyToken: 'rt-2' })]);

      assert.strictEqual(pending.status, 200);
      assert.deepStrictEqual(replies.map((r) => r.replyToken), ['rt-1', 'rt-2']);
    });

    it('lets the loading call land first when the reply is instant (a clear word), so the animation cannot start after the reply', async () => {
      await boot({ HISTORY_TURNS: '5' });
      const order = [];
      showLoading.mock.mockImplementation(async (request) => {
        loadings.push(request);
        await new Promise((resolve) => setTimeout(resolve, 30)); // LINE answers the loading call a moment later
        order.push('loading answered');
        return {};
      });
      replyMessage.mock.mockImplementation(async (request) => {
        order.push('reply sent');
        replies.push(request);
        return { sentMessages: [{ id: 'sent-1' }] };
      });

      await webhook([textEvent('/clear')]);

      assert.strictEqual(chatCalls.length, 0, '/clear never reaches the model');
      assert.deepStrictEqual(order, ['loading answered', 'reply sent']);
      assert.deepStrictEqual(sentTexts(), ['好，剛剛的對話我先忘掉了，我們重新開始。']);
    });
  });

  describe('images, video, audio and files in one-to-one chats (human handoff)', () => {
    const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
    const ESC_DIR = 'data/escalations';
    const ACK = '（已經幫你登記了，有答案會主動回你）';
    const ESCALATION_ON = { ESCALATION_ENABLED: '1', ESCALATION_NOTIFY_TO: 'Uresp1,Uresp2' };
    const LABELS = { image: '圖片', video: '影片', audio: '語音', file: '檔案' };

    const mediaEvent = (type, userId, replyToken, source) => textEvent('', {
      replyToken: replyToken || `rt-${type}`,
      source: source || { type: 'user', userId },
      message: { type, id: `${type}-1` }
    });
    const tickets = () => (sandbox.exists(ESC_DIR) ? fs.readdirSync(sandbox.path(ESC_DIR)) : [])
      .filter((n) => n.endsWith('.json') && !n.startsWith('_'))
      .map((n) => JSON.parse(sandbox.read(`${ESC_DIR}/${n}`)));
    const failures = () => sandbox.read(`${ESC_DIR}/_notify_failures.jsonl`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const replyTo = (token) => replies.find((r) => r.replyToken === token).messages[0].text;
    const answerPushes = () => {
      net.restore();
      net = installFetch(async () => fakeResponse());
    };

    it('with escalation on: opens a ticket without downloading anything, notifies the responders and says a person has it', async () => {
      answerPushes();
      await boot(ESCALATION_ON);

      const res = await webhook([
        mediaEvent('image', 'Ua'), mediaEvent('video', 'Ub'), mediaEvent('audio', 'Uc'), mediaEvent('file', 'Ud')
      ]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(chatCalls.length, 0, 'the brain is not asked');
      const byAsker = Object.fromEntries(tickets().map((t) => [t.userId, t]));
      assert.deepStrictEqual(Object.keys(byAsker).sort(), ['Ua', 'Ub', 'Uc', 'Ud']);
      assert.deepStrictEqual(
        ['Ua', 'Ub', 'Uc', 'Ud'].map((u) => [byAsker[u].question, byAsker[u].status]),
        Object.values(LABELS).map((label) => [`[使用者傳了${label}]`, 'pending'])
      );
      // only the pushes to the responders went out: no content was fetched from LINE
      assert.ok(net.calls.every((c) => c.url === PUSH_URL), net.calls.map((c) => c.url).join(', '));
      assert.deepStrictEqual(net.calls.map((c) => c.body.to).sort(), ['Uresp1', 'Uresp1', 'Uresp1', 'Uresp1', 'Uresp2', 'Uresp2', 'Uresp2', 'Uresp2']);
      assert.ok(net.calls.some((c) => c.body.messages[0].text.includes('問題：[使用者傳了圖片]')));
      for (const [type, label] of Object.entries(LABELS)) {
        assert.strictEqual(replyTo(`rt-${type}`), `我這邊看不到${label}的內容，已經幫你轉給真人。\n\n${ACK}`);
      }
    });

    it('uses ESCALATION_ACK_TEXT for a media ticket too, like for a text ticket', async () => {
      answerPushes();
      await boot({ ...ESCALATION_ON, ESCALATION_ACK_TEXT: '自訂登記句' });

      await webhook([mediaEvent('image', 'Ua')]);

      assert.strictEqual(replyTo('rt-image'), '我這邊看不到圖片的內容，已經幫你轉給真人。\n\n自訂登記句');
    });

    it('merges a burst of media from one person into one ticket and notifies only once', async () => {
      answerPushes();
      await boot(ESCALATION_ON);

      // three images in one webhook request (handled at the same time), then a file in the next one
      await webhook([mediaEvent('image', 'Ua', 'rt-1'), mediaEvent('image', 'Ua', 'rt-2'), mediaEvent('image', 'Ua', 'rt-3')]);
      await webhook([mediaEvent('file', 'Ua', 'rt-4')]);

      const all = tickets();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].question, '[使用者傳了圖片]');
      assert.deepStrictEqual(all[0].follow_ups.map((f) => f.question), ['[使用者傳了圖片]', '[使用者傳了圖片]', '[使用者傳了檔案]']);
      assert.strictEqual(all[0].urgency, 'normal', 'a burst of media does not jump the queue');
      assert.strictEqual(net.calls.length, 2, 'one notification per responder, not one per image');
      assert.deepStrictEqual(replies.map((r) => r.replyToken).sort(), ['rt-1', 'rt-2', 'rt-3', 'rt-4']);
      assert.ok(sentTexts().every((t) => t.endsWith(ACK)), 'every one still gets the handoff reply');
    });

    it('keeps the receipt rules, and asks for text instead when the ticket could not be opened', async () => {
      await boot({ ESCALATION_ENABLED: '1' });   // nobody to notify

      await webhook([mediaEvent('image', 'Ua', 'rt-1')]);

      const [ticket] = tickets();
      assert.deepStrictEqual(failures().map((f) => [f.reason, f.ticket_id]), [['no_responder_configured', ticket.id]]);
      assert.strictEqual(ticket.push_status, null);
      assert.strictEqual(replyTo('rt-1'), `我這邊看不到圖片的內容，已經幫你轉給真人。\n\n${ACK}`, 'same as a text ticket with nobody configured');

      fs.rmSync(sandbox.path('data'), { recursive: true });
      sandbox.write('data', 'a file where the data directory should be');
      await webhook([mediaEvent('audio', 'Ub', 'rt-2')]);

      assert.strictEqual(replyTo('rt-2'), '我這邊看不到語音的內容，請改用文字描述。', 'never claims a handoff that did not happen');
      assert.ok(console.error.mock.calls.some((c) => /\[escalation\]/.test(String(c.arguments[0]))));
    });

    it('with escalation off: asks for a text description instead, and opens or sends nothing', async () => {
      await boot();

      await webhook([mediaEvent('image', 'Ua'), mediaEvent('video', 'Ub'), mediaEvent('audio', 'Uc'), mediaEvent('file', 'Ud')]);

      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(sandbox.exists('data'), false);
      assert.strictEqual(net.calls.length, 0);
      for (const [type, label] of Object.entries(LABELS)) {
        assert.strictEqual(replyTo(`rt-${type}`), `我這邊看不到${label}的內容，請改用文字描述。`);
      }
    });

    it('never opens a ticket for group or room media, stickers or locations: those keep the old notice', async () => {
      answerPushes();
      await boot(ESCALATION_ON);

      await webhook([
        mediaEvent('image', null, 'rt-group', { type: 'group', groupId: 'Ggroup1', userId: 'Ua' }),
        mediaEvent('video', null, 'rt-room', { type: 'room', roomId: 'Rroom1', userId: 'Ub' }),
        textEvent('', { replyToken: 'rt-sticker', source: { type: 'user', userId: 'Uc' }, message: { type: 'sticker', id: 'stk-1', packageId: '1', stickerId: '1' } }),
        textEvent('', { replyToken: 'rt-location', source: { type: 'user', userId: 'Ud' }, message: { type: 'location', id: 'loc-1', title: '店', address: '台北', latitude: 25, longitude: 121 } })
      ]);

      assert.strictEqual(sandbox.exists(ESC_DIR), false);
      assert.strictEqual(net.calls.length, 0);
      assert.strictEqual(chatCalls.length, 0);
      assert.deepStrictEqual(replies.map((r) => [r.replyToken, r.messages[0].text]).sort(), [
        ['rt-group', '目前只處理文字訊息'],
        ['rt-location', '目前只處理文字訊息'],
        ['rt-room', '目前只處理文字訊息'],
        ['rt-sticker', '目前只處理文字訊息']
      ]);
    });
  });

  describe('"forget me" command', () => {
    const hashOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8);
    const inGroup = (text, userId, id, replyToken, groupId) => textEvent(text, {
      replyToken,
      source: { type: 'group', groupId: groupId || 'Ggroup1', userId },
      message: { type: 'text', id, text }
    });
    const inPrivate = (text, userId, replyToken) => textEvent(text, { replyToken, source: { type: 'user', userId } });
    const inboxFile = (groupId) => {
      const dir = sandbox.path('data', 'inbox', groupId);
      const [name] = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      return `${dir}/${name}`;
    };
    const rows = (groupId) => fs.readFileSync(inboxFile(groupId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const replyTo = (token) => replies.find((r) => r.replyToken === token).messages[0].text;
    const KEPT = '先說清楚，這個指令只刪這個帳號自己存的副本：LINE 聊天室裡的訊息本身不受影響；'
      + '管理者（或幫他整理資料的 AI 助理）先前已經讀過、或已經整理進分身知識庫的內容，是另外抄過去的，刪不到；'
      + '已經送給 AI 模型服務來產生回覆的內容，那邊的紀錄這裡也管不到';
    const CONTACT = '。需要的話請直接聯絡這個帳號的管理者。';
    const COPIES = `${KEPT}${CONTACT}`;
    const COPIES_WITH_TICKETS = `${KEPT}；轉真人的客服紀錄也會留著${CONTACT}`;
    const T = 1700000000000; // textEvent's timestamp
    const at = (event, ms) => ({ ...event, timestamp: T + ms });
    const FORGET_ASK = '要刪掉這個帳號存的你的訊息嗎？刪了就救不回來，所以請你本人在 60 秒內、在這裡回「確定」，我才會刪；沒回就當取消，什麼都不刪。';
    const FORGET_RESEND = (word) => `這句「${word}」是 LINE 補送的，我沒辦法確定你看過要你回「確定」的那句話，所以這次不算，什麼都沒刪。要刪的話請再傳一次「${word}」。`;
    // The command only asks; the same person answering 「確定」 in the same chat deletes.
    // ask(): the command, answered on `<replyToken>-ask`. yes(): the confirmation from the same
    // person in the same chat, sent 1 ms later in LINE time, answered on the event's own replyToken.
    const ask = (event) => ({ ...event, replyToken: `${event.replyToken}-ask` });
    const yes = (event, said) => ({ ...event, timestamp: event.timestamp + 1, message: { ...event.message, id: `${event.message.id}-yes`, text: said || '確定' } });
    const forget = async (event) => {
      await webhook([ask(event)]);
      return webhook([yes(event)]);
    };
    // Fake clock for the confirmation window (group.js reads module.exports.now); install after boot().
    const useClock = (start) => {
      const clock = { now: start };
      sandbox.require('src/group.js').now = () => clock.now;
      return clock;
    };

    it('in a group, even a silent one: the command is not stored, the sender\'s past lines are masked in every group, others are untouched', async () => {
      await boot({ GROUP_COLLECT: '1', GROUP_MODE: 'silent' });
      sandbox.write('data/inbox/Ggroup2/2026-01-01.jsonl', [
        { ts: '2026-01-01T04:00:00.000Z', user_hash: hashOf('Ua'), type: 'image', message_id: 'img-1', media_path: 'data/inbox/Ggroup2/media/img-1.jpg' },
        { ts: '2026-01-01T04:01:00.000Z', user_hash: hashOf('Ub'), type: 'text', message_id: 'old-b', text: 'B 的舊訊息' }
      ].map((r) => JSON.stringify(r) + '\n').join(''));
      sandbox.write('data/inbox/Ggroup2/media/img-1.jpg', 'IMG');
      await webhook([inGroup('A 的電話 0912', 'Ua', 'g-1', 'rt-1')]);
      await webhook([inGroup('B 說的話', 'Ub', 'g-2', 'rt-2')]);
      const otherGroupBefore = fs.readFileSync(inboxFile('Ggroup2'), 'utf8').split('\n');

      const command = inGroup(' 忘了我 ', 'Ua', 'cmd-1', 'rt-forget');
      await webhook([ask(command)]);

      assert.strictEqual(fs.readFileSync(inboxFile('Ggroup1'), 'utf8').includes('0912'), true, 'nothing is deleted before the confirmation');
      const res = await webhook([yes(command, ' 確定\n')]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(chatCalls.length, 0, 'the brain is never asked');
      assert.deepStrictEqual(replies.map((r) => r.replyToken), ['rt-forget-ask', 'rt-forget'], 'silent mode still answers the command and the confirmation, and only them');
      assert.strictEqual(replyTo('rt-forget-ask'), FORGET_ASK);
      assert.strictEqual(replyTo('rt-forget'), `好，群組收集檔裡你的 2 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.redacted || r.text, r.user_hash]), [['forget', null], ['B 說的話', hashOf('Ub')]]);
      const otherGroupAfter = fs.readFileSync(inboxFile('Ggroup2'), 'utf8').split('\n');
      assert.strictEqual(otherGroupAfter.length, otherGroupBefore.length);
      assert.strictEqual(otherGroupAfter[1], otherGroupBefore[1], 'B\'s line is byte-for-byte the same');
      assert.strictEqual(JSON.parse(otherGroupAfter[0]).redacted, 'forget');
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup2/media/img-1.jpg'), false);
      const stored = fs.readFileSync(inboxFile('Ggroup1'), 'utf8');
      assert.strictEqual(stored.includes('忘了我') || stored.includes('確定') || stored.includes('0912'), false);
    });

    it('works from a private chat too, and only a whole sentence counts', async () => {
      await boot({ GROUP_COLLECT: '1' });
      await webhook([inGroup('A 在群組說的', 'Ua', 'g-1', 'rt-g1')]);
      await webhook([inPrivate('你會忘了我嗎', 'Ua', 'rt-q-dm'), inGroup('你會忘了我嗎', 'Ua', 'g-2', 'rt-q-group')]);

      assert.strictEqual(chatCalls.length, 3, 'a question that only contains the words goes to the brain');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.text), ['A 在群組說的', '你會忘了我嗎']);

      await forget(inPrivate('忘了我', 'Ua', 'rt-forget'));

      assert.strictEqual(chatCalls.length, 3);
      assert.strictEqual(replyTo('rt-forget'), `好，群組收集檔裡你的 2 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.redacted), ['forget', 'forget']);
      assert.deepStrictEqual(loadings.map((l) => l.chatId), ['Ua'], 'only the question got the loading animation');
    });

    it('clears what the sender said from the multi-turn memory, keeps other people\'s turns, and leaves the history clear words alone', async () => {
      await boot({ HISTORY_TURNS: '5', GROUP_FORGET_WORDS: '忘了我|/clear' }); // the words alone turn it on
      chatImpl = async (messages) => `echo:${messages.at(-1).content}`;
      await webhook([inPrivate('我的生日是一月一號', 'Ua', 'rt-1')]);
      await webhook([inGroup('A 在群組', 'Ua', 'g-1', 'rt-2')]);
      await webhook([inGroup('B 在群組', 'Ub', 'g-2', 'rt-3')]);

      await forget(inPrivate('忘了我', 'Ua', 'rt-forget'));
      await webhook([inPrivate('我生日哪天', 'Ua', 'rt-4')]);
      await webhook([inGroup('剛剛誰說話', 'Ub', 'g-3', 'rt-5')]);

      assert.strictEqual(replyTo('rt-forget'), `好，群組收集檔裡沒有你的訊息，沒有要刪的。對話記憶裡你說過的話也清掉了。\n\n${COPIES}`);
      assert.deepStrictEqual(chatCalls[3].map((m) => m.content).slice(1), ['我生日哪天'], 'nothing left from before');
      assert.deepStrictEqual(chatCalls[4].map((m) => m.content).slice(1), ['B 在群組', 'echo:B 在群組', '剛剛誰說話']);
      assert.strictEqual(sandbox.exists('data/inbox'), false, 'GROUP_COLLECT is off: nothing collected');

      await webhook([inPrivate('/clear', 'Ub', 'rt-clear')]);
      assert.strictEqual(replyTo('rt-clear'), '好，剛剛的對話我先忘掉了，我們重新開始。', '/clear keeps its own meaning');
    });

    it('stays out of the way when neither GROUP_COLLECT nor GROUP_FORGET_WORDS is set', async () => {
      await boot({ GROUP_MODE: 'silent' });

      await webhook([inPrivate('忘了我', 'Ua', 'rt-dm'), inGroup('忘了我', 'Ua', 'g-1', 'rt-group')]);
      await webhook([inPrivate('確定', 'Ua', 'rt-yes')]);

      assert.strictEqual(chatCalls.length, 2, 'the private ones go to the brain like any sentence');
      assert.deepStrictEqual(replies.map((r) => [r.replyToken, r.messages[0].text]), [['rt-dm', '這是回覆'], ['rt-yes', '這是回覆']], 'the group stays silent');
    });

    it('obeys the rate limit, owns up to a partial failure or a missing userId, and mentions kept handoff tickets', async () => {
      await boot({ GROUP_COLLECT: '1', WEBHOOK_RATE_LIMIT_MAX: '2', ESCALATION_ENABLED: '1' });
      await webhook([inGroup('A 說的', 'Ua', 'g-1', 'rt-1')]);
      await webhook([inGroup('忘了我', 'Ua', 'g-2', 'rt-2')]);

      const limited = await webhook([inGroup('確定', 'Ua', 'g-3', 'rt-3')]);

      assert.strictEqual(replyTo('rt-2'), FORGET_ASK);
      assert.deepStrictEqual(JSON.parse(limited.text), [null], 'the confirmation counts against the limit too');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.text), ['A 說的'], 'nothing was deleted');

      // Uc has a line on disk but has not used up the limit yet
      fs.appendFileSync(inboxFile('Ggroup1'), JSON.stringify({ ts: '2026-01-01T04:00:00.000Z', user_hash: hashOf('Uc'), type: 'text', message_id: 'c-1', text: 'C 說的' }) + '\n');
      fs.mkdirSync(`${inboxFile('Ggroup1')}.${process.pid}.tmp`); // the rewrite cannot happen
      await forget(inPrivate('忘了我', 'Uc', 'rt-4'));
      // no userId: nobody to ask, nothing to delete
      await webhook([textEvent('忘了我', { replyToken: 'rt-5', source: { type: 'group', groupId: 'Ggroup1' } })]);

      assert.strictEqual(replyTo('rt-4'), `群組收集檔裡你的訊息這次沒有全部刪完（已刪 0 則），請稍後再傳一次「忘了我」，再回「確定」。\n\n${COPIES_WITH_TICKETS}`);
      assert.strictEqual(replyTo('rt-5'), '我這邊拿不到你的 LINE 身分，找不出哪些是你的訊息，所以什麼都沒刪。');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.text), ['A 說的', 'C 說的'], 'nothing stored, nothing claimed');
      assert.strictEqual(chatCalls.length, 1);
    });

    it('with escalation switched off since, still mentions the handoff tickets this person has on disk', async () => {
      await boot({ GROUP_COLLECT: '1' }); // ESCALATION_ENABLED is not set
      sandbox.write('data/escalations/20260101T000000000Z_Uold.json', JSON.stringify({
        id: '20260101T000000000Z_Uold.json', status: 'resolved', userId: 'Ua', question: '上個月問的', ts: '2026-01-01T00:00:00.000Z'
      }));

      const a = inPrivate('忘了我', 'Ua', 'rt-a');
      const b = inPrivate('忘了我', 'Ub', 'rt-b');
      await webhook([ask(a), ask(b)]);
      await webhook([yes(a), yes(b)]);

      assert.strictEqual(replyTo('rt-a'), `好，群組收集檔裡沒有你的訊息，沒有要刪的。\n\n${COPIES_WITH_TICKETS}`);
      assert.strictEqual(replyTo('rt-b'), `好，群組收集檔裡沒有你的訊息，沒有要刪的。\n\n${COPIES}`, 'nobody else is told about tickets they do not have');
      assert.strictEqual(sandbox.exists('data/escalations/20260101T000000000Z_Uold.json'), true, 'the ticket itself is kept');
    });

    it('owns up with the real count when a photo cannot be deleted right now, and saying it again finishes the job', async () => {
      await boot({ GROUP_COLLECT: '1' });
      sandbox.write('data/inbox/Ggroup1/2026-01-01.jsonl', [
        { ts: '2026-01-01T04:00:00.000Z', user_hash: hashOf('Ua'), type: 'image', message_id: 'img-1', media_path: 'data/inbox/Ggroup1/media/img-1.jpg' },
        { ts: '2026-01-01T04:01:00.000Z', user_hash: hashOf('Ua'), type: 'text', message_id: 'txt-1', text: 'A 的電話 0912' }
      ].map((r) => JSON.stringify(r) + '\n').join(''));
      sandbox.write('data/inbox/Ggroup1/media/img-1.jpg', 'IMG');
      const realRm = fsp.rm;
      let held = true; // another program has the photo open: on Windows deleting it fails with EBUSY
      mock.method(fsp, 'rm', (target, options) => (held && String(target).endsWith('img-1.jpg')
        ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
        : realRm.call(fsp, target, options)));

      await forget(inPrivate(' 忘了我\n', 'Ua', 'rt-1'));
      held = false;
      await forget(inPrivate('忘了我', 'Ua', 'rt-2'));

      assert.strictEqual(replyTo('rt-1'), `群組收集檔裡你的訊息這次沒有全部刪完（已刪 1 則），請稍後再傳一次「忘了我」，再回「確定」。\n\n${COPIES}`, 'the word is given back trimmed');
      assert.strictEqual(replyTo('rt-2'), `好，群組收集檔裡你的 1 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.redacted, r.user_hash]), [['forget', null], ['forget', null]]);
      assert.strictEqual(sandbox.exists('data/inbox/Ggroup1/media/img-1.jpg'), false);
    });

    it('keeps what the sender says in a group after the command, going by LINE\'s event time', async () => {
      await boot({ GROUP_COLLECT: '1', GROUP_MODE: 'silent' });

      await forget(at(inPrivate('忘了我', 'Ua', 'rt-forget'), 0));
      await webhook([at(inGroup('我又回來了', 'Ua', 'g-1', 'rt-1'), 60000)]);

      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.user_hash, r.redacted]), [['我又回來了', hashOf('Ua'), undefined]]);
    });

    it('also forgets a turn whose answer was still on its way when the command came in, in a private chat and in a group\'s shared memory', { timeout: 5000 }, async () => {
      await boot({ HISTORY_TURNS: '5', GROUP_COLLECT: '1' });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      chatImpl = async (messages) => {
        const said = messages.at(-1).content;
        if (said.includes('0912')) await gate; // the model is still thinking when the command arrives
        return `echo:${said}`;
      };

      const slow = Promise.all([
        webhook([at(inPrivate('我的手機是 0912345678', 'Ua', 'rt-1'), 0)]),
        webhook([at(inGroup('我家電話 0912000111', 'Ua', 'g-1', 'rt-2'), 0)])
      ]);
      while (chatCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
      await forget(at(inPrivate('忘了我', 'Ua', 'rt-forget'), 1000));
      release();
      await slow;
      await webhook([at(inPrivate('我的手機幾號', 'Ua', 'rt-3'), 2000)]);
      await webhook([at(inGroup('剛剛有人說什麼', 'Ub', 'g-2', 'rt-4'), 3000)]);
      await webhook([at(inPrivate('那這句你記得嗎', 'Ua', 'rt-5'), 4000)]);

      assert.match(replyTo('rt-forget'), /對話記憶裡你說過的話也清掉了/);
      assert.strictEqual(sentTexts().filter((t) => t.startsWith('echo:') && t.includes('0912')).length, 2,'both late answers were still sent');
      assert.deepStrictEqual(chatCalls[2].map((m) => m.content).slice(1), ['我的手機幾號'], 'the late answer was not written back');
      assert.deepStrictEqual(chatCalls[3].map((m) => m.content).slice(1), ['剛剛有人說什麼'], 'nor into the group\'s shared memory');
      assert.deepStrictEqual(chatCalls[4].map((m) => m.content).slice(1), ['我的手機幾號', 'echo:我的手機幾號', '那這句你記得嗎'],
        'what was said after the command is remembered as usual');
    });

    it('only the same person answering 「確定」 in the same chat within 60 seconds deletes; anyone or anywhere else is an ordinary message', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('A 的電話 0912', 'Ua', 'g-1', 'rt-1')]);

      await webhook([inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask')]);

      assert.strictEqual(replyTo('rt-ask'), FORGET_ASK);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['A 的電話 0912', undefined]], 'nothing deleted yet, and the command is not stored');

      // someone else in the same group, and the same person in a private chat or another group
      clock.now = T + 30000;
      await webhook([at(inGroup('確定', 'Ub', 'g-2', 'rt-other'), 30000)]);
      await webhook([at(inPrivate('確定', 'Ua', 'rt-dm'), 30000)]);
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-group2', 'Ggroup2'), 30000)]);

      assert.deepStrictEqual(['rt-other', 'rt-dm', 'rt-group2'].map(replyTo), ['這是回覆', '這是回覆', '這是回覆'], 'answered like any other sentence');
      assert.strictEqual(chatCalls.length, 4);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['A 的電話 0912', undefined], ['確定', undefined]], 'nothing deleted, and B\'s 「確定」 is collected');
      assert.deepStrictEqual(rows('Ggroup2').map((r) => r.text), ['確定']);

      // the asker, in the asking chat, 60 seconds on the dot
      clock.now = T + 60000;
      await webhook([at(inGroup(' 確定 ', 'Ua', 'g-4', 'rt-yes'), 60000)]);

      assert.strictEqual(replyTo('rt-yes'), `好，群組收集檔裡你的 2 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
      assert.strictEqual(chatCalls.length, 4, 'the confirmation is not sent to the brain');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [[undefined, 'forget'], ['確定', undefined]], 'the confirmation is not stored; B\'s line stays');
      assert.deepStrictEqual(rows('Ggroup2').map((r) => r.redacted), ['forget']);

      // a confirmation is used up: saying it again (later in LINE time) is an ordinary message
      await webhook([at(inGroup('確定', 'Ua', 'g-5', 'rt-again'), 61000)]);

      assert.strictEqual(replyTo('rt-again'), '這是回覆');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.text), [undefined, '確定', '確定']);
    });

    it('a 「確定」 that comes late, after a restart, or with nothing waiting is an ordinary message; asking again restarts the 60 seconds', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('A 說的', 'Ua', 'g-1', 'rt-1')]);

      await webhook([inGroup('確定', 'Ua', 'g-2', 'rt-nothing')]);
      await webhook([inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask1')]);
      clock.now = T + 60001;
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-late'), 60001)]);

      assert.deepStrictEqual(['rt-nothing', 'rt-ask1', 'rt-late'].map(replyTo), ['這是回覆', FORGET_ASK, '這是回覆']);
      assert.strictEqual(chatCalls.length, 3);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['A 說的', undefined], ['確定', undefined], ['確定', undefined]],
        'both collected like any message, nothing deleted');

      // asked at +100 s and again at +150 s: 「確定」 at +200 s is 100 s after the first ask but only 50 s after the second
      clock.now = T + 100000;
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-2', 'rt-ask2'), 100000)]);
      clock.now = T + 150000;
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-3', 'rt-ask3'), 150000)]);
      clock.now = T + 200000;
      await webhook([at(inGroup('確定', 'Ua', 'g-4', 'rt-yes'), 200000)]);

      assert.strictEqual(replyTo('rt-yes'), `好，群組收集檔裡你的 3 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);

      // what is waiting lives in memory only: a restart cancels it
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-4', 'rt-ask4'), 201000)]);
      await shutdown();
      await boot();
      await webhook([at(inGroup('確定', 'Ua', 'g-5', 'rt-restarted'), 202000)]);

      assert.strictEqual(replyTo('rt-restarted'), '這是回覆');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [[undefined, 'forget'], [undefined, 'forget'], [undefined, 'forget'], ['確定', undefined]]);
    });

    it('a 「確定」 sent before the command, redelivered by LINE or handled late, does not confirm it; the real answer still does', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('我的電話 0912345678', 'Ua', 'g-1', 'rt-1')]);
      // Ua answers a friend with 「確定」; the reply fails, so the webhook answers 500 and LINE may send the event again
      const oldYes = at(inGroup('確定', 'Ua', 'g-2', 'rt-old-yes'), 1000);
      replyMessage.mock.mockImplementationOnce(async () => {
        throw new Error('LINE reply 500');
      });
      const first = await webhook([oldYes]);

      // 4 s later Ua jokes 「忘了我」; 20 s after that LINE redelivers the old 「確定」 with its original timestamp
      clock.now = T + 5000;
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask'), 5000)]);
      clock.now = T + 25000;
      const again = await webhook([{ ...oldYes, deliveryContext: { isRedelivery: true } }]);
      // one sent in the same millisecond as the command cannot be told apart from it either
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-same-ms'), 5000)]);

      assert.deepStrictEqual([first.status, again.status], [500, 200]);
      assert.deepStrictEqual(['rt-ask', 'rt-old-yes', 'rt-same-ms'].map(replyTo), [FORGET_ASK, '這是回覆', '這是回覆'], 'ordinary sentences');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.redacted), [undefined, undefined, undefined, undefined], 'nothing deleted');

      // the request is still waiting: Ua's real answer, sent after the command, deletes
      clock.now = T + 30000;
      await webhook([at(inGroup('確定', 'Ua', 'g-4', 'rt-yes'), 30000)]);

      assert.strictEqual(replyTo('rt-yes'), `好，群組收集檔裡你的 4 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.redacted), ['forget', 'forget', 'forget', 'forget']);
    });

    it('waits for 「確定」 only once the question has really been sent: not after a failed reply, without a reply token, or in the same webhook as the command', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('A 的電話 0912', 'Ua', 'g-1', 'rt-1')]);

      // the question never reaches Ua: LINE's reply API fails (the webhook answers 500) ...
      replyMessage.mock.mockImplementationOnce(async () => {
        throw new Error('LINE reply 500');
      });
      const failed = await webhook([at(inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask-failed'), 1000)]);
      // ... or there is no reply token to answer with (a standby channel gets none)
      const noToken = await webhook([at(inGroup('忘了我', 'Ua', 'cmd-2', undefined), 2000)]);
      clock.now = T + 20000;
      await webhook([at(inGroup('確定', 'Ua', 'g-2', 'rt-yes-1'), 20000)]);

      assert.strictEqual(failed.status, 500);
      assert.deepStrictEqual(JSON.parse(noToken.text), [null]);
      assert.strictEqual(replyTo('rt-yes-1'), '這是回覆', 'an ordinary sentence');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['A 的電話 0912', undefined], ['確定', undefined]], 'nothing deleted');

      // a 「確定」 that arrives in the same webhook as the command was sent before the question could be seen
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-3', 'rt-ask-batch'), 21000), at(inGroup('確定', 'Ua', 'g-3', 'rt-yes-batch'), 21001)]);

      assert.deepStrictEqual(['rt-ask-batch', 'rt-yes-batch'].map(replyTo), [FORGET_ASK, '這是回覆']);
      assert.deepStrictEqual(rows('Ggroup1').map((r) => r.redacted), [undefined, undefined, undefined], 'still nothing deleted');

      // that last question did reach Ua, so the answer to it deletes
      clock.now = T + 30000;
      await webhook([at(inGroup('確定', 'Ua', 'g-4', 'rt-yes-2'), 30000)]);

      assert.strictEqual(replyTo('rt-yes-2'), `好，群組收集檔裡你的 3 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
    });

    it('a command that LINE redelivers starts no wait, so a 「確定」 said before the question could be seen cannot confirm it, even when both come back after the reply API recovers', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('我的電話 0912345678', 'Ua', 'g-1', 'rt-1')]);
      // LINE's reply API keeps failing: the question never reaches Ua, nor does the answer to the 「確定」 Ua sends anyway
      let replyDown = true;
      replyMessage.mock.mockImplementation(async (request) => {
        if (replyDown) throw new Error('LINE reply 500');
        replies.push(request);
        return { sentMessages: [{ id: 'sent-1' }] };
      });
      const command = at(inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask'), 1000);
      const early = at(inGroup('確定', 'Ua', 'g-2', 'rt-early-yes'), 3000);
      const firstTries = [await webhook([command]), await webhook([early])];

      // the reply API is back, and LINE redelivers both with their original timestamps, the command first
      replyDown = false;
      clock.now = T + 20000;
      const redelivered = { isRedelivery: true };
      const again = [await webhook([{ ...command, deliveryContext: redelivered }]), await webhook([{ ...early, deliveryContext: redelivered }])];

      assert.deepStrictEqual(firstTries.map((r) => r.status), [500, 500]);
      assert.deepStrictEqual(again.map((r) => r.status), [200, 200]);
      assert.strictEqual(replyTo('rt-ask'), FORGET_RESEND('忘了我'), 'the redelivered command asks for a fresh one instead of the question');
      assert.strictEqual(replyTo('rt-early-yes'), '這是回覆', 'an ordinary sentence');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['我的電話 0912345678', undefined], ['確定', undefined], ['確定', undefined]], 'nothing deleted');

      // a fresh command is asked as usual, and the answer to that question deletes
      clock.now = T + 30000;
      await webhook([at(inGroup(' 忘了我 ', 'Ua', 'cmd-2', 'rt-ask-2'), 30000)]);
      clock.now = T + 35000;
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-yes'), 35000)]);

      assert.strictEqual(replyTo('rt-ask-2'), FORGET_ASK);
      assert.strictEqual(replyTo('rt-yes'), `好，群組收集檔裡你的 3 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
    });

    it('unsending the command takes the request back, in a group and in a private chat; unsending anything else does not', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      const unsend = (messageId, source, ms) => ({
        type: 'unsend', mode: 'active', timestamp: T + ms, webhookEventId: `evt-unsend-${ms}`, deliveryContext: { isRedelivery: false }, source, unsend: { messageId }
      });
      const inGroup1 = { type: 'group', groupId: 'Ggroup1', userId: 'Ua' };
      await webhook([inGroup('A 的電話 0912', 'Ua', 'g-1', 'rt-1')]);

      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask-1'), 1000)]);
      clock.now = T + 5000;
      await webhook([unsend('cmd-1', inGroup1, 5000)]);
      await webhook([at(inGroup('確定', 'Ua', 'g-2', 'rt-yes-1'), 6000)]);

      assert.strictEqual(replyTo('rt-yes-1'), '這是回覆', 'an ordinary sentence');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [['A 的電話 0912', undefined], ['確定', undefined]], 'nothing deleted');

      const dmSource = { type: 'user', userId: 'Ua' };
      await webhook([at(inPrivate('忘了我', 'Ua', 'rt-ask-dm'), 7000)]);
      await webhook([unsend('msg-1', dmSource, 8000)]); // inPrivate's message id
      await webhook([at(inPrivate('確定', 'Ua', 'rt-yes-dm'), 9000)]);

      assert.strictEqual(replyTo('rt-yes-dm'), '這是回覆', 'same in a private chat');
      assert.strictEqual(chatCalls.length, 3);

      // the earlier, already unsent command, another message, and someone else's unsend leave a new request waiting
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-2', 'rt-ask-2'), 10000)]);
      await webhook([unsend('cmd-1', inGroup1, 11000), unsend('g-9', inGroup1, 11000), unsend('cmd-2', { ...inGroup1, userId: 'Ub' }, 11000)]);
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-yes-2'), 12000)]);

      assert.strictEqual(replyTo('rt-yes-2'), `好，群組收集檔裡你的 2 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`);
    });

    it('when the answer to the deciding 「確定」 does not get through and LINE redelivers it, it gets the same answer again and never reaches the brain', async () => {
      await boot({ GROUP_COLLECT: '1' });
      const clock = useClock(T);
      await webhook([inGroup('A 的電話 0912', 'Ua', 'g-1', 'rt-1')]);
      await webhook([at(inGroup('忘了我', 'Ua', 'cmd-1', 'rt-ask'), 1000)]);

      clock.now = T + 5000;
      const confirm = at(inGroup('確定', 'Ua', 'g-2', 'rt-yes'), 5000);
      replyMessage.mock.mockImplementationOnce(async () => {
        throw new Error('LINE reply 500');
      });
      const first = await webhook([confirm]);
      clock.now = T + 25000;
      const again = await webhook([{ ...confirm, deliveryContext: { isRedelivery: true } }]);

      assert.deepStrictEqual([first.status, again.status], [500, 200]);
      assert.strictEqual(replyTo('rt-yes'), `好，群組收集檔裡你的 1 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。\n\n${COPIES}`, 'the count from when it was deleted');
      assert.strictEqual(chatCalls.length, 1, 'only the first line went to the brain');
      assert.deepStrictEqual(rows('Ggroup1').map((r) => [r.text, r.redacted]), [[undefined, 'forget']], 'the redelivered 「確定」 is not stored either');

      // a new 「確定」 afterwards is an ordinary message
      await webhook([at(inGroup('確定', 'Ua', 'g-3', 'rt-later'), 30000)]);
      assert.strictEqual(replyTo('rt-later'), '這是回覆');
    });
  });
});
