const request = require('supertest');
const app = require('./service');
const version = require('./version.json');
const config = require('./config.js');

// Root endpoint
test('root returns welcome and version', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'welcome to JWT Pizza', version: version.version });
});

// Docs endpoint
test('docs list every endpoint', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body.version).toBe(version.version);
  expect(res.body.config).toEqual({ factory: config.factory.url, db: config.db.connection.host });

  const endpoints = res.body.endpoints.map((e) => `${e.method} ${e.path}`);
  expect(endpoints).toEqual(
    expect.arrayContaining(['POST /api/auth', 'PUT /api/auth', 'DELETE /api/auth', 'GET /api/user/me', 'PUT /api/user/:userId', 'GET /api/order/menu', 'PUT /api/order/menu', 'GET /api/order', 'POST /api/order', 'POST /api/franchise', 'DELETE /api/franchise/:franchiseId'])
  );
});

// CORS middleware
test('CORS headers are set', async () => {
  const res = await request(app).get('/').set('Origin', 'https://pizza.example.com');
  expect(res.headers['access-control-allow-origin']).toBe('https://pizza.example.com');
  expect(res.headers['access-control-allow-credentials']).toBe('true');
});

// 404 handler
test('unknown endpoint returns 404', async () => {
  const res = await request(app).get('/api/does-not-exist');
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown endpoint');
});

// Bad JSON triggers the default error handler
test('error handler uses the error status code', async () => {
  const res = await request(app).post('/api/auth').set('Content-Type', 'application/json').send('{"bad json');
  expect(res.status).toBe(400);
  expect(res.body.message).toBeDefined();
  expect(res.body.stack).toBeDefined();
});
