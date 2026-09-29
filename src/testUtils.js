const request = require('supertest');
const app = require('./service');
const { Role, DB } = require('./database/database.js');

// Random string so test data never collides between runs
function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

// Create an admin straight in the DB (no admin API exists)
async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

// Register a new diner through the API
async function registerUser() {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'a' };
  const res = await request(app).post('/api/auth').send(user);
  return { user: { ...res.body.user, password: user.password }, token: res.body.token };
}

// Log in and return the token
async function login(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return res.body.token;
}

module.exports = { randomName, createAdminUser, registerUser, login };
