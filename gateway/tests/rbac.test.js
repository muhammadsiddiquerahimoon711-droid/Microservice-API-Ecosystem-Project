const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { hasRole, isValidRole, requireRole } = require('../src/rbac');

function run(mw, user) {
  const req = { user }; let status = null; let body = null; let nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  mw(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

describe('RBAC tiers', () => {
  test('role hierarchy: user < manager < admin', () => {
    assert.ok(hasRole('admin', 'manager') && hasRole('admin', 'user') && hasRole('admin', 'admin'));
    assert.ok(hasRole('manager', 'user') && hasRole('manager', 'manager'));
    assert.ok(!hasRole('manager', 'admin'));
    assert.ok(!hasRole('user', 'manager') && !hasRole('user', 'admin'));
  });
  test('unknown or missing roles never pass', () => {
    assert.ok(!hasRole('superuser', 'user'));
    assert.ok(!hasRole(undefined, 'user'));
    assert.ok(!hasRole('admin', 'root'));
    assert.ok(!isValidRole('__proto__'));
  });
  test('requireRole lets a sufficient role through', () => {
    assert.equal(run(requireRole('manager'), { role: 'admin' }).nexted, true);
  });
  test('requireRole returns 403 for an insufficient role', () => {
    const r = run(requireRole('admin'), { role: 'user' });
    assert.equal(r.status, 403); assert.equal(r.nexted, false);
  });
  test('requireRole returns 401 without a user', () => {
    assert.equal(run(requireRole('user'), undefined).status, 401);
  });
});
