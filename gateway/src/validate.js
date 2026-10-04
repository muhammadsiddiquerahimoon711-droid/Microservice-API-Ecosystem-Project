// Dependency-free request validators. Each returns { ok: true, value } or { ok: false, error }.
const { isValidRole } = require('./rbac');

const fail = (error) => ({ ok: false, error });

function registerInput(body = {}) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return fail('username must be 3-30 characters: letters, numbers, dot, dash, underscore');
  if (password.length < 8 || Buffer.byteLength(password) > 72) return fail('password must be 8-72 characters');
  return { ok: true, value: { username, password } };
}

function loginInput(body = {}) {
  if (typeof body.username !== 'string' || !body.username.trim() || typeof body.password !== 'string' || !body.password) {
    return fail('username and password are required');
  }
  return { ok: true, value: { username: body.username.trim(), password: body.password } };
}

function transactionInput(body = {}) {
  const amount = typeof body.amount === 'number' || typeof body.amount === 'string' ? Number(body.amount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return fail('amount must be a number greater than 0 and at most 1,000,000,000');
  let description = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || body.description.length > 200) return fail('description must be a string of at most 200 characters');
    description = body.description.trim() || null;
  }
  return { ok: true, value: { amount: Math.round(amount * 100) / 100, description } };
}

function roleInput(body = {}) {
  if (!isValidRole(body.role)) return fail('role must be one of: user, manager, admin');
  return { ok: true, value: { role: body.role } };
}

function idParam(raw) {
  if (!/^\d{1,9}$/.test(String(raw))) return fail('id must be a positive integer');
  const id = Number(raw);
  return id > 0 ? { ok: true, value: id } : fail('id must be a positive integer');
}

module.exports = { registerInput, loginInput, transactionInput, roleInput, idParam };
