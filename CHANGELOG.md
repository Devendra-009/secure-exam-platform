# Changelog

## 3.1.0

- Removed committed/local credential values and demo credentials from the application UI.
- Added environment validation for database and JWT configuration.
- Added security headers and request rate limiting to the API.
- Restricted instructor access to exams they manage.
- Hardened JWT verification with an explicit signing algorithm, issuer, and audience.
- Added idempotent database migration and environment-driven admin seeding.
- Updated Electron and Vite to current patched release lines used by this project.
- Restricted Electron navigation and media permissions to the configured application origin.
- Pinned the face detector runtime dependency instead of loading a floating `@latest` CDN asset.
- Added Render Blueprint and CI/dependency automation files for deployment.
