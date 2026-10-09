'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { isolateEnv } = require('./helpers/support');
const history = require('../src/history');

describe('history', () => {
  let restoreEnv;
  let clock;
  const realNow = history.now;

  beforeEach(() => {
    restoreEnv = isolateEnv();
    history._store.clear();
    clock = 1000000;
    history.now = () => clock;
  });

  afterEach(() => {
    history.now = realNow;
    history._store.clear();
    restoreEnv();
  });

  describe('enabled', () => {
    it('is off when HISTORY_TURNS is unset, empty, zero, negative or not a number', () => {
      assert.strictEqual(history.enabled(), false);
      for (const value of ['', '0', '-3', 'abc']) {
        process.env.HISTORY_TURNS = value;
        assert.strictEqual(history.enabled(), false, `HISTORY_TURNS=${JSON.stringify(value)}`);
      }
    });

    it('is on for a positive number', () => {
      process.env.HISTORY_TURNS = '3';
      assert.strictEqual(history.enabled(), true);
    });
  });

  describe('keyOf', () => {
    it('prefers groupId, then roomId, then userId', () => {
      assert.strictEqual(history.keyOf({ groupId: 'G1', roomId: 'R1', userId: 'U1' }), 'G1');
      assert.strictEqual(history.keyOf({ roomId: 'R1', userId: 'U1' }), 'R1');
      assert.strictEqual(history.keyOf({ userId: 'U1' }), 'U1');
    });

    it('returns an empty key when there is nothing to key on', () => {
      assert.strictEqual(history.keyOf(null), '');
      assert.strictEqual(history.keyOf(undefined), '');
      assert.strictEqual(history.keyOf({}), '');
    });
  });

  describe('isClearCommand', () => {
    it('matches the default words on the whole trimmed sentence only', () => {
      assert.strictEqual(history.isClearCommand('/clear'), true);
      assert.strictEqual(history.isClearCommand('  清除對話  '), true);
      assert.strictEqual(history.isClearCommand('忘記剛剛'), true);
      assert.strictEqual(history.isClearCommand('請 /clear 一下'), false);
      assert.strictEqual(history.isClearCommand('hello'), false);
      assert.strictEqual(history.isClearCommand(''), false);
      assert.strictEqual(history.isClearCommand(null), false);
    });

    it('uses HISTORY_CLEAR_WORDS instead of the defaults when set', () => {
      process.env.HISTORY_CLEAR_WORDS = ' reset | 重來 ';
      assert.strictEqual(history.isClearCommand('reset'), true);
      assert.strictEqual(history.isClearCommand('重來'), true);
      assert.strictEqual(history.isClearCommand('/clear'), false);
    });
  });

  describe('record and toMessages', () => {
    beforeEach(() => {
      process.env.HISTORY_TURNS = '2';
    });

    it('returns turns as alternating user/assistant messages, oldest first', () => {
      history.record('U1', 'q1', 'a1');
      history.record('U1', 'q2', 'a2');

      assert.deepStrictEqual(history.toMessages('U1'), [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' }
      ]);
    });

    it('keeps only the most recent HISTORY_TURNS turns', () => {
      history.record('U1', 'q1', 'a1');
      history.record('U1', 'q2', 'a2');
      history.record('U1', 'q3', 'a3');

      assert.deepStrictEqual(
        history.toMessages('U1').map((m) => m.content),
        ['q2', 'a2', 'q3', 'a3']
      );
    });

    it('keeps conversations apart by key', () => {
      history.record('U1', 'mine', 'reply-1');
      history.record('U2', 'yours', 'reply-2');

      assert.deepStrictEqual(history.toMessages('U1').map((m) => m.content), ['mine', 'reply-1']);
      assert.deepStrictEqual(history.toMessages('U2').map((m) => m.content), ['yours', 'reply-2']);
      assert.deepStrictEqual(history.toMessages('nobody'), []);
    });

    it('ignores records with an empty key', () => {
      history.record('', 'q', 'a');
      assert.strictEqual(history._store.size, 0);
    });

    it('clear forgets one conversation only', () => {
      history.record('U1', 'q', 'a');
      history.record('U2', 'q', 'a');

      history.clear('U1');

      assert.deepStrictEqual(history.toMessages('U1'), []);
      assert.strictEqual(history.toMessages('U2').length, 2);
    });
  });

  describe('expiry', () => {
    beforeEach(() => {
      process.env.HISTORY_TURNS = '5';
    });

    it('forgets a conversation after HISTORY_TTL_MIN of silence (default 60)', () => {
      history.record('U1', 'q', 'a');

      clock += 59 * 60 * 1000;
      assert.strictEqual(history.toMessages('U1').length, 2, 'still remembered at 59 min');

      clock += 2 * 60 * 1000;
      assert.deepStrictEqual(history.toMessages('U1'), []);
      assert.strictEqual(history._store.has('U1'), false, 'expired entry is dropped from the store');
    });

    it('honours a custom HISTORY_TTL_MIN and falls back to 60 for bad values', () => {
      process.env.HISTORY_TTL_MIN = '1';
      history.record('U1', 'q', 'a');
      clock += 61 * 1000;
      assert.deepStrictEqual(history.toMessages('U1'), []);

      for (const bad of ['0', '-5', 'abc']) {
        process.env.HISTORY_TTL_MIN = bad;
        history.record('U2', 'q', 'a');
        clock += 30 * 60 * 1000;
        assert.strictEqual(history.toMessages('U2').length, 2, `HISTORY_TTL_MIN=${bad} should mean 60 minutes`);
        history.clear('U2');
      }
    });

    it('a new turn refreshes the clock', () => {
      history.record('U1', 'q1', 'a1');
      clock += 40 * 60 * 1000;
      history.record('U1', 'q2', 'a2');
      clock += 40 * 60 * 1000;

      assert.deepStrictEqual(history.toMessages('U1').map((m) => m.content), ['q1', 'a1', 'q2', 'a2']);
    });
  });

  describe('capacity', () => {
    it('evicts the least recently active conversation beyond MAX_KEYS', () => {
      process.env.HISTORY_TURNS = '1';
      for (let i = 0; i < history.MAX_KEYS; i += 1) {
        history.record(`U${i}`, 'q', 'a');
      }
      // Touch the oldest one so it becomes the newest.
      history.record('U0', 'q2', 'a2');

      history.record('overflow', 'q', 'a');

      assert.strictEqual(history._store.size, history.MAX_KEYS);
      assert.strictEqual(history._store.has('U1'), false, 'U1 was the least recently active');
      assert.strictEqual(history._store.has('U0'), true, 'U0 was refreshed, so it survives');
      assert.strictEqual(history._store.has('overflow'), true);
    });
  });
});
