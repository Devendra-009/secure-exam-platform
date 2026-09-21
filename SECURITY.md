# Security

## Reporting a vulnerability

Do not publish sensitive security findings in a public issue. Report them privately to the project maintainer with:

- affected component and version
- reproduction steps
- expected and observed behavior
- impact assessment
- any suggested remediation

## Deployment requirements

Production deployments must keep credentials in the hosting platform's environment configuration, use HTTPS, restrict CORS to the deployed client origin, and use a managed PostgreSQL instance. Never commit `.env` files or database dumps containing credentials.

The Electron client is a controlled exam shell, not an operating-system security boundary. High-stakes deployments should receive an independent security assessment.
