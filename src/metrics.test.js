const express = require('express');
const request = require('supertest');
const config = require('./config.js');
const metrics = require('./metrics.js');

const originalMetricsConfig = config.metrics;

// Pull one metric out of an OTLP payload
function findMetric(payload, name) {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
}

function points(metric) {
  return (metric.sum ?? metric.gauge).dataPoints;
}

function attr(point, key) {
  return point.attributes.find((a) => a.key === key)?.value.stringValue;
}

function pointValue(payload, name, key, value) {
  const metric = findMetric(payload, name);
  const point = key ? points(metric).find((p) => attr(p, key) === value) : points(metric)[0];
  return point.asDouble;
}

// Tiny app that exercises the middleware without touching the database
function testApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.user) req.user = { id: Number(req.headers.user) };
    next();
  });
  app.use(metrics.requestTracker);
  app.put('/auth', metrics.authTracker, (req, res) => {
    if (req.body.ok) return res.json({ user: { id: req.body.id }, token: 't' });
    res.status(404).json({ message: 'unknown user' });
  });
  app.delete('/auth', (req, res) => {
    metrics.userLogout(req);
    res.json({ message: 'logout successful' });
  });
  app.all('/thing', (req, res) => res.send('ok'));
  return app;
}

beforeEach(() => {
  config.metrics = { source: 'jwt-pizza-service-test', endpointUrl: 'https://otlp.example.com/otlp/v1/metrics', accountId: '123', apiKey: 'glc_key' };
});

afterEach(() => {
  config.metrics = originalMetricsConfig;
  jest.restoreAllMocks();
  metrics.stop();
});

test('counts requests by method and records latency', async () => {
  const app = testApp();
  const before = metrics.buildPayload();
  await request(app).get('/thing');
  await request(app).post('/thing');
  await request(app).put('/thing');
  await request(app).delete('/thing');
  await request(app).patch('/thing');
  const after = metrics.buildPayload();

  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OTHER']) {
    expect(pointValue(after, 'http_requests', 'method', method) - pointValue(before, 'http_requests', 'method', method)).toBe(1);
  }
  expect(pointValue(after, 'service_latency')).toBeGreaterThan(0);
  // latency is averaged per interval and reset after each payload
  expect(pointValue(metrics.buildPayload(), 'service_latency')).toBe(0);
});

test('tracks auth attempts and active users', async () => {
  const app = testApp();
  const before = metrics.buildPayload();
  const activeBefore = metrics.getActiveUserCount();

  await request(app).put('/auth').send({ ok: true, id: 9001 });
  await request(app).put('/auth').send({ ok: false });
  const after = metrics.buildPayload();

  expect(pointValue(after, 'auth_attempts', 'status', 'success') - pointValue(before, 'auth_attempts', 'status', 'success')).toBe(1);
  expect(pointValue(after, 'auth_attempts', 'status', 'failure') - pointValue(before, 'auth_attempts', 'status', 'failure')).toBe(1);
  expect(metrics.getActiveUserCount()).toBe(activeBefore + 1);

  // An authenticated request keeps the user active; logout removes them for good
  await request(app).get('/thing').set('user', '9002');
  expect(metrics.getActiveUserCount()).toBe(activeBefore + 2);
  await request(app).delete('/auth').set('user', '9002');
  await request(app).delete('/auth');
  expect(metrics.getActiveUserCount()).toBe(activeBefore + 1);
});

test('active users expire after the window', () => {
  metrics.authAttempt(true, 'expiring-user');
  const count = metrics.getActiveUserCount();
  expect(metrics.getActiveUserCount(Date.now() + metrics.ACTIVE_USER_WINDOW_MS + 1000)).toBeLessThan(count);
});

test('tracks pizza purchases', () => {
  const before = metrics.buildPayload();
  metrics.pizzaPurchase(true, 100, 0.05, 2);
  metrics.pizzaPurchase(false, 300, 0, 0);
  const after = metrics.buildPayload();

  expect(pointValue(after, 'pizza_sold') - pointValue(before, 'pizza_sold')).toBe(2);
  expect(pointValue(after, 'pizza_failures') - pointValue(before, 'pizza_failures')).toBe(1);
  expect(pointValue(after, 'pizza_revenue') - pointValue(before, 'pizza_revenue')).toBeCloseTo(0.05);
  expect(pointValue(after, 'pizza_creation_latency')).toBe(200);
});

test('payload uses cumulative sums, gauges and the source attribute', () => {
  const payload = metrics.buildPayload();
  const requests = findMetric(payload, 'http_requests');
  expect(requests.sum.isMonotonic).toBe(true);
  expect(requests.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
  expect(points(requests)[0].startTimeUnixNano).toBeDefined();

  for (const name of ['cpu_usage', 'memory_usage', 'active_users', 'service_latency', 'pizza_creation_latency']) {
    expect(findMetric(payload, name).gauge).toBeDefined();
  }
  for (const metric of payload.resourceMetrics[0].scopeMetrics[0].metrics) {
    expect(attr(points(metric)[0], 'source')).toBe('jwt-pizza-service-test');
  }
  expect(attr(payload.resourceMetrics[0].resource, 'source')).toBe('jwt-pizza-service-test');
});

test('cpu and memory are percentages', () => {
  for (const value of [metrics.getCpuUsagePercentage(), metrics.getMemoryUsagePercentage()]) {
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(metrics.getMemoryUsagePercentage()).toBeLessThanOrEqual(100);
});

test('sends metrics with bearer auth', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  expect(await metrics.sendMetrics()).toBe(true);

  const [url, options] = fetchSpy.mock.calls[0];
  expect(url).toBe('https://otlp.example.com/otlp/v1/metrics');
  expect(options.method).toBe('POST');
  expect(options.headers).toEqual({ Authorization: 'Bearer 123:glc_key', 'Content-Type': 'application/json' });
  expect(JSON.parse(options.body).resourceMetrics).toHaveLength(1);
});

test('send failures are logged, never thrown', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' });
  expect(await metrics.sendMetrics()).toBe(false);

  global.fetch.mockRejectedValueOnce(new Error('network down'));
  expect(await metrics.sendMetrics()).toBe(false);
  expect(console.error).toHaveBeenCalledTimes(2);
});

test('skips sending when not configured', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch');
  config.metrics = { source: 'x', endpointUrl: '<OTLP endpoint>', accountId: '<id>', apiKey: '<key>' };
  expect(await metrics.sendMetrics()).toBe(false);
  config.metrics = undefined;
  expect(await metrics.sendMetrics()).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('start schedules an unref timer once', () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  config.metrics = undefined;
  const timer = metrics.start(60000);
  expect(metrics.start(60000)).toBe(timer);
  expect(timer.hasRef()).toBe(false);
  expect(console.log).toHaveBeenCalled();
});
