const os = require('os');
const config = require('./config.js');

// Grafana metrics for JWT Pizza. Everything here is best effort: no function in this
// module may throw into a request or crash the process.

const SEND_INTERVAL_MS = 10000;
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const METHODS = ['GET', 'PUT', 'POST', 'DELETE'];

const startTimeUnixNano = nowNano();

// Cumulative counters (never reset, so Grafana can use rate()/increase())
const requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0, OTHER: 0 };
const authAttempts = { success: 0, failure: 0 };
const pizza = { sold: 0, failures: 0, revenue: 0 };

// Latency is reported as the average over each send interval
const latency = { service: { sum: 0, count: 0 }, pizza: { sum: 0, count: 0 } };

// userId -> last time the user made an authenticated request or logged in
const activeUsers = new Map();

function nowNano() {
  return String(BigInt(Date.now()) * 1000000n);
}

function touchUser(userId) {
  if (userId !== undefined && userId !== null) {
    activeUsers.set(userId, Date.now());
  }
}

function getActiveUserCount(now = Date.now()) {
  for (const [userId, lastSeen] of activeUsers) {
    if (now - lastSeen > ACTIVE_USER_WINDOW_MS) {
      activeUsers.delete(userId);
    }
  }
  return activeUsers.size;
}

// Express middleware: counts every request by method and records its latency
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const method = METHODS.includes(req.method) ? req.method : 'OTHER';
      requests[method]++;
      latency.service.sum += Number(process.hrtime.bigint() - start) / 1e6;
      latency.service.count++;
      if (req.user && !req.metricsLoggedOut) {
        touchUser(req.user.id);
      }
    } catch (err) {
      console.error('metrics requestTracker error', err);
    }
  });
  next();
}

function authAttempt(success, userId) {
  authAttempts[success ? 'success' : 'failure']++;
  if (success) {
    touchUser(userId);
  }
}

// Route middleware for login/register: a 200 response is a successful attempt,
// anything else (400 missing fields, 404 bad credentials, 500) is a failure.
function authTracker(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    res.locals.authUserId = body?.user?.id;
    return json(body);
  };
  res.on('finish', () => authAttempt(res.statusCode === 200, res.locals.authUserId));
  next();
}

function userLogout(req) {
  if (req.user) {
    activeUsers.delete(req.user.id);
    req.metricsLoggedOut = true;
  }
}

function pizzaPurchase(success, latencyMs, price, count) {
  if (success) {
    pizza.sold += count;
    pizza.revenue += price;
  } else {
    pizza.failures++;
  }
  latency.pizza.sum += latencyMs;
  latency.pizza.count++;
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  return Number(((usedMemory / totalMemory) * 100).toFixed(2));
}

function averageAndReset(bucket) {
  const avg = bucket.count ? bucket.sum / bucket.count : 0;
  bucket.sum = 0;
  bucket.count = 0;
  return avg;
}

function attributes(attrs) {
  return Object.entries({ source: config.metrics?.source, ...attrs }).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

function dataPoint(value, attrs, timeUnixNano) {
  return { asDouble: value, timeUnixNano, attributes: attributes(attrs) };
}

function sum(name, unit, points) {
  return {
    name,
    unit,
    sum: {
      dataPoints: points.map((p) => ({ ...p, startTimeUnixNano })),
      aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      isMonotonic: true,
    },
  };
}

function gauge(name, unit, points) {
  return { name, unit, gauge: { dataPoints: points } };
}

function buildPayload() {
  const t = nowNano();
  const metrics = [
    sum('http_requests', '1', [...METHODS, 'OTHER'].map((method) => dataPoint(requests[method], { method }, t))),
    sum(
      'auth_attempts',
      '1',
      ['success', 'failure'].map((status) => dataPoint(authAttempts[status], { status }, t))
    ),
    sum('pizza_sold', '1', [dataPoint(pizza.sold, {}, t)]),
    sum('pizza_failures', '1', [dataPoint(pizza.failures, {}, t)]),
    sum('pizza_revenue', '1', [dataPoint(pizza.revenue, {}, t)]),
    gauge('active_users', '{users}', [dataPoint(getActiveUserCount(), {}, t)]),
    gauge('cpu_usage', '%', [dataPoint(getCpuUsagePercentage(), {}, t)]),
    gauge('memory_usage', '%', [dataPoint(getMemoryUsagePercentage(), {}, t)]),
    gauge('service_latency', 'ms', [dataPoint(averageAndReset(latency.service), {}, t)]),
    gauge('pizza_creation_latency', 'ms', [dataPoint(averageAndReset(latency.pizza), {}, t)]),
  ];
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes({ 'service.name': config.metrics?.source }) },
        scopeMetrics: [{ scope: { name: 'jwt-pizza-service' }, metrics }],
      },
    ],
  };
}

function isConfigured() {
  const m = config.metrics;
  return !!(m && m.endpointUrl && m.accountId && m.apiKey && !m.endpointUrl.startsWith('<'));
}

async function sendMetrics() {
  try {
    if (!isConfigured()) {
      return false;
    }
    const { endpointUrl, accountId, apiKey } = config.metrics;
    const res = await fetch(endpointUrl, {
      method: 'POST',
      body: JSON.stringify(buildPayload()),
      headers: { Authorization: `Bearer ${accountId}:${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(`Failed to push metrics to Grafana: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error pushing metrics', err);
    return false;
  }
}

let timer = null;
function start(intervalMs = SEND_INTERVAL_MS) {
  if (!timer) {
    if (!isConfigured()) {
      console.log('Metrics not configured; skipping Grafana reporting');
    }
    timer = setInterval(sendMetrics, intervalMs);
    timer.unref();
  }
  return timer;
}

function stop() {
  clearInterval(timer);
  timer = null;
}

// Never report from Jest runs
if (process.env.JEST_WORKER_ID === undefined) {
  start();
}

module.exports = {
  requestTracker,
  authTracker,
  authAttempt,
  userLogout,
  pizzaPurchase,
  getActiveUserCount,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
  buildPayload,
  sendMetrics,
  start,
  stop,
  ACTIVE_USER_WINDOW_MS,
};
