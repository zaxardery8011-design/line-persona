'use strict';

// Shared helpers for the test suite. Nothing here runs at load time, so it is
// harmless that `node --test` also picks this file up (it runs every .js file
// under test/).
//
// Why a sandbox: several modules (escalation, group, absorb, server) build
// their data paths from __dirname, i.e. <repo>/data. Tests must never write
// there, so each test copies src/ into a fresh temp directory and loads the
// copy. The code under test is byte-for-byte the real code; only its location
// changes. node_modules is linked in so `require('express')` etc. still work.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TMP_PREFIX = 'line-persona-test-';

// Every env var the app reads. Tests start from a clean slate so a developer's
// real shell settings can never leak into (or out of) a test.
const ENV_PATTERN = /^(LINE_|LLM_|GROUP_|HISTORY_|ESCALATION_|WEBHOOK_)/;

function isolateEnv(overrides) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (ENV_PATTERN.test(key) || key === 'PORT') delete process.env[key];
  }
  Object.assign(process.env, overrides || {});
  return function restore() {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };
}

// Env for child processes: same clean slate, plus explicit extras.
function childEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (ENV_PATTERN.test(key) || key === 'PORT') delete env[key];
  }
  return Object.assign(env, extra || {});
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function createSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)));
  copyDir(path.join(REPO_ROOT, 'src'), path.join(root, 'src'));
  const modulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), modulesLink, 'junction');

  const sandbox = {
    root,
    dataDir: path.join(root, 'data'),

    path(...parts) {
      return path.join(root, ...parts);
    },

    write(rel, content) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return target;
    },

    read(rel) {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    },

    exists(rel) {
      return fs.existsSync(path.join(root, rel));
    },

    // Replace the real LLM adapter in the sandbox copy. `chat` receives the
    // messages array, exactly like the real adapter. Call before load().
    stubLlm(chat) {
      globalThis.__lpTestChat = chat;
      sandbox.write(
        path.join('src', 'adapters', 'llm.js'),
        "module.exports = { chat: (...args) => globalThis.__lpTestChat(...args) };\n"
      );
    },

    // Fresh require of a sandbox module: drops every cached sandbox module
    // first, so module-level state (rate limiter, history store, env read at
    // load time) starts clean for each call.
    load(rel) {
      purgeCache(root);
      return require(path.join(root, rel));
    },

    // Plain require of a sandbox module, keeping what load() already cached.
    // Use it to reach the same module instance another module is using.
    require(rel) {
      return require(path.join(root, rel));
    },

    cleanup() {
      purgeCache(root);
      delete globalThis.__lpTestChat;
      // Remove the node_modules link first so rm can never follow it into the
      // real node_modules. Then refuse to delete anything that is not one of
      // our own temp directories.
      try {
        fs.unlinkSync(modulesLink);
      } catch (_error) {
        try {
          fs.rmdirSync(modulesLink);
        } catch (_error2) {
          // handled by the guard below
        }
      }
      const stillLinked = fs.existsSync(modulesLink);
      const ours = path.basename(root).startsWith(TMP_PREFIX) && path.dirname(root) === fs.realpathSync(os.tmpdir());
      if (stillLinked || !ours) {
        throw new Error(`refusing to delete sandbox ${root} (link removed: ${!stillLinked}, own temp dir: ${ours})`);
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  };

  return sandbox;
}

function purgeCache(root) {
  const prefix = root + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

// Replace global fetch. By default any call throws, so a test that forgets to
// mock the network fails loudly instead of reaching the internet.
function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {}, body: parseBody(init) });
    if (!handler) throw new Error(`unexpected network call in test: ${url}`);
    return handler(String(url), init || {});
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

function parseBody(init) {
  if (!init || typeof init.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch (_error) {
    return null;
  }
}

function fakeResponse({ ok = true, status = 200, json = {}, text = '' } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text
  };
}

// Minimal HTTP client for the local ephemeral-port server tests. Uses node:http
// directly so it does not depend on (and is not affected by) the fetch mock.
function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

module.exports = {
  REPO_ROOT,
  isolateEnv,
  childEnv,
  createSandbox,
  installFetch,
  fakeResponse,
  request,
  sign
};
