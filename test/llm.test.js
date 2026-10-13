'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { isolateEnv, installFetch, fakeResponse } = require('./helpers/support');
const { chat } = require('../src/adapters/llm');

const MESSAGES = [{ role: 'user', content: 'hi' }];

describe('llm adapter chat()', () => {
  let restoreEnv;
  let net;

  afterEach(() => {
    net.restore();
    restoreEnv();
  });

  function setup(handler) {
    restoreEnv = isolateEnv();
    net = installFetch(handler);
  }

  describe('when not configured', () => {
    beforeEach(() => setup());

    it('returns a setup hint and makes no request without LLM_BASE_URL', async () => {
      process.env.LLM_MODEL = 'm';
      assert.match(await chat(MESSAGES), /LLM 尚未設定完成/);
      assert.strictEqual(net.calls.length, 0);
    });

    it('returns a setup hint and makes no request without LLM_MODEL', async () => {
      process.env.LLM_BASE_URL = 'http://llm.test/v1';
      assert.match(await chat(MESSAGES), /LLM 尚未設定完成/);
      assert.strictEqual(net.calls.length, 0);
    });
  });

  describe('request', () => {
    beforeEach(() => {
      setup(async () => fakeResponse({ json: { choices: [{ message: { content: '  hello  ' } }] } }));
      process.env.LLM_BASE_URL = 'http://llm.test/v1///';
      process.env.LLM_MODEL = 'test-model';
    });

    it('posts to <base>/chat/completions with model, messages and temperature', async () => {
      const reply = await chat(MESSAGES);

      assert.strictEqual(reply, 'hello', 'content is trimmed');
      assert.strictEqual(net.calls.length, 1);
      const [call] = net.calls;
      assert.strictEqual(call.url, 'http://llm.test/v1/chat/completions', 'trailing slashes are trimmed');
      assert.strictEqual(call.init.method, 'POST');
      assert.strictEqual(call.init.headers['Content-Type'], 'application/json');
      assert.deepStrictEqual(call.body, { model: 'test-model', messages: MESSAGES, temperature: 0.7 });
    });

    it('sends a Bearer header only when LLM_API_KEY is set', async () => {
      await chat(MESSAGES);
      assert.strictEqual('Authorization' in net.calls[0].init.headers, false, 'local Ollama needs no key');

      process.env.LLM_API_KEY = 'test-key-not-real';
      await chat(MESSAGES);
      assert.strictEqual(net.calls[1].init.headers.Authorization, 'Bearer test-key-not-real');
    });
  });

  describe('response handling', () => {
    beforeEach(() => {
      setup();
      process.env.LLM_BASE_URL = 'http://llm.test/v1';
      process.env.LLM_MODEL = 'test-model';
    });

    it('falls back to a fixed sentence when the model returns no usable text', async () => {
      const unusable = [
        { choices: [] },
        { choices: [{ message: { content: '   ' } }] },
        { choices: [{ message: {} }] },
        {},
        null
      ];
      for (const json of unusable) {
        globalThis.fetch = async () => fakeResponse({ json });
        assert.strictEqual(await chat(MESSAGES), '我目前沒有產生可用回覆。', JSON.stringify(json));
      }
    });

    it('throws with the status and a truncated body on a non-2xx answer', async () => {
      globalThis.fetch = async () => fakeResponse({ ok: false, status: 429, text: 'x'.repeat(900) });

      await assert.rejects(
        () => chat(MESSAGES),
        (error) => {
          assert.match(error.message, /^LLM request failed with 429: x+$/);
          assert.strictEqual(error.message.length, 'LLM request failed with 429: '.length + 500);
          return true;
        }
      );
    });
  });
});
