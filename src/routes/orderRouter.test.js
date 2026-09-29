const request = require('supertest');
const app = require('../service');
const { randomName, createAdminUser, registerUser, login } = require('../testUtils.js');

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

let adminToken;
let dinerToken;
let diner;
let menuItem;
let franchise;
let store;

beforeAll(async () => {
  const admin = await createAdminUser();
  adminToken = await login(admin);
  ({ user: diner, token: dinerToken } = await registerUser());

  const title = randomName();
  const menuRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title, description: 'test pizza', image: 'pizza9.png', price: 0.0001 });
  menuItem = menuRes.body.find((m) => m.title === title);

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [] });
  franchise = franchiseRes.body;

  const storeRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName() });
  store = storeRes.body;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mockFactory(ok, body) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({ ok, json: async () => body });
}

function orderRequest() {
  return { franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };
}

describe('menu', () => {
  test('get menu', async () => {
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual(menuItem);
  });

  test('admin adds menu item', async () => {
    const item = { title: randomName(), description: 'more carbs', image: 'pizza1.png', price: 0.002 };
    const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(item);
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ ...item, id: expect.any(Number) });
  });

  test('diner cannot add menu item', async () => {
    const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${dinerToken}`).send({ title: 'x', description: 'x', image: 'x', price: 1 });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to add menu item');
  });

  test('add menu item without token', async () => {
    const res = await request(app).put('/api/order/menu').send({ title: 'x', description: 'x', image: 'x', price: 1 });
    expect(res.status).toBe(401);
  });
});

describe('orders', () => {
  test('create order when factory succeeds', async () => {
    const fetchSpy = mockFactory(true, { jwt: 'factory.jwt.value', reportUrl: 'http://report' });

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderRequest());
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ ...orderRequest(), id: expect.any(Number) });
    expect(res.body.jwt).toBe('factory.jwt.value');
    expect(res.body.followLinkToEndChaos).toBe('http://report');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/order$/);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body).diner).toEqual({ id: diner.id, name: diner.name, email: diner.email });
  });

  test('create order when factory fails', async () => {
    mockFactory(false, { reportUrl: 'http://chaos' });

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderRequest());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'http://chaos' });
  });

  test('create order with unknown menu item', async () => {
    const fetchSpy = mockFactory(true, {});
    const order = { ...orderRequest(), items: [{ menuId: 999999999, description: 'ghost', price: 1 }] };

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(order);
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('create order without token', async () => {
    const res = await request(app).post('/api/order').send(orderRequest());
    expect(res.status).toBe(401);
  });

  test('get orders', async () => {
    const { user, token } = await registerUser();
    mockFactory(true, { jwt: 'x.y.z' });
    await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderRequest());

    const res = await request(app).get('/api/order').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.dinerId).toBe(user.id);
    expect(res.body.page).toBe(1);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({ franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menuItem.id, price: menuItem.price }] });
  });

  test('get orders second page is empty', async () => {
    const res = await request(app).get('/api/order?page=2').set('Authorization', `Bearer ${dinerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  test('get orders without token', async () => {
    const res = await request(app).get('/api/order');
    expect(res.status).toBe(401);
  });
});
