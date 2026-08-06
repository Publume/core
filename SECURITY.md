# Security Policy

## Supported versions

Publume Core is pre-1.0. Security fixes are applied to the latest release and the
`main` branch. Older pre-1.0 releases may not receive patches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for `Publume/core`. If that
feature is unavailable, email `publume.cloud@gmail.com` with:

- the affected version or commit;
- reproduction steps or a proof of concept;
- expected impact;
- any known mitigations;
- whether the issue has been disclosed elsewhere.

Do not include production tokens, private repository content, personal data, or
third-party secrets. Maintainers will acknowledge the report and coordinate next
steps as capacity allows. Please allow time for investigation before disclosure.

## Security boundaries

Publume processes untrusted source documents, AI responses, Git repositories,
and configuration. Deployments should use least-privilege, repository-scoped
tokens and isolated content repositories. Generated content must not be treated
as verified solely because it passed an AI gate.

Theme installation and build scripts execute code and are not sandboxed. Use only
reviewed theme repositories, pin a reviewed release, and treat theme updates like
application dependency updates.
