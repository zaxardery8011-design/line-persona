const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { bodySizeLimit, createUserRateLimiter } = require('../src/limits');

test('same userId over the limit is blocked, other users are not', () => {
  let t = 0;
  const limiter = createUserRateLimiter({ max: 3, windowMs: 60000, now: () => t });

  assert.deepStrictEqual([1, 2, 3].map(() => limiter.allow('U_a')), [true, true, true]);
  assert.strictEqual(limiter.allow('U_a'), false);
  assert.strictEqual(limiter.allow('U_b'), true);

  t = 60000;
  assert.strictEqual(limiter.allow('U_a'), true, 'window resets');
});

test('max 0 disables rate limiting', () => {
  const limiter = createUserRateLimiter({ max: 0, windowMs: 60000 });
  for (let i = 0; i < 100; i++) assert.strictEqual(limiter.allow('U_a'), true);
});

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, method: 'POST', path: '/webhook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('request over the size limit gets 413 before reaching the next middleware', async () => {
  let reached = 0;
  const app = express();
  app.post('/webhook', bodySizeLimit(100), (_req, res) => {
    reached += 1;
    res.status(200).end();
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  try {
    assert.strictEqual(await post(port, 'x'.repeat(101)), 413);
    assert.strictEqual(reached, 0);
    assert.strictEqual(await post(port, 'x'.repeat(100)), 200);
    assert.strictEqual(reached, 1);
  } finally {
    server.close();
  }
});
