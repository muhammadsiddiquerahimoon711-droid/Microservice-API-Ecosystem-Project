# Automated Endpoint Verification

Three layers of automated tests (all use Node's built-in test runner, `node --test`):

| Layer | Location | Needs | Run |
|---|---|---|---|
| Worker unit tests | `worker/tests/processor.test.js` | Node 22 only | `npm run test:worker` |
| Gateway tests | `gateway/tests/*.test.js` | `npm install` in `gateway/` | `npm run test:gateway` |
| End-to-end (real stack) | `tests/e2e.test.js` | `docker compose up --build -d` | `npm run test:e2e` |

Run everything and save the pass/fail summary to `tests/TEST-RESULTS.txt`:

```bash
npm run test:all      # or: sh tests/run-all.sh
```

## What is verified

| Endpoint / behaviour | Verified by |
|---|---|
| `GET /health` -> 200 | gateway API, e2e |
| `POST /auth/register` -> 201, role is always `user`, duplicate -> 409, invalid -> 400 | gateway API, e2e |
| `POST /auth/login` -> JWT; wrong password / unknown user -> 401 | gateway API, e2e |
| Missing, malformed, forged or unknown-role JWT -> 401 / 403 | gateway API |
| `POST /transactions` -> 202 + message published; bad amount -> 400; broker down -> 503 | gateway API, e2e |
| Asynchronous processing `queued` -> `processed` through RabbitMQ + worker | e2e, worker unit |
| `GET /transactions` (own only) + Redis cache MISS/HIT + invalidation | gateway API, e2e |
| `GET /transactions/:id` ownership, 404, 400 | gateway API |
| `GET /manager/transactions` (manager+) | gateway API, e2e |
| `GET /admin/users`, `PATCH /admin/users/:id/role` (admin only) | gateway API, e2e |
| RBAC tier ordering `user < manager < admin` | gateway rbac tests, API, e2e |
| Worker: atomic update (no row locks), idempotent redelivery, retries, dead-letter queue | worker unit |
| 50 concurrent transactions all accepted and processed | e2e, worker unit (200 jobs) |

Manual check with curl:
```bash
curl http://localhost:3000/health
```
