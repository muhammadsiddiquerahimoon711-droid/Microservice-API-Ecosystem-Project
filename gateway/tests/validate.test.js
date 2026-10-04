const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');

describe('request validation', () => {
  test('register accepts good input and trims username', () => {
    const r = v.registerInput({ username: '  ali_01 ', password: 'password123' });
    assert.ok(r.ok); assert.equal(r.value.username, 'ali_01');
  });
  test('register rejects bad usernames and short passwords', () => {
    assert.equal(v.registerInput({ username: 'a', password: 'password123' }).ok, false);
    assert.equal(v.registerInput({ username: 'bad name!', password: 'password123' }).ok, false);
    assert.equal(v.registerInput({ username: 'validname', password: 'short' }).ok, false);
    assert.equal(v.registerInput({ username: 'validname', password: 'x'.repeat(73) }).ok, false);
    assert.equal(v.registerInput(undefined).ok, false);
  });
  test('register ignores any role the client tries to send', () => {
    const r = v.registerInput({ username: 'hacker', password: 'password123', role: 'admin' });
    assert.ok(r.ok); assert.equal(r.value.role, undefined);
  });
  test('login requires both fields', () => {
    assert.equal(v.loginInput({ username: 'a' }).ok, false);
    assert.equal(v.loginInput({ password: 'a' }).ok, false);
    assert.ok(v.loginInput({ username: 'a', password: 'b' }).ok);
  });
  test('transaction amount must be positive, finite and bounded', () => {
    assert.ok(v.transactionInput({ amount: 10.5 }).ok);
    assert.ok(v.transactionInput({ amount: '25' }).ok);
    for (const bad of [0, -1, 'abc', null, undefined, NaN, Infinity, 2_000_000_000, {}, [5]]) {
      assert.equal(v.transactionInput({ amount: bad }).ok, false, `amount ${String(bad)} should be rejected`);
    }
  });
  test('transaction amount is rounded to 2 decimals', () => {
    assert.equal(v.transactionInput({ amount: 10.456 }).value.amount, 10.46);
  });
  test('transaction description is optional but limited', () => {
    assert.equal(v.transactionInput({ amount: 1, description: 'x'.repeat(201) }).ok, false);
    assert.equal(v.transactionInput({ amount: 1, description: 5 }).ok, false);
    assert.equal(v.transactionInput({ amount: 1 }).value.description, null);
  });
  test('role input only allows known roles', () => {
    assert.ok(v.roleInput({ role: 'manager' }).ok);
    assert.equal(v.roleInput({ role: 'root' }).ok, false);
    assert.equal(v.roleInput({}).ok, false);
  });
  test('id param must be a positive integer', () => {
    assert.equal(v.idParam('12').value, 12);
    for (const bad of ['0', '-1', 'abc', '1.5', '', '99999999999']) assert.equal(v.idParam(bad).ok, false);
  });
});
