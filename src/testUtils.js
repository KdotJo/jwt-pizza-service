const request = require('supertest');
const app = require('./service');
const { Role, DB } = require('./database/database.js');

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

async function registerUser() {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  const res = await request(app).post('/api/auth').send(user);
  return { user: { ...res.body.user, password: user.password }, token: res.body.token };
}

async function login(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return res.body.token;
}

module.exports = { randomName, createAdminUser, registerUser, login };
