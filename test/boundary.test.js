'use strict';

// Boundary playtest: the smallest inputs that touch each edge of the webhook, the limit
// variables, odd event shapes and extreme data files. Results are written up in
// docs/playtest-boundary.md. Everything runs in a sandbox copy; the secret and token are
// made-up test values and the LINE API and the LLM are mocked.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
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

describe('boundary playtest: webhook', () => {
  let sandbox;
  let restoreEnv;
  let net;
  let replies;
  let chatCalls;
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

  function post(body) {
    const headers = { 'content-type': 'application/json', 'x-line-signature': sign(SECRET, body) };
    return request(port, { method: 'POST', path: '/webhook', headers, body });
  }

  const webhook = (events) => post(JSON.stringify({ destination: 'Udest', events }));

  // A signed `{"destination":"Udest","events":[]}` padded with spaces to exactly `bytes` bytes.
  function paddedEmptyBody(bytes) {
    const base = JSON.stringify({ destination: 'Udest', events: [] });
    return base.slice(0, -1) + ' '.repeat(bytes - Buffer.byteLength(base)) + '}';
  }

  beforeEach(() => {
    restoreEnv = isolateEnv({ NODE_ENV: 'test', LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: TOKEN });
    sandbox = createSandbox();
    net = installFetch();
    replies = [];
    chatCalls = [];
    mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
    mock.method(line.messagingApi.MessagingApiClient.prototype, 'replyMessage', async (req) => {
      replies.push(req);
      return { sentMessages: [{ id: 'sent-1' }] };
    });
    mock.method(line.messagingApi.MessagingApiClient.prototype, 'showLoadingAnimation', async () => ({}));
    sandbox.write('persona/profile.md', '名字: 小安');
    sandbox.write('persona/knowledge.md', 'FAQ: 週一公休');
    sandbox.stubLlm(async (messages) => {
      chatCalls.push(messages);
      return '這是回覆';
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

  describe('request size', () => {
    it('accepts a body of exactly WEBHOOK_MAX_BODY_BYTES and rejects one byte more with 413', async () => {
      await boot({ WEBHOOK_MAX_BODY_BYTES: '200' });

      const exact = paddedEmptyBody(200);
      assert.strictEqual(Buffer.byteLength(exact), 200);
      const ok = await post(exact);
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(JSON.parse(ok.text), []);

      const over = paddedEmptyBody(201);
      const res = await post(over);
      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(JSON.parse(res.text), { error: 'Payload Too Large' });
    });

    it('answers an empty signed body with a short JSON 400', async () => {
      await boot();
      const res = await post('');
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(JSON.parse(res.text), { error: 'Invalid JSON' });
      assert.strictEqual(chatCalls.length, 0);
    });

    it('answers a signed body that is plain text with a short JSON 400', async () => {
      await boot();
      const res = await post('hello');
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(JSON.parse(res.text), { error: 'Invalid JSON' });
    });
  });

  describe('events field', () => {
    it('answers 400 when events is an object, null or missing, or the body is not an object', async () => {
      await boot();
      for (const body of [{ events: {} }, { events: null }, { destination: 'Udest' }, null, [], 1, 'text']) {
        const res = await post(JSON.stringify(body));
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.deepStrictEqual(JSON.parse(res.text), { error: 'Invalid events' });
      }
      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(replies.length, 0);
    });

    it('answers 200 with an empty list for an empty events array', async () => {
      await boot();
      const res = await webhook([]);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), []);
    });
  });

  describe('odd events', () => {
    it('ignores an event without a type, and one with an unknown type', async () => {
      await boot();
      const { type: _type, ...noType } = textEvent('hi');

      const res = await webhook([noType, { ...textEvent('hi'), type: 'somethingNew' }]);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.text), [null, null]);
      assert.strictEqual(chatCalls.length, 0);
      assert.strictEqual(replies.length, 0);
    });

    it('still answers a text message without a source (no userId, so no rate limit applies)', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '1' });
      const { source: _source, ...noSource } = textEvent('hi');

      const res = await webhook([noSource, noSource]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(chatCalls.length, 2);
      assert.strictEqual(replies.length, 2);
    });

    it('sends an empty string to the brain when a text message has no text', async () => {
      await boot();
      const event = textEvent('x');
      delete event.message.text;

      const res = await webhook([event]);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(chatCalls.length, 1);
      assert.strictEqual(chatCalls[0].at(-1).content, '');
      assert.deepStrictEqual(replies.map((r) => r.messages[0].text), ['這是回覆']);
    });

    it('skips a null event and a message event without a message, and handles the rest of the batch', async () => {
      await boot();
      const { message: _message, ...noMessage } = textEvent('hi');

      const res = await webhook([null, noMessage, textEvent('hi')]);

      assert.strictEqual(res.status, 200);
      const results = JSON.parse(res.text);
      assert.deepStrictEqual(results.slice(0, 2), [null, null]);
      assert.strictEqual(chatCalls.length, 1);
      assert.strictEqual(replies.length, 1);
    });
  });

  describe('rate limit variables at the server', () => {
    it('WEBHOOK_RATE_LIMIT_MAX=1: the first message is answered, the second is dropped', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '1' });
      await webhook([textEvent('a'), textEvent('b')]);
      assert.strictEqual(chatCalls.length, 1);
      assert.strictEqual(replies.length, 1);
    });

    it('WEBHOOK_RATE_LIMIT_WINDOW_SEC=0: every message starts a new window, so nothing is dropped', async () => {
      await boot({ WEBHOOK_RATE_LIMIT_MAX: '1', WEBHOOK_RATE_LIMIT_WINDOW_SEC: '0' });
      await webhook([textEvent('a'), textEvent('b'), textEvent('c')]);
      assert.strictEqual(replies.length, 3);
    });
  });

  describe('data/groups.json extremes', () => {
    const groupEvent = () => textEvent('a', { source: { type: 'group', groupId: 'Ggroup1', userId: 'Uuser1' } });

    it('is created when missing, and an empty file, {}, or invalid JSON is replaced with a valid list', async () => {
      await boot();
      for (const content of [null, '', '{}', '{not json']) {
        if (content !== null) sandbox.write('data/groups.json', content);
        const res = await webhook([groupEvent()]);
        assert.strictEqual(res.status, 200, String(content));
        assert.deepStrictEqual(JSON.parse(sandbox.read('data/groups.json')), ['Ggroup1'], String(content));
      }
    });

    it('appends to an empty list', async () => {
      await boot();
      sandbox.write('data/groups.json', '[]');
      await webhook([groupEvent()]);
      assert.deepStrictEqual(JSON.parse(sandbox.read('data/groups.json')), ['Ggroup1']);
    });
  });
});

describe('boundary playtest: limit variables', () => {
  let sandbox;
  let restoreEnv;
  let limits;

  beforeEach(() => {
    restoreEnv = isolateEnv();
    sandbox = createSandbox();
    limits = sandbox.load('src/limits.js');
  });

  afterEach(() => {
    sandbox.cleanup();
    restoreEnv();
  });

  const NAMES = ['WEBHOOK_MAX_BODY_BYTES', 'WEBHOOK_RATE_LIMIT_MAX', 'WEBHOOK_RATE_LIMIT_WINDOW_SEC'];
  const DEFAULTS = { maxBodyBytes: 262144, rateLimitMax: 20, rateLimitWindowMs: 60000 };

  function configWith(value) {
    for (const name of NAMES) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return limits.loadLimitsConfig();
  }

  it('uses the defaults when unset or empty', () => {
    assert.deepStrictEqual(configWith(undefined), DEFAULTS);
    assert.deepStrictEqual(configWith(''), DEFAULTS);
  });

  it('reads 0 as 0 (no limit) and 1 as 1', () => {
    assert.deepStrictEqual(configWith('0'), { maxBodyBytes: 0, rateLimitMax: 0, rateLimitWindowMs: 0 });
    assert.deepStrictEqual(configWith('1'), { maxBodyBytes: 1, rateLimitMax: 1, rateLimitWindowMs: 1000 });
  });

  it('falls back to the defaults for a negative number, a non-number, or a number too big to be finite', () => {
    for (const value of ['-1', 'abc', '1e309']) {
      assert.deepStrictEqual(configWith(value), DEFAULTS, value);
    }
  });

  it('rounds a fraction down', () => {
    assert.deepStrictEqual(configWith('1.9'), { maxBodyBytes: 1, rateLimitMax: 1, rateLimitWindowMs: 1000 });
  });

  it('a very large WEBHOOK_RATE_LIMIT_MAX is taken as is and lets every message through', () => {
    process.env.WEBHOOK_RATE_LIMIT_MAX = '99999999999999999999';
    const { rateLimitMax } = limits.loadLimitsConfig();
    assert.strictEqual(rateLimitMax, 1e20);

    const limiter = limits.createUserRateLimiter({ max: rateLimitMax, windowMs: 60000, now: () => 0 });
    for (let i = 0; i < 1000; i++) assert.strictEqual(limiter.allow('Uuser1'), true);
  });
});

describe('boundary playtest: escalation _flow_state.json extremes', () => {
  const ESC_DIR = 'data/escalations';
  let sandbox;
  let restoreEnv;
  let net;
  let esc;

  beforeEach(() => {
    restoreEnv = isolateEnv({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN });
    sandbox = createSandbox();
    net = installFetch();
    mock.method(console, 'warn', () => {});
    esc = sandbox.load('src/escalation.js');
    for (const [id, daysAgo] of [['old.json', 3], ['new.json', 1]]) {
      sandbox.write(`${ESC_DIR}/${id}`, JSON.stringify({
        id, status: 'pending', userId: 'Uasker', question: '問題', urgency: 'normal',
        ts: new Date(Date.now() - daysAgo * 86400000).toISOString()
      }));
    }
  });

  afterEach(() => {
    mock.restoreAll();
    net.restore();
    sandbox.cleanup();
    restoreEnv();
  });

  const flowState = () => JSON.parse(sandbox.read(`${ESC_DIR}/_flow_state.json`));

  for (const [label, content] of [['missing', null], ['empty', ''], ['invalid JSON', '{'], ['{}', '{}'], ['[]', '[]']]) {
    it(`starts from an empty state when the file is ${label}, and claim then skip keep their progress`, async () => {
      if (content !== null) sandbox.write(`${ESC_DIR}/_flow_state.json`, content);

      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
      assert.strictEqual(flowState().Uresp1.holding.id, 'old.json');

      assert.strictEqual((await esc.skip('Uresp1')).id, 'old.json');
      assert.strictEqual((await esc.claim('Uresp1')).id, 'new.json');
    });
  }
});

describe('boundary playtest: persona file extremes', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    sandbox.cleanup();
  });

  it('an empty or whitespace-only profile.md is used as empty text, without the built-in fallback', () => {
    for (const content of ['', '  \n\n ']) {
      sandbox.write('persona/profile.md', content);
      sandbox.write('persona/knowledge.md', 'FAQ: 週一公休');
      const { loadPersona } = sandbox.load('src/persona.js');
      assert.strictEqual(loadPersona(), '# Profile\n\n\n# Knowledge\nFAQ: 週一公休');
    }
  });
});
