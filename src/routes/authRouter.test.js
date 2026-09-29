const request = require('supertest');
const app = require('../service');
const { randomName } = require('../testUtils.js');

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;
let testUserId;

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

beforeAll(async () => {
  testUser.email = randomName() + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  testUserId = registerRes.body.user.id;
  expectValidJwt(testUserAuthToken);
});

test('register returns the new diner', async () => {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'b' };
  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  expect(res.body.user).toMatchObject({ name: user.name, email: user.email, roles: [{ role: 'diner' }] });
  expect(res.body.user.password).toBeUndefined();
});

test('register requires name, email, and password', async () => {
  const res = await request(app).post('/api/auth').send({ email: randomName() + '@test.com' });
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('name, email, and password are required');
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, id: testUserId, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('login with bad password', async () => {
  const res = await request(app).put('/api/auth').send({ email: testUser.email, password: 'wrong' });
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown user');
});

test('login with unknown email', async () => {
  const res = await request(app).put('/api/auth').send({ email: randomName() + '@nobody.com', password: 'a' });
  expect(res.status).toBe(404);
});

test('logout without token', async () => {
  const res = await request(app).delete('/api/auth');
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('unauthorized');
});

test('logout with invalid token', async () => {
  const res = await request(app).delete('/api/auth').set('Authorization', 'Bearer not.a.token');
  expect(res.status).toBe(401);
});

test('logout', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  const token = loginRes.body.token;

  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body.message).toBe('logout successful');

  // The token is no longer accepted after logout.
  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(meRes.status).toBe(401);
});

test('original registration token still works', async () => {
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(res.status).toBe(200);
  expect(res.body.id).toBe(testUserId);
});
