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

  describe('as admin', () => {
    let adminToken;
    beforeAll(async () => {
      adminToken = await login(await createAdminUser());
    });

    // GET /api/user with the admin token and the given query
    function listUsers(query = '') {
      return request(app).get(`/api/user${query}`).set('Authorization', `Bearer ${adminToken}`);
    }

    test('returns users with roles and no passwords', async () => {
      const res = await listUsers(`?name=${diner.name}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ users: [{ id: diner.id, name: diner.name, email: diner.email, roles: [{ role: 'diner' }] }], more: false });
    });

    test('never includes passwords', async () => {
      const res = await listUsers('?limit=50');
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThan(0);
      for (const user of res.body.users) {
        expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name', 'roles']);
      }
    });

    describe('paging', () => {
      // Three users that share a unique name prefix, so other test data can't interfere
      let prefix;
      let ids;
      beforeAll(async () => {
        prefix = randomName();
        ids = [];
        for (let i = 1; i <= 3; i++) {
          const res = await request(app).post('/api/auth').send({ name: `${prefix} ${i}`, email: `${randomName()}@test.com`, password: 'a' });
          ids.push(res.body.user.id);
        }
      });

      test('first page has more', async () => {
        const res = await listUsers(`?page=1&limit=2&name=${prefix}*`);
        expect(res.status).toBe(200);
        expect(res.body.users.map((u) => u.id)).toEqual(ids.slice(0, 2));
        expect(res.body.more).toBe(true);
      });

      test('last page has the rest and no more', async () => {
        const res = await listUsers(`?page=2&limit=2&name=${prefix}*`);
        expect(res.body.users.map((u) => u.id)).toEqual(ids.slice(2));
        expect(res.body.more).toBe(false);
      });

      test('page past the end is empty', async () => {
        const res = await listUsers(`?page=3&limit=2&name=${prefix}*`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ users: [], more: false });
      });

      test('exact page size has no more', async () => {
        const res = await listUsers(`?page=1&limit=3&name=${prefix}*`);
        expect(res.body.users).toHaveLength(3);
        expect(res.body.more).toBe(false);
      });

      test('defaults to page 1 with 10 users', async () => {
        const res = await listUsers();
        expect(res.status).toBe(200);
        expect(res.body.users.length).toBeLessThanOrEqual(10);
        expect(res.body).toEqual((await listUsers('?page=1&limit=10&name=*')).body);
      });

      test('bad page and limit fall back to defaults', async () => {
        const res = await listUsers(`?page=abc&limit=-5&name=${prefix}*`);
        expect(res.status).toBe(200);
        expect(res.body.users.map((u) => u.id)).toEqual(ids);
      });
    });

    describe('name filter', () => {
      let prefix;
      const byName = {};
      beforeAll(async () => {
        prefix = randomName();
        for (const suffix of ['pizza', 'pizzaz', 'pasta', '_x', 'ax', '%y', 'by']) {
          const res = await request(app).post('/api/auth').send({ name: `${prefix}${suffix}`, email: `${randomName()}@test.com`, password: 'a' });
          byName[suffix] = res.body.user.id;
        }
      });

      // Names of the matching users, without the shared prefix
      async function matching(filter) {
        const res = await listUsers(`?limit=50&name=${encodeURIComponent(filter)}`);
        expect(res.status).toBe(200);
        return res.body.users.map((u) => u.name.slice(prefix.length)).sort();
      }

      test('exact name', async () => {
        expect(await matching(`${prefix}pizza`)).toEqual(['pizza']);
      });

      test('trailing wildcard', async () => {
        expect(await matching(`${prefix}pizza*`)).toEqual(['pizza', 'pizzaz']);
      });

      test('leading and middle wildcards', async () => {
        expect(await matching(`*${prefix}p*a`)).toEqual(['pasta', 'pizza']);
      });

      test('no match is an empty list', async () => {
        const res = await listUsers(`?name=${randomName()}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ users: [], more: false });
      });

      test('underscore and percent are literal, not SQL wildcards', async () => {
        expect(await matching(`${prefix}_x`)).toEqual(['_x']);
        expect(await matching(`${prefix}%y`)).toEqual(['%y']);
      });
    });
  });
});

// Delete user (admin only)
describe('delete user', () => {
  test('is documented', async () => {
    const res = await request(app).get('/api/docs');
    const doc = res.body.endpoints.find((e) => e.method === 'DELETE' && e.path === '/api/user/:userId');
    expect(doc).toMatchObject({ requiresAuth: true, description: expect.any(String), example: expect.stringContaining('-X DELETE') });
    expect(doc.response).toEqual({ message: expect.any(String) });
  });
});
