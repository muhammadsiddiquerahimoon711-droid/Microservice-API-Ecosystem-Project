// Three role tiers: user < manager < admin. A higher tier includes everything below it.
const RANK = { user: 1, manager: 2, admin: 3 };
const ROLES = Object.keys(RANK);

const isValidRole = (role) => typeof role === 'string' && Object.hasOwn(RANK, role);
const hasRole = (actual, required) => isValidRole(actual) && isValidRole(required) && RANK[actual] >= RANK[required];

function requireRole(required) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!hasRole(req.user.role, required)) return res.status(403).json({ error: `${required} role or higher required` });
    next();
  };
}

module.exports = { ROLES, RANK, isValidRole, hasRole, requireRole };
