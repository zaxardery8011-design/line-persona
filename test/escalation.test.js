'use strict';

// Escalation (human handoff). Every test runs against a sandbox copy of src/ in a
// temp directory, with fetch mocked, so no ticket, log or push can leave the test.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
const { createSandbox, isolateEnv, childEnv, installFetch, fakeResponse } = require('./helpers/support');

const TOKEN = 'test-token-not-real';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const ESC_DIR = 'data/escalations';
const ACK = '（已經幫你登記了，有答案會主動回你）';
const TRIGGER_REPLY = '這題我不確定，幫你轉達真人。';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const hashOf = (userId) => 'U' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);

describe('escalation', () => {
  let sandbox;
  let restoreEnv;
  let net;
  let esc;
  let warn;

  const useFetch = (handler) => {
    net.restore();
    net = installFetch(handler);
  };
  const failHandler = (status, text) => async () => fakeResponse({ ok: false, status, text });

  function seed(id, fields) {
    const ticket = {
      id,
      status: 'pending',
      userId: 'Uasker',
      question: '問題',
      ts: new Date().toISOString(),
      follow_ups: [],
      follow_up_count: 0,
      urgency: 'normal',
      last_follow_up_at: null,
      answer: null,
      resolved_at: null,
      resolved_by: null,
      push_status: null,
      reminder_count: 0,
      last_reminded_at: null,
      ...fields
    };
    sandbox.write(`${ESC_DIR}/${id}`, JSON.stringify(ticket));
    return ticket;
  }

  const ticketOnDisk = (id) => JSON.parse(sandbox.read(`${ESC_DIR}/${id}`));
  const ticketFiles = () => (sandbox.exists(ESC_DIR) ? fs.readdirSync(sandbox.path(ESC_DIR)) : [])
    .filter((n) => n.endsWith('.json') && !n.startsWith('_'));
  const failures = () => (sandbox.exists(`${ESC_DIR}/_notify_failures.jsonl`)
    ? sandbox.read(`${ESC_DIR}/_notify_failures.jsonl`).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const pushedTo = () => net.calls.map((c) => c.body.to);

  beforeEach(() => {
    restoreEnv = isolateEnv({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN });
    sandbox = createSandbox();
    net = installFetch(async () => fakeResponse());
    warn = mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
    esc = sandbox.load('src/escalation.js');
  });

  afterEach(() => {
    mock.restoreAll();
    net.restore();
    sandbox.cleanup();
    restoreEnv();
  });

  describe('switch and trigger words', () => {
    it('is on only for 1, true or on (any case, trimmed)', () => {
      assert.strictEqual(esc.isEnabled(), false);
      for (const [value, expected] of [['', false], ['0', false], ['yes', false], ['1', true], ['true', true], [' ON ', true], ['True', true]]) {
        process.env.ESCALATION_ENABLED = value;
        assert.strictEqual(esc.isEnabled(), expected, `ESCALATION_ENABLED=${JSON.stringify(value)}`);
      }
    });

    it('recognises the built-in "cannot answer" phrases', () => {
      for (const reply of ['我幫你轉達真人', '我不確定耶', '這個我不知道', '需要本人確認喔', '無法回答這題']) {
        assert.strictEqual(esc.looksUnanswered(reply), true, reply);
      }
      for (const reply of ['營業時間是十點到六點', '', null, undefined]) {
        assert.strictEqual(esc.looksUnanswered(reply), false, String(reply));
      }
    });

    it('ESCALATION_TRIGGERS replaces the built-in list', () => {
      process.env.ESCALATION_TRIGGERS = ' 價格 | 報價 ';
      assert.strictEqual(esc.looksUnanswered('請問價格'), true);
      assert.strictEqual(esc.looksUnanswered('要報價嗎'), true);
      assert.strictEqual(esc.looksUnanswered('我不確定'), false, 'defaults no longer apply');
    });
  });

  describe('maybeEscalate', () => {
    const ctx = { userId: 'Uasker', text: '報價多少' };

    beforeEach(() => {
      process.env.ESCALATION_ENABLED = '1';
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1,Uresp2';
    });

    it('returns the reply untouched, with no file and no message, when switched off', async () => {
      process.env.ESCALATION_ENABLED = '';

      assert.strictEqual(await esc.maybeEscalate(ctx, TRIGGER_REPLY), TRIGGER_REPLY);
      assert.strictEqual(sandbox.exists('data'), false);
      assert.strictEqual(net.calls.length, 0);
    });

    it('leaves a confident reply alone even when switched on', async () => {
      assert.strictEqual(await esc.maybeEscalate(ctx, '十點到六點'), '十點到六點');
      assert.strictEqual(sandbox.exists('data'), false);
      assert.strictEqual(net.calls.length, 0);
    });

    it('opens a ticket, notifies every responder and appends the acknowledgement', async () => {
      const result = await esc.maybeEscalate(ctx, TRIGGER_REPLY);

      assert.strictEqual(result, `${TRIGGER_REPLY}\n\n${ACK}`);
      const [file] = ticketFiles();
      assert.match(file, /^\d{4}-\d{2}-\d{2}T\d{9}Z_U[0-9a-f]{12}\.json$/);
      assert.ok(file.endsWith(`_${hashOf('Uasker')}.json`), 'file name carries the hashed asker, not the raw id');
      const ticket = ticketOnDisk(file);
      assert.strictEqual(ticket.id, file);
      assert.strictEqual(ticket.status, 'pending');
      assert.strictEqual(ticket.userId, 'Uasker');
      assert.strictEqual(ticket.question, '報價多少');
      assert.strictEqual(ticket.urgency, 'normal');
      assert.strictEqual(ticket.push_status, null);
      assert.strictEqual(ticket.reminder_count, 0);

      assert.deepStrictEqual(pushedTo(), ['Uresp1', 'Uresp2']);
      for (const call of net.calls) {
        assert.strictEqual(call.url, PUSH_URL);
        assert.strictEqual(call.init.headers.Authorization, `Bearer ${TOKEN}`);
        const text = call.body.messages[0].text;
        assert.ok(text.includes(file), 'notification names the ticket');
        assert.ok(text.includes('問題：報價多少'));
        assert.ok(text.includes(`node src/escalation.js answer ${file}`));
      }
    });

    it('uses ESCALATION_ACK_TEXT when given', async () => {
      process.env.ESCALATION_ACK_TEXT = '已通知店長';
      assert.strictEqual(await esc.maybeEscalate(ctx, TRIGGER_REPLY), `${TRIGGER_REPLY}\n\n已通知店長`);
    });

    it('merges a repeat question from the same person into one ticket and notifies only once', async () => {
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      const second = await esc.maybeEscalate({ ...ctx, text: '怎麼還沒回' }, TRIGGER_REPLY);

      assert.strictEqual(second, `${TRIGGER_REPLY}\n\n${ACK}`, 'the person still gets the acknowledgement');
      const files = ticketFiles();
      assert.strictEqual(files.length, 1);
      const ticket = ticketOnDisk(files[0]);
      assert.strictEqual(ticket.follow_up_count, 1);
      assert.strictEqual(ticket.follow_ups[0].question, '怎麼還沒回');
      assert.ok(ticket.last_follow_up_at);
      assert.strictEqual(ticket.urgency, 'normal');
      assert.strictEqual(net.calls.length, 2, 'no extra notification for a follow-up');
    });

    it('marks a ticket urgent from the second follow-up on', async () => {
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);

      const [file] = ticketFiles();
      assert.strictEqual(ticketOnDisk(file).follow_up_count, 2);
      assert.strictEqual(ticketOnDisk(file).urgency, 'urgent');
    });

    it('opens a new ticket once the dedupe window has passed', async () => {
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      const [first] = ticketFiles();
      seed(first, { ...ticketOnDisk(first), ts: new Date(Date.now() - 2 * 3600000).toISOString() });

      await esc.maybeEscalate(ctx, TRIGGER_REPLY);

      assert.strictEqual(ticketFiles().length, 2);
      assert.strictEqual(net.calls.length, 4, 'the new ticket notified both responders again');
    });

    it('ESCALATION_DEDUPE_MIN changes the window', async () => {
      process.env.ESCALATION_DEDUPE_MIN = '1';
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      const [first] = ticketFiles();
      seed(first, { ...ticketOnDisk(first), ts: new Date(Date.now() - 5 * 60000).toISOString() });

      await esc.maybeEscalate(ctx, TRIGGER_REPLY);

      assert.strictEqual(ticketFiles().length, 2);
    });

    it('keeps different people on different tickets', async () => {
      await esc.maybeEscalate(ctx, TRIGGER_REPLY);
      await esc.maybeEscalate({ userId: 'Uother', text: '我也想問' }, TRIGGER_REPLY);

      assert.strictEqual(ticketFiles().length, 2);
    });

    it('records a failure and leaves the reply alone when there is no userId to answer back to', async () => {
      const result = await esc.maybeEscalate({ text: '誰在問' }, TRIGGER_REPLY);

      assert.strictEqual(result, TRIGGER_REPLY);
      assert.strictEqual(ticketFiles().length, 0);
      assert.strictEqual(net.calls.length, 0);
      assert.deepStrictEqual(failures().map((f) => f.reason), ['missing_user_id']);
    });

    it('never breaks the main reply if the module itself fails', async () => {
      sandbox.write('data', 'a file where the data directory should be');

      assert.strictEqual(await esc.maybeEscalate(ctx, TRIGGER_REPLY), TRIGGER_REPLY);
      assert.strictEqual(console.error.mock.callCount(), 1);
      assert.match(String(console.error.mock.calls[0].arguments[0]), /\[escalation\]/);
    });
  });

  describe('openTicket', () => {
    it('caps the stored question at 2000 characters and tolerates a missing one', async () => {
      const long = await esc.openTicket('Uasker', 'q'.repeat(3000));
      const none = await esc.openTicket('Uother', undefined);

      assert.strictEqual(long.isNew, true);
      assert.strictEqual(long.ticket.question.length, 2000);
      assert.strictEqual(none.ticket.question, '');
    });
  });

  describe('notifyResponders (throat 1: zero recipients must leave a record)', () => {
    const ticket = { id: 't1.json', userId: 'Uasker', question: '問題' };

    it('logs no_responder_configured instead of silently doing nothing', async () => {
      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 0, ok: 0 });
      assert.strictEqual(net.calls.length, 0);
      const [row] = failures();
      assert.strictEqual(row.reason, 'no_responder_configured');
      assert.strictEqual(row.ticket_id, 't1.json');
      assert.strictEqual(row.asker, hashOf('Uasker'));
      assert.strictEqual(row.detail, null);
      assert.ok(!Number.isNaN(Date.parse(row.ts)));
      assert.match(String(warn.mock.calls.at(-1).arguments[0]), /no_responder_configured/);
    });

    it('logs no_responder_available when the only responder is the asker and skipping is on', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uasker';
      process.env.ESCALATION_NOTIFY_SKIP_ASKER = '1';

      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 0, ok: 0 });
      assert.deepStrictEqual(failures().map((f) => f.reason), ['no_responder_available']);
    });

    it('notifies the asker too by default (skipping is opt-in)', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uasker';

      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 1, ok: 1 });
      assert.deepStrictEqual(pushedTo(), ['Uasker']);
      assert.deepStrictEqual(failures(), []);
    });

    it('skips only the asker when skipping is on and others remain', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uasker,Uresp1';
      process.env.ESCALATION_NOTIFY_SKIP_ASKER = '1';

      await esc.notifyResponders(ticket);

      assert.deepStrictEqual(pushedTo(), ['Uresp1']);
    });

    it('never writes the raw asker id into the failure log', async () => {
      await esc.notifyResponders(ticket);
      assert.strictEqual(sandbox.read(`${ESC_DIR}/_notify_failures.jsonl`).includes('Uasker'), false);
    });

    it('counts a partial failure and logs the failing push', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1,Uresp2';
      useFetch(async (_url, init) => (JSON.parse(init.body).to === 'Uresp1'
        ? fakeResponse()
        : fakeResponse({ ok: false, status: 500, text: 'boom' })));

      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 2, ok: 1 });
      const rows = failures();
      assert.deepStrictEqual(rows.map((r) => r.reason), ['push_failed']);
      assert.strictEqual(rows[0].detail, 'LINE push 500: boom');
    });

    it('logs every failed push plus all_push_failed when nobody could be reached', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1,Uresp2';
      useFetch(failHandler(503, 'down'));

      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 2, ok: 0 });
      assert.deepStrictEqual(failures().map((f) => f.reason), ['push_failed', 'push_failed', 'all_push_failed']);
    });

    it('treats a missing channel token as a failed push, not a crash', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1';
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;

      const outcome = await esc.notifyResponders(ticket);

      assert.deepStrictEqual(outcome, { attempted: 1, ok: 0 });
      assert.strictEqual(net.calls.length, 0);
      assert.strictEqual(failures()[0].detail, 'LINE_CHANNEL_ACCESS_TOKEN is empty');
    });

    it('sends the override text instead of the default notification', async () => {
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1';
      await esc.notifyResponders(ticket, '自訂內容');
      assert.strictEqual(net.calls[0].body.messages[0].text, '自訂內容');
    });
  });

  describe('listTickets', () => {
    it('returns an empty list when nothing was ever stored', async () => {
      assert.deepStrictEqual(await esc.listTickets(), []);
    });

    it('sorts oldest first, filters by status and ignores bookkeeping files', async () => {
      seed('b.json', { ts: daysAgo(5) });
      seed('a.json', { ts: daysAgo(1) });
      seed('c.json', { ts: daysAgo(3), status: 'resolved' });
      sandbox.write(`${ESC_DIR}/_flow_state.json`, '{}');
      sandbox.write(`${ESC_DIR}/_notify_failures.jsonl`, '{}\n');
      sandbox.write(`${ESC_DIR}/notes.txt`, 'not a ticket');

      assert.deepStrictEqual((await esc.listTickets()).map((t) => t.id), ['b.json', 'c.json', 'a.json']);
      assert.deepStrictEqual((await esc.listTickets('pending')).map((t) => t.id), ['b.json', 'a.json']);
      assert.deepStrictEqual((await esc.listTickets('resolved')).map((t) => t.id), ['c.json']);
    });
  });

  describe('listStale (throat 2: old tickets must resurface)', () => {
    it('lists a 10-day-old pending ticket and leaves out fresh or resolved ones', async () => {
      seed('old.json', { ts: daysAgo(10) });
      seed('fresh.json', { ts: daysAgo(1) });
      seed('done.json', { ts: daysAgo(10), status: 'resolved' });

      assert.deepStrictEqual((await esc.listStale(3)).map((t) => t.id), ['old.json']);
    });

    it('defaults to a 3-day threshold and accepts fractions of a day', async () => {
      seed('two.json', { ts: daysAgo(2) });
      seed('four.json', { ts: daysAgo(4) });

      assert.deepStrictEqual((await esc.listStale()).map((t) => t.id), ['four.json']);
      assert.deepStrictEqual((await esc.listStale(1.5)).map((t) => t.id), ['four.json', 'two.json'], 'oldest first');
    });
  });

  describe('remind', () => {
    beforeEach(() => {
      process.env.ESCALATION_NOTIFY_TO = 'Uresp1,Uresp2';
    });

    it('dry-run reports what it would do and sends and changes nothing', async () => {
      seed('ten.json', { ts: daysAgo(10) });
      seed('five.json', { ts: daysAgo(5) });
      seed('fresh.json', { ts: daysAgo(1) });

      const results = await esc.remind(3);

      assert.deepStrictEqual(results.slice(0, 2).map((r) => [r.id, r.dry_run, r.would_notify]), [
        ['ten.json', true, 2],
        ['five.json', true, 2]
      ]);
      const summary = results.at(-1);
      assert.strictEqual(summary.summary, true);
      assert.strictEqual(summary.dry_run, true);
      assert.strictEqual(summary.tickets_listed, 2);
      assert.strictEqual(summary.pushes, 2);
      assert.match(summary.text, /^【逾期未回】2 張單沒人回，最久 10\.0 天/);
      assert.strictEqual(net.calls.length, 0);
      assert.strictEqual(ticketOnDisk('ten.json').reminder_count, 0);
    });

    it('with send, pushes one digest per responder and counts the reminder on each ticket', async () => {
      seed('ten.json', { ts: daysAgo(10) });
      seed('five.json', { ts: daysAgo(5) });

      const results = await esc.remind(3, { send: true });

      assert.deepStrictEqual(pushedTo(), ['Uresp1', 'Uresp2'], 'two tickets, still only one message each');
      assert.strictEqual(net.calls[0].body.messages[0].text, net.calls[1].body.messages[0].text);
      assert.deepStrictEqual(results.at(-1), { summary: true, dry_run: false, tickets_listed: 2, pushes: 2, ok: 2 });
      for (const id of ['ten.json', 'five.json']) {
        assert.strictEqual(ticketOnDisk(id).reminder_count, 1);
        assert.ok(ticketOnDisk(id).last_reminded_at);
      }
    });

    it('stays one message per responder with a backlog, listing at most 10 tickets', async () => {
      for (let i = 1; i <= 12; i += 1) {
        seed(`t${String(i).padStart(2, '0')}.json`, { ts: daysAgo(30 - i), question: i === 1 ? 'x'.repeat(100) : `問題${i}` });
      }

      await esc.remind(3, { send: true });

      assert.strictEqual(net.calls.length, 2);
      const text = net.calls[0].body.messages[0].text;
      assert.match(text, /^【逾期未回】12 張單沒人回，最久 29\.0 天/);
      assert.match(text, /^1\. t01\.json／29\.0 天／x{40}／已提醒 0 次$/m, 'oldest first, question cut to 40 characters');
      assert.ok(!text.includes('x'.repeat(41)));
      assert.match(text, /^10\. t10\.json/m);
      assert.doesNotMatch(text, /^11\. /m);
      assert.match(text, /…還有 2 張/);
      assert.match(text, /全部：node src\/escalation\.js stale 3$/);
      assert.ok(text.length <= 4500);
    });

    it('sends nothing when no ticket is due, in dry-run or for real', async () => {
      seed('fresh.json', { ts: daysAgo(1) });

      assert.deepStrictEqual(await esc.remind(3), [{ summary: true, dry_run: true, tickets_listed: 0, pushes: 0 }]);
      assert.deepStrictEqual(await esc.remind(3, { send: true }), [{ summary: true, dry_run: false, tickets_listed: 0, pushes: 0 }]);
      assert.strictEqual(net.calls.length, 0);
    });

    it('does not use up a reminder when no push got through, and logs the failures', async () => {
      seed('old.json', { ts: daysAgo(10) });
      useFetch(failHandler(500, 'down'));

      const results = await esc.remind(3, { send: true });

      assert.strictEqual(ticketOnDisk('old.json').reminder_count, 0);
      assert.deepStrictEqual(results[0], { id: 'old.json', age_days: results[0].age_days, attempted: 2, ok: 0 });
      assert.deepStrictEqual(failures().map((f) => [f.reason, f.ticket_id]), [
        ['push_failed', '(remind_digest:1)'],
        ['push_failed', '(remind_digest:1)'],
        ['all_push_failed', '(remind_digest:1)']
      ]);

      useFetch(async () => fakeResponse());
      await esc.remind(3, { send: true });
      assert.strictEqual(ticketOnDisk('old.json').reminder_count, 1, 'the next healthy run still counts');
    });

    it('records no_responder_configured when there is nobody to remind', async () => {
      delete process.env.ESCALATION_NOTIFY_TO;
      seed('old.json', { ts: daysAgo(10) });

      await esc.remind(3, { send: true });

      assert.deepStrictEqual(failures().map((f) => f.reason), ['no_responder_configured']);
      assert.strictEqual(ticketOnDisk('old.json').reminder_count, 0);
    });

    it('stops reminding a ticket after ESCALATION_MAX_REMINDERS', async () => {
      process.env.ESCALATION_MAX_REMINDERS = '2';
      seed('old.json', { ts: daysAgo(10) });

      await esc.remind(3, { send: true });
      await esc.remind(3, { send: true });
      const third = await esc.remind(3, { send: true });

      assert.strictEqual(ticketOnDisk('old.json').reminder_count, 2);
      assert.strictEqual(net.calls.length, 4, 'two runs x two responders, nothing on the third');
      assert.strictEqual(third[0].id, 'old.json');
      assert.strictEqual(third[0].skipped, 'reminder_cap_reached');
      assert.deepStrictEqual(third.at(-1), { summary: true, dry_run: false, tickets_listed: 0, pushes: 0 });
    });

    it('with skip-asker on, leaves out a responder only when every ticket in the digest is theirs', async () => {
      process.env.ESCALATION_NOTIFY_SKIP_ASKER = '1';
      seed('mine.json', { ts: daysAgo(10), userId: 'Uresp1' });

      await esc.remind(3, { send: true });
      assert.deepStrictEqual(pushedTo(), ['Uresp2']);

      seed('other.json', { ts: daysAgo(9), userId: 'Usomeone' });
      await esc.remind(3, { send: true });
      assert.deepStrictEqual(pushedTo().slice(1), ['Uresp1', 'Uresp2']);
    });
  });

  describe('claim, skip, defer (throat 3: progress lives on disk)', () => {
    beforeEach(() => {
      seed('old.json', { ts: daysAgo(5) });
      seed('mid.json', { ts: daysAgo(3) });
      seed('new.json', { ts: daysAgo(1) });
    });

    const flowState = () => JSON.parse(sandbox.read(`${ESC_DIR}/_flow_state.json`));

    it('hands out the oldest ticket and keeps handing out the same one until it is released', async () => {
      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
      assert.strictEqual(flowState().Uresp1.holding.id, 'old.json');
    });

    it('still returns the held ticket after a restart', async () => {
      await esc.claim('Uresp1');

      esc = sandbox.load('src/escalation.js'); // a fresh process: no in-memory state

      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
    });

    it('lets an urgent ticket jump the queue', async () => {
      seed('urgent.json', { ts: daysAgo(0.5), urgency: 'urgent' });
      assert.strictEqual((await esc.claim('Uresp1')).id, 'urgent.json');
    });

    it('gives each responder an independent slot', async () => {
      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
      assert.strictEqual((await esc.claim('Uresp2')).id, 'old.json');
    });

    it('skip releases the ticket for this responder for good, but not for others', async () => {
      await esc.claim('Uresp1');

      const released = await esc.skip('Uresp1');

      assert.deepStrictEqual(released, { id: 'old.json', action: 'skipped', remind_after: null });
      assert.strictEqual((await esc.claim('Uresp1')).id, 'mid.json');
      assert.strictEqual((await esc.claim('Uresp2')).id, 'old.json');
    });

    it('defer hides the ticket until its time, then offers it again', async () => {
      await esc.claim('Uresp1');

      const before = Date.now();
      const released = await esc.defer('Uresp1', 2);

      assert.strictEqual(released.id, 'old.json');
      assert.strictEqual(released.action, 'deferred');
      const due = Date.parse(released.remind_after);
      assert.ok(due >= before + 2 * 3600000 - 1000 && due <= Date.now() + 2 * 3600000 + 1000);

      assert.strictEqual((await esc.claim('Uresp1')).id, 'mid.json', 'old.json is hidden for now');
      await esc.skip('Uresp1');
      assert.strictEqual((await esc.claim('Uresp1')).id, 'new.json');
      await esc.skip('Uresp1');

      const state = flowState();
      state.Uresp1.skipped['old.json'].remind_after = new Date(Date.now() - 1000).toISOString();
      sandbox.write(`${ESC_DIR}/_flow_state.json`, JSON.stringify(state));

      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json', 'its time has come');
    });

    it('defer defaults to 24 hours', async () => {
      await esc.claim('Uresp1');
      const released = await esc.defer('Uresp1');
      const hours = (Date.parse(released.remind_after) - Date.now()) / 3600000;
      assert.ok(hours > 23.9 && hours <= 24, `deferred for ${hours} hours`);
    });

    it('skip or defer with nothing in hand does nothing', async () => {
      assert.strictEqual(await esc.skip('Uresp1'), null);
      assert.strictEqual(await esc.defer('Uresp1', 1), null);
    });

    it('moves on when the held ticket was resolved by someone else', async () => {
      await esc.claim('Uresp1');
      seed('old.json', { ts: daysAgo(5), status: 'resolved' });

      assert.strictEqual((await esc.claim('Uresp1')).id, 'mid.json');
    });

    it('returns null and holds nothing when no ticket is pending', async () => {
      for (const id of ['old.json', 'mid.json', 'new.json']) seed(id, { status: 'resolved' });

      assert.strictEqual(await esc.claim('Uresp1'), null);
      assert.strictEqual(flowState().Uresp1.holding, null);
    });

    it('recovers from a corrupt state file', async () => {
      sandbox.write(`${ESC_DIR}/_flow_state.json`, 'not json{');

      assert.strictEqual((await esc.claim('Uresp1')).id, 'old.json');
      assert.match(String(warn.mock.calls.at(-1).arguments[0]), /_flow_state\.json/);
      assert.strictEqual(flowState().Uresp1.holding.id, 'old.json', 'rewritten as valid JSON');
    });
  });

  describe('resolve (the push receipt)', () => {
    beforeEach(() => {
      seed('t1.json', { userId: 'Uasker', question: '報價多少' });
    });

    it('rejects an unknown ticket', async () => {
      await assert.rejects(() => esc.resolve('nope.json', '答案', 'Uresp1'), /ticket not found: nope\.json/);
    });

    it('without send, saves a draft: the asker gets nothing and the ticket stays pending', async () => {
      const done = await esc.resolve('t1.json', '三百元', 'Uresp1');

      assert.strictEqual(done.status, 'pending');
      assert.strictEqual(done.push_status, 'draft_saved');
      assert.strictEqual(done.answer, '三百元');
      assert.strictEqual(net.calls.length, 0);
      assert.deepStrictEqual(ticketOnDisk('t1.json'), done);
      assert.strictEqual((await esc.listTickets('pending')).length, 1);
    });

    it('with send, pushes to the original asker and records push_status ok', async () => {
      const done = await esc.resolve('t1.json', '三百元', 'Uresp1', { send: true });

      assert.strictEqual(done.status, 'resolved');
      assert.strictEqual(done.push_status, 'ok');
      assert.strictEqual(done.resolved_by, 'Uresp1');
      assert.ok(done.resolved_at);
      assert.strictEqual(net.calls.length, 1);
      assert.strictEqual(net.calls[0].url, PUSH_URL);
      assert.strictEqual(net.calls[0].body.to, 'Uasker');
      assert.strictEqual(net.calls[0].body.messages[0].text, '三百元');
      assert.deepStrictEqual(ticketOnDisk('t1.json'), done);
      assert.strictEqual((await esc.listTickets('pending')).length, 0);
    });

    it('writes a failed push into push_status instead of swallowing it', async () => {
      useFetch(failHandler(500, 'denied'));

      const done = await esc.resolve('t1.json', '三百元', 'Uresp1', { send: true });

      assert.strictEqual(done.push_status, 'failed: LINE push 500: denied');
      assert.strictEqual(ticketOnDisk('t1.json').push_status, 'failed: LINE push 500: denied');
    });

    it('records a missing channel token the same way', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;

      const done = await esc.resolve('t1.json', '三百元', 'Uresp1', { send: true });

      assert.strictEqual(done.push_status, 'failed: LINE_CHANNEL_ACCESS_TOKEN is empty');
      assert.strictEqual(net.calls.length, 0);
    });

    it('cuts an over-long answer to the 5000 characters LINE allows', async () => {
      await esc.resolve('t1.json', 'a'.repeat(6000), 'Uresp1', { send: true });
      assert.strictEqual(net.calls[0].body.messages[0].text.length, 5000);
    });
  });

  describe('command line', () => {
    function cli(...args) {
      const result = spawnSync(process.execPath, [sandbox.path('src', 'escalation.js'), ...args], {
        cwd: sandbox.root,
        env: childEnv(),
        encoding: 'utf8'
      });
      assert.strictEqual(result.status, 0, `exit ${result.status}: ${result.stderr}`);
      return result.stdout;
    }

    // Only commands that cannot send (no --send) are run here: a child process cannot be given the fetch mock.

    it('prints usage built from the header comment when given no command', () => {
      const out = cli();
      assert.match(out, /^node src\/escalation\.js list/m);
      assert.match(out, /^node src\/escalation\.js answer <單號> "答案" \[--send\]/m);
    });

    it('list shows an empty queue as []', () => {
      assert.strictEqual(cli('list').trim(), '[]');
    });

    it('stale 3 shows a ticket that was manually aged to 10 days, and hides a fresh one', () => {
      seed('aged.json', { ts: daysAgo(10), question: '很久了' });
      seed('fresh.json', { ts: daysAgo(1) });

      const rows = JSON.parse(cli('stale', '3'));

      assert.deepStrictEqual(rows.map((r) => r.id), ['aged.json']);
      assert.ok(rows[0].age_days >= 10);
      assert.strictEqual(rows[0].asker, hashOf('Uasker'), 'the listing shows a hash, not the raw LINE id');
    });

    it('remind without --send is a dry-run and changes nothing', () => {
      seed('aged.json', { ts: daysAgo(10) });

      const out = cli('remind', '3');

      assert.match(out, /"dry_run": true/);
      assert.match(out, /以上為 dry-run/);
      assert.strictEqual(ticketOnDisk('aged.json').reminder_count, 0);
    });

    it('claim returns the same ticket twice, and says so when the queue is empty', () => {
      assert.match(cli('claim', 'Uresp1'), /目前沒有待回覆的單/);
      seed('old.json', { ts: daysAgo(5) });
      seed('new.json', { ts: daysAgo(1) });

      assert.strictEqual(JSON.parse(cli('claim', 'Uresp1')).id, 'old.json');
      assert.strictEqual(JSON.parse(cli('claim', 'Uresp1')).id, 'old.json');
    });

    it('answer without --send only saves a draft', () => {
      seed('t1.json', {});

      const out = cli('answer', 't1.json', '三百元');

      assert.match(out, /"push_status": "draft_saved"/);
      assert.match(out, /草稿已存/);
      assert.strictEqual(ticketOnDisk('t1.json').answer, '三百元');
      assert.strictEqual(ticketOnDisk('t1.json').status, 'pending');
    });
  });
});
