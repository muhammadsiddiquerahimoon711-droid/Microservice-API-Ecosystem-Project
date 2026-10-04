# Task 4 - Role-Based Microservice API Ecosystem with Asynchronous Message Brokers

**Student:** Muhammad Siddique

## Objective
A modular multi-tier backend that handles heavy transaction traffic safely: JWT authentication, role-based access control, an asynchronous RabbitMQ message broker, PostgreSQL storage, Redis caching, Docker Compose networks, and automated endpoint tests.

## Requirement checklist
| Requirement from the task letter | How it is implemented |
|---|---|
| JWT user authorization | `POST /auth/register` + `/auth/login` (bcrypt-hashed passwords, signed JWT, 1 h expiry) |
| Role-based access control (RBAC) tiers | `user < manager < admin` in `gateway/src/rbac.js`; self-registration always creates `user`; only an admin can promote |
| Asynchronous message broker | RabbitMQ: gateway publishes `{id}` to the `transactions` queue, the `worker` service consumes it (with retries + dead-letter queue) |
| Intense requests without database locks | Gateway answers `202` after one insert; the worker finishes each job with a single atomic conditional `UPDATE ... WHERE status='queued'` - no `FOR UPDATE`, no long transactions, safe to run many workers, redelivery is idempotent |
| Separate networks (Docker Compose) | `public` (gateway only), `data` (internal: Postgres, Redis), `broker` (internal: RabbitMQ) |
| Automated endpoint verification testing summaries | `tests/` + `gateway/tests` + `worker/tests`; `npm run test:all` writes `tests/TEST-RESULTS.txt` |

## Architecture
```
client --HTTP--> gateway --publish--> RabbitMQ --consume--> worker
                    |                                          |
                    +------ PostgreSQL <-----------------------+
                    +------ Redis (cache of GET /transactions, cleared by worker)
```

## Run
```bash
cp .env.example .env      # optional: set JWT_SECRET and the admin password
docker compose up --build
```
Gateway: `http://localhost:3000`. A first admin account is created automatically from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (default `admin` / `ChangeMe-Admin-123`).

## Endpoints
| Method & path | Minimum role |
|---|---|
| `GET /health` | public |
| `POST /auth/register`, `POST /auth/login` | public |
| `POST /transactions` -> `202 Accepted` | user |
| `GET /transactions` (own, cached 30 s) | user |
| `GET /transactions/:id` (owner, or manager+) | user |
| `GET /manager/transactions` (all users) | manager |
| `GET /admin/users` | admin |
| `PATCH /admin/users/:id/role` `{"role":"manager"}` | admin |

Example:
```bash
curl -X POST localhost:3000/auth/register -H "Content-Type: application/json" -d '{"username":"ali","password":"password123"}'
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H "Content-Type: application/json" -d '{"username":"ali","password":"password123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -X POST localhost:3000/transactions -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"amount":49.99}'
curl localhost:3000/transactions -H "Authorization: Bearer $TOKEN"     # status changes queued -> processed
```

## Tests
See `tests/README.md`. Quick start: `npm run test:all` (needs Node 22 and Docker).

## Notes
- A role lives inside the JWT, so a role change takes effect at the user's next login (tokens last 1 hour).
- Set a real `JWT_SECRET` and admin password before using this anywhere other than a demo; add HTTPS and managed secrets in production.
- Postgres, Redis and RabbitMQ are deliberately not published to your machine. To use the RabbitMQ management UI, see the comment in `docker-compose.yml`.
