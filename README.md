# SecureExam Platform

SecureExam is a desktop-first examination platform built with React, Express, PostgreSQL, and Electron. It provides timed assessments, student registration, recoverable exam attempts, local camera/audio checks, and an administrative review workflow.

## Project structure

- `client/` — React/Vite application.
- `server/` — Express API, PostgreSQL access, migrations, and seed tooling.
- `electron-app/` — Electron secure exam shell.
- `database/` — local development-only database helpers.
- `render.yaml` — Render deployment definition.
- `.github/` — CI and dependency update automation.

## Local development

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` in `.env` for the local database container.
3. Start PostgreSQL: `docker compose up -d`.
4. Install dependencies: `npm install` and `npm run install:all`.
5. Apply the database schema: `npm run migrate`.
6. Create a local administrator by setting `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_PASSWORD` in `.env`, then run `npm run seed`.
7. Start the application: `npm run dev`.

The local development URLs are: `http://127.0.0.1:5173` for the client and `http://127.0.0.1:5000` for the API.

## Environment variables

Production secrets must be supplied by the hosting platform. Do not commit `.env` files. The repository contains `.env.example` only.

Required production values:

- `NODE_ENV=production`
- `DATABASE_URL`
- `JWT_SECRET` (at least 32 characters)
- `JWT_EXPIRES_IN`
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `CLIENT_URL`
- `DB_POOL_MAX`
- `TRUST_PROXY`

For the Vite build, set `VITE_API_URL` to the public API base URL including `/api`.

## Render

The repository includes `render.yaml`. The intended production topology is one Render Node web service for the API, one Render static site for the React client, and one Render PostgreSQL database. The API runs the idempotent schema migration at service start.

For the initial deployment, provide the `CLIENT_URL` and `VITE_API_URL` values in Render as prompted by the Blueprint. Render wires the API to PostgreSQL through the database connection string.

## Electron production configuration

A packaged Electron build requires:

- `ELECTRON_START_URL` — the deployed client origin.
- `ELECTRON_API_URL` — the deployed API base URL.

The Electron shell allows navigation and media access only for the configured application origin.

## Database operations

`npm run migrate` applies the idempotent schema in `server/src/schema.sql`.

`npm run seed` creates or updates an administrator using `SEED_ADMIN_*` environment variables. Never put those values in source code.

`database/reset_exam_data.sql` is intentionally development-only and is destructive.

## Validation

Run `npm run validate` before pushing. CI also runs dependency audits and the production client build.

## Security notes

The application uses parameterized PostgreSQL queries, explicit JWT verification settings, security headers, rate limiting for sensitive/write endpoints, strict CORS configuration, Electron sandboxing/context isolation, restricted navigation, and pinned third-party model assets.

These controls reduce the application's known attack surface but are not a substitute for an independent security assessment before high-stakes production use.
