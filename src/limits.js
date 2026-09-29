// Webhook 防護：請求大小上限＋按 LINE userId 限流（issue #2）。不加依賴。
// 注意：所有 webhook 都從 LINE 平台的 IP 打進來，所以限流要按 userId，不能按 IP。

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// 在 line.middleware 讀 body 之前，用 content-length 擋掉過大的請求。
// maxBytes <= 0 表示不限。
function bodySizeLimit(maxBytes) {
  return (req, res, next) => {
    const len = Number(req.headers['content-length']);
    if (maxBytes > 0 && Number.isFinite(len) && len > maxBytes) {
      res.status(413).json({ error: 'Payload Too Large' });
      return;
    }
    next();
  };
}

// 固定時間窗計數：每個 userId 在 windowMs 內最多 max 次。max <= 0 表示不限。
function createUserRateLimiter({ max, windowMs, now = Date.now }) {
  const buckets = new Map();

  function prune(t) {
    for (const [key, b] of buckets) {
      if (b.resetAt <= t) buckets.delete(key);
    }
  }

  return {
    allow(userId) {
      if (!userId || max <= 0) return true;
      const t = now();
      if (buckets.size > 10000) prune(t);
      let b = buckets.get(userId);
      if (!b || b.resetAt <= t) {
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(userId, b);
      }
      b.count += 1;
      return b.count <= max;
    },
    size() {
      return buckets.size;
    }
  };
}

function loadLimitsConfig() {
  return {
    maxBodyBytes: envInt('WEBHOOK_MAX_BODY_BYTES', 262144),
    rateLimitMax: envInt('WEBHOOK_RATE_LIMIT_MAX', 20),
    rateLimitWindowMs: envInt('WEBHOOK_RATE_LIMIT_WINDOW_SEC', 60) * 1000
  };
}

module.exports = { bodySizeLimit, createUserRateLimiter, loadLimitsConfig };
