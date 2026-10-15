const request = require('supertest');
const app = require('../service');
const { randomName, createAdminUser, registerUser, login } = require('../testUtils.js');

// Longer timeout when debugging in VS Code
if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

let diner;
let dinerToken;

// Fresh diner for every test
beforeEach(async () => {
  ({ user: diner, token: dinerToken } = await registerUser());
});

test('get me', async () => {
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: diner.id, name: diner.name, email: diner.email, roles: [{ role: 'diner' }] });
});

test('get me without token', async () => {
  const res = await request(app).get('/api/user/me');
  expect(res.status).toBe(401);
});

test('update self', async () => {
  const newName = randomName();
  const newEmail = randomName() + '@test.com';
  const res = await request(app).put(`/api/user/${diner.id}`).set('Authorization', `Bearer ${dinerToken}`).send({ name: newName, email: newEmail, password: 'newpass' });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: diner.id, name: newName, email: newEmail });
  expect(res.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  // New password works
  const token = await login({ email: newEmail, password: 'newpass' });
  expect(token).toBeDefined();
});

test('update only name keeps email', async () => {
  const newName = randomName();
  const res = await request(app).put(`/api/user/${diner.id}`).set('Authorization', `Bearer ${dinerToken}`).send({ name: newName });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: diner.id, name: newName, email: diner.email });
});

// Checks the SQL injection fix
test('update with name containing a quote is stored literally', async () => {
  const newName = `o'${randomName()}`;
  const res = await request(app).put(`/api/user/${diner.id}`).set('Authorization', `Bearer ${dinerToken}`).send({ name: newName });
  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe(newName);
});

test('update another user is forbidden', async () => {
  const { user: other } = await registerUser();
  const res = await request(app).put(`/api/user/${other.id}`).set('Authorization', `Bearer ${dinerToken}`).send({ name: 'hacked' });
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unauthorized');
});

test('admin can update another user', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const newName = randomName();
  const res = await request(app).put(`/api/user/${diner.id}`).set('Authorization', `Bearer ${adminToken}`).send({ name: newName });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: diner.id, name: newName });
});

test('admin updating unknown user returns 404', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const res = await request(app).put('/api/user/999999999').set('Authorization', `Bearer ${adminToken}`).send({ name: 'nobody' });
  expect(res.status).toBe(404);
});

test('update without token', async () => {
  const res = await request(app).put(`/api/user/${diner.id}`).send({ name: 'x' });
  expect(res.status).toBe(401);
});

test('delete user is not implemented', async () => {
  const res = await request(app).delete(`/api/user/${diner.id}`).set('Authorization', `Bearer ${dinerToken}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('not implemented');
});

// List users (admin only)
describe('list users', () => {
  test('is documented', async () => {
    const res = await request(app).get('/api/docs');
    const doc = res.body.endpoints.find((e) => e.method === 'GET' && e.path === '/api/user?page=1&limit=10&name=*');
    expect(doc).toMatchObject({ requiresAuth: true, description: expect.any(String), example: expect.stringContaining('/api/user') });
    expect(doc.response).toEqual({ users: [{ id: expect.any(Number), name: expect.any(String), email: expect.any(String), roles: [{ role: expect.any(String) }] }], more: expect.any(Boolean) });
  });

  test('requires a token', async () => {
    const res = await request(app).get('/api/user');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('unauthorized');
  });

  test('rejects a bad token', async () => {
    const res = await request(app).get('/api/user').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  test('is forbidden for a non-admin', async () => {
    const res = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to list users');
    expect(res.body.users).toBeUndefined();
  });
});
