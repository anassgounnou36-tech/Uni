# Repository settings required

Configure the following in GitHub repository settings and rulesets:

1. Require status checks before merge (at minimum: lint, typecheck, unit tests, Foundry tests, fork smoke, build).
2. Require at least one approving pull request review before merge.
3. Configure protected deployment environments.
4. Require reviewers for production deployments.
5. Prevent self-review for production deployments.
6. Enable CodeQL code scanning for this repository.
7. Enable artifact attestations for release artifacts.
