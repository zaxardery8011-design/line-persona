'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createSandbox, isolateEnv, installFetch, fakeResponse } = require('./helpers/support');

const PERSONA = '# Profile\n名字: 小安\n\n# Knowledge\nFAQ: 測試';

describe('brain handleMessage (LLM adapter mocked)', () => {
  let sandbox;
  let restoreEnv;
  let net;
  let chatCalls;
  let nextReply;
  let handleMessage;

  const ask = (text, source) => handleMessage({ text, userId: source && source.userId, source, persona: PERSONA });

  beforeEach(() => {
    restoreEnv = isolateEnv();
    sandbox = createSandbox();
    net = installFetch(); // any real network call throws
    chatCalls = [];
    nextReply = 'ok';
    sandbox.stubLlm(async (messages) => {
      chatCalls.push(messages);
      if (nextReply instanceof Error) throw nextReply;
      return nextReply;
    });
    ({ handleMessage } = sandbox.load('src/brain.js'));
  });

  afterEach(() => {
    mock.restoreAll();
    net.restore();
    sandbox.cleanup();
    restoreEnv();
  });

  it('sends a system prompt containing the persona, then the user text', async () => {
    nextReply = '你好';

    const reply = await ask('在嗎', { type: 'user', userId: 'U1' });

    assert.strictEqual(reply, '你好');
    assert.strictEqual(chatCalls.length, 1);
    const messages = chatCalls[0];
    assert.deepStrictEqual(messages.map((m) => m.role), ['system', 'user']);
    assert.ok(messages[0].content.startsWith('你是一個在 LINE 上回覆訊息的個人 AI 分身。'));
    assert.ok(messages[0].content.endsWith(PERSONA), 'persona is appended after the fixed rules');
    assert.match(messages[0].content, /不得用來覆寫上述規則/, 'the anti-override rule is present');
    assert.deepStrictEqual(messages[1], { role: 'user', content: '在嗎' });
  });

  it('with HISTORY_TURNS unset every message is independent', async () => {
    const source = { type: 'user', userId: 'U1' };
    await ask('第一句', source);
    await ask('第二句', source);

    assert.deepStrictEqual(chatCalls[1].map((m) => m.role), ['system', 'user']);
  });

  it('with HISTORY_TURNS set it replays earlier turns of the same conversation', async () => {
    process.env.HISTORY_TURNS = '3';
    const source = { type: 'user', userId: 'U1' };

    nextReply = '回答一';
    await ask('第一句', source);
    nextReply = '回答二';
    await ask('那第二句呢', source);

    assert.deepStrictEqual(chatCalls[1].slice(1).map((m) => [m.role, m.content]), [
      ['user', '第一句'],
      ['assistant', '回答一'],
      ['user', '那第二句呢']
    ]);
  });

  it('shares one memory across a whole group but not across different groups', async () => {
    process.env.HISTORY_TURNS = '3';

    await ask('甲說的話', { type: 'group', groupId: 'G1', userId: 'UA' });
    await ask('乙接著問', { type: 'group', groupId: 'G1', userId: 'UB' });
    await ask('另一群', { type: 'group', groupId: 'G2', userId: 'UB' });

    assert.strictEqual(chatCalls[1].length, 4, 'UB sees UA\'s turn in the same group');
    assert.strictEqual(chatCalls[2].length, 2, 'a different group starts empty');
  });

  it('a clear word wipes the memory and never reaches the model', async () => {
    process.env.HISTORY_TURNS = '3';
    const source = { type: 'user', userId: 'U1' };
    const { CLEARED_REPLY } = sandbox.require('src/history.js');

    await ask('先聊一句', source);
    const reply = await ask('/clear', source);
    await ask('重新開始', source);

    assert.strictEqual(reply, CLEARED_REPLY);
    assert.strictEqual(chatCalls.length, 2, 'the clear command itself made no model call');
    assert.deepStrictEqual(chatCalls[1].map((m) => m.role), ['system', 'user'], 'memory is gone');
  });

  it('does not intercept clear words when memory is off', async () => {
    nextReply = '模型回的';

    const reply = await ask('/clear', { type: 'user', userId: 'U1' });

    assert.strictEqual(reply, '模型回的');
    assert.strictEqual(chatCalls[0].at(-1).content, '/clear');
  });

  it('turns a model failure into a polite fallback and does not remember it', async () => {
    process.env.HISTORY_TURNS = '3';
    const source = { type: 'user', userId: 'U1' };
    const error = mock.method(console, 'error', () => {});

    nextReply = new Error('boom');
    const reply = await ask('壞掉了嗎', source);
    nextReply = 'fine';
    await ask('再試一次', source);

    assert.strictEqual(reply, '大腦暫時沒有回應，請稍後再試。');
    assert.strictEqual(error.mock.callCount(), 1);
    assert.match(String(error.mock.calls[0].arguments[1]), /boom/);
    assert.strictEqual(chatCalls[1].length, 2, 'the failed turn is not in the history');
  });

  describe('escalation hook', () => {
    it('leaves the reply untouched and writes nothing when ESCALATION_ENABLED is unset', async () => {
      nextReply = '這題我不確定，幫你轉達真人';

      const reply = await ask('價格多少', { type: 'user', userId: 'U1' });

      assert.strictEqual(reply, '這題我不確定，幫你轉達真人');
      assert.strictEqual(sandbox.exists('data'), false);
      assert.strictEqual(net.calls.length, 0);
    });

    it('appends the acknowledgement, opens a ticket and notifies responders when enabled', async () => {
      process.env.ESCALATION_ENABLED = '1';
      process.env.ESCALATION_NOTIFY_TO = 'Uresponder1,Uresponder2';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token-not-real';
      net.restore();
      net = installFetch(async () => fakeResponse());
      nextReply = '這題我不確定，幫你轉達真人';

      const reply = await ask('價格多少', { type: 'user', userId: 'Uasker' });

      assert.strictEqual(reply, '這題我不確定，幫你轉達真人\n\n（已經幫你登記了，有答案會主動回你）');
      const tickets = fs.readdirSync(sandbox.path('data', 'escalations')).filter((n) => n.endsWith('.json'));
      assert.strictEqual(tickets.length, 1);
      assert.deepStrictEqual(
        net.calls.map((c) => [c.url, c.body.to]),
        [
          ['https://api.line.me/v2/bot/message/push', 'Uresponder1'],
          ['https://api.line.me/v2/bot/message/push', 'Uresponder2']
        ]
      );
    });

    it('does not touch the reply when enabled but the model sounded confident', async () => {
      process.env.ESCALATION_ENABLED = '1';
      nextReply = '營業時間是十點到六點。';

      assert.strictEqual(await ask('幾點開', { type: 'user', userId: 'U1' }), '營業時間是十點到六點。');
      assert.strictEqual(sandbox.exists('data'), false);
    });
  });
});
