# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

**Report privately:** https://github.com/klinux/dbportal/security/advisories/new

Use GitHub's private vulnerability reporting on this repository. Include the affected
component, the steps to reproduce, and the impact you believe it has.

We acknowledge receipt of your vulnerability report within **72 hours** and aim to
publish a fix or a mitigation before any public disclosure. Please give us reasonable
time to do so.

## Supported Versions

Only the latest release on `main` receives security fixes. There are no maintenance
branches for older releases: upgrade to the latest release to receive a fix.

## Scope

dbportal is deployed next to the databases it manages. Findings in the following areas
are especially relevant:

- Authentication and session handling (local login, TOTP, OIDC).
- Authorization: role checks on admin routes and on managed datasources.
- Any path by which a user could reach a datasource they were not granted, or read a
  credential the server should have kept.
- The audit trail: any way to execute a statement without it being recorded.
- Injection through SQL, connection strings, or seed configuration.

Findings in third-party database drivers should be reported to those projects; we
will still track them here and bump the dependency.
