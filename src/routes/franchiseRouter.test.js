const request = require('supertest');
const app = require('../service');
const { randomName, createAdminUser, registerUser, login } = require('../testUtils.js');

// Longer timeout when debugging in VS Code
if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

let adminToken;
let franchisee;
let franchiseeToken;
let dinerToken;

// One admin, one franchisee, one diner for the file
beforeAll(async () => {
  const admin = await createAdminUser();
  adminToken = await login(admin);
  ({ user: franchisee, token: franchiseeToken } = await registerUser());
  ({ token: dinerToken } = await registerUser());
});

// Admin creates a franchise owned by the franchisee
async function createFranchise() {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [{ email: franchisee.email }] });
  expect(res.status).toBe(200);
  return res.body;
}

// Create a store (admin token by default)
async function createStore(franchiseId, token = adminToken) {
  return request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${token}`).send({ name: randomName() });
}

describe('create franchise', () => {
  test('as admin', async () => {
    const name = randomName();
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, admins: [{ email: franchisee.email }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name, admins: [{ email: franchisee.email, id: franchisee.id, name: franchisee.name }] });
    expect(res.body.id).toEqual(expect.any(Number));
  });

  test('as non-admin is forbidden', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ name: randomName(), admins: [{ email: franchisee.email }] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a franchise');
  });

  test('without token', async () => {
    const res = await request(app).post('/api/franchise').send({ name: randomName(), admins: [] });
    expect(res.status).toBe(401);
  });

  test('with unknown admin email', async () => {
    const email = randomName() + '@nobody.com';
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: randomName(), admins: [{ email }] });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(`unknown user for franchise admin ${email} provided`);
  });
});

describe('list franchises', () => {
  test('anonymous with name filter', async () => {
    const franchise = await createFranchise();
    await createStore(franchise.id);

    const res = await request(app).get(`/api/franchise?page=0&limit=10&name=${franchise.name}`);
    expect(res.status).toBe(200);
    expect(res.body.more).toBe(false);
    expect(res.body.franchises).toHaveLength(1);
    expect(res.body.franchises[0]).toMatchObject({ id: franchise.id, name: franchise.name });
    expect(res.body.franchises[0].stores).toHaveLength(1);
    expect(res.body.franchises[0].admins).toBeUndefined();
  });

  test('as admin includes admins and revenue', async () => {
    const franchise = await createFranchise();
    await createStore(franchise.id);

    const res = await request(app).get(`/api/franchise?name=${franchise.name}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises[0].admins).toEqual([{ id: franchisee.id, name: franchisee.name, email: franchisee.email }]);
    expect(res.body.franchises[0].stores[0]).toMatchObject({ totalRevenue: 0 });
  });

  // Checks the paging fix
  test('paging reports more', async () => {
    const prefix = randomName();
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/franchise')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `${prefix}${i}`, admins: [] });
    }

    const res = await request(app).get(`/api/franchise?page=0&limit=2&name=${prefix}*`);
    expect(res.status).toBe(200);
    expect(res.body.franchises).toHaveLength(2);
    expect(res.body.more).toBe(true);
  });
});

describe('user franchises', () => {
  test('franchisee gets own franchises', async () => {
    const franchise = await createFranchise();
    const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${franchiseeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.id)).toContain(franchise.id);
  });

  test('admin gets another user franchises', async () => {
    const franchise = await createFranchise();
    const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.id)).toContain(franchise.id);
  });

  test('user with no franchises gets empty list', async () => {
    const { user, token } = await registerUser();
    const res = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('other user gets empty list', async () => {
    await createFranchise();
    const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('without token', async () => {
    const res = await request(app).get(`/api/franchise/${franchisee.id}`);
    expect(res.status).toBe(401);
  });
});

describe('delete franchise', () => {
  test('as admin', async () => {
    const franchise = await createFranchise();
    await createStore(franchise.id);

    const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('franchise deleted');

    const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
    expect(listRes.body.franchises).toHaveLength(0);
  });

  test('as non-admin is forbidden', async () => {
    const franchise = await createFranchise();
    const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${franchiseeToken}`);
    expect(res.status).toBe(403);
  });

  test('without token', async () => {
    const franchise = await createFranchise();
    const res = await request(app).delete(`/api/franchise/${franchise.id}`);
    expect(res.status).toBe(401);
  });
});

describe('stores', () => {
  test('admin creates store', async () => {
    const franchise = await createFranchise();
    const res = await createStore(franchise.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ franchiseId: franchise.id, name: expect.any(String), id: expect.any(Number) });
  });

  test('franchisee creates store', async () => {
    const franchise = await createFranchise();
    const res = await createStore(franchise.id, franchiseeToken);
    expect(res.status).toBe(200);
    expect(res.body.franchiseId).toBe(franchise.id);
  });

  test('diner cannot create store', async () => {
    const franchise = await createFranchise();
    const res = await createStore(franchise.id, dinerToken);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a store');
  });

  test('non-admin create store for unknown franchise', async () => {
    const res = await createStore(999999999, franchiseeToken);
    expect(res.status).toBe(403);
  });

  test('create store without token', async () => {
    const franchise = await createFranchise();
    const res = await request(app).post(`/api/franchise/${franchise.id}/store`).send({ name: randomName() });
    expect(res.status).toBe(401);
  });

  test('franchisee deletes store', async () => {
    const franchise = await createFranchise();
    const store = (await createStore(franchise.id)).body;
    const res = await request(app).delete(`/api/franchise/${franchise.id}/store/${store.id}`).set('Authorization', `Bearer ${franchiseeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('store deleted');

    const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
    expect(listRes.body.franchises[0].stores).toHaveLength(0);
  });

  test('diner cannot delete store', async () => {
    const franchise = await createFranchise();
    const store = (await createStore(franchise.id)).body;
    const res = await request(app).delete(`/api/franchise/${franchise.id}/store/${store.id}`).set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to delete a store');
  });

  test('delete store without token', async () => {
    const res = await request(app).delete('/api/franchise/1/store/1');
    expect(res.status).toBe(401);
  });
});
