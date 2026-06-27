# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub. Open a report under the repository's
[Security Advisories](https://github.com/larsakerlund/loft-js/security/advisories/new) page rather
than a public issue or pull request. Include the version, a description, and steps to reproduce.

Please do not file a public issue for a security problem, and give us time to ship a fix before
disclosing it.

## What this package handles

The SDK runs in the browser and is same-origin to the Loft backend. It holds no secrets: every
request goes to a relative `/api/...` path with cookies, and all credentials and keys stay
server-side. The backend, not this package, enforces who can read or write what. A finding in this
SDK is therefore usually about how it forms requests or handles responses, not about secret
handling in the browser.

## Supported versions

The latest published version on the `0.x` line receives fixes. There is no long-term support
branch before a `1.0` release.
