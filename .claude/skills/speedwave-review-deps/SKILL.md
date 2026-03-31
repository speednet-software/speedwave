---
name: speedwave-review-deps
description: Critical security review of Dependabot package update PRs. Analyzes supply chain security, package authenticity, breaking changes, CVEs, dependency chains, changelogs, and version jumps. Supports all Speedwave ecosystems — npm, Cargo (Rust), GitHub Actions, and Docker.
user-invocable: true
disable-model-invocation: true
model: opus
argument-hint: '<GitHub PR URL>'
allowed-tools: Bash(gh *), Bash(npm *), Bash(cargo *), Bash(jq *), Read, Glob, Grep, Agent, WebFetch, WebSearch, AskUserQuestion
---

# Review Dependency Update PR

`$ARGUMENTS` contains the GitHub PR URL. If `$ARGUMENTS` is empty, use AskUserQuestion to ask for the PR URL.

## Step 0 — Extract PR Number and Repo

Parse the PR number and repository from `$ARGUMENTS`. The URL format is `https://github.com/<owner>/<repo>/pull/<number>`. Extract both `<owner>/<repo>` and `<number>`. Use `--repo <owner>/<repo>` on every `gh` command throughout the skill to ensure correctness regardless of the local git remote.

## Step 1 — Gather PR Data

Run these in parallel:

1. **PR metadata:** `gh pr view <number> --repo <owner>/<repo> --json title,body,files,additions,deletions,labels,author,createdAt`
2. **PR diff (manifest files only):** `gh pr diff <number> --repo <owner>/<repo>` — filter to manifest files (`package.json`, `Cargo.toml`, `Dockerfile`, `.github/workflows/*.yml`) for readability. Note the presence of lock files (`package-lock.json`, `Cargo.lock`) but don't dump their full diff.
3. **CI status:** `gh pr checks <number> --repo <owner>/<repo>` or `gh pr view <number> --repo <owner>/<repo> --json statusCheckRollup`

From the PR body and diff, build a list of every dependency being updated with its `old_version -> new_version`.

### Detect ecosystem

- `package.json` / `package-lock.json` → **npm**
- `Cargo.toml` / `Cargo.lock` → **Cargo (Rust)**
- `.github/workflows/*.yml` → **GitHub Actions**
- `Dockerfile` / `Containerfile` → **Docker base images**
- A single PR may mix ecosystems — handle each dependency in its native ecosystem

## Step 2 — Classify Each Dependency

For each dependency, determine:

- **Ecosystem:** npm, crates.io, GitHub Actions, or Docker
- **Dependency type:**
  - npm: runtime (`dependencies`) or dev-only (`devDependencies`)
  - Cargo: `[dependencies]`, `[dev-dependencies]`, or `[build-dependencies]`
  - GitHub Actions: CI-only (runs in GitHub-hosted runners, not in production)
  - Docker: base image (affects production container)
- **Version jump type:** patch, minor, or major
- **Usage in codebase:** which files import/use this dependency (use Grep — for Rust: `use <crate>::`, for npm: `import/require`, for Actions: workflow files, for Docker: `FROM` lines)

**Risk ordering:** Docker base images and runtime dependencies get the highest scrutiny. Dev/CI dependencies are lower risk but still require verification.

## Step 3 — Launch Parallel Security Research Agents

For each dependency update (or group of related dependencies), launch a background Agent to research. Tell each agent which ecosystem-specific checks to perform.

### Tool availability

Before using CLI tools, check availability with `which npm` / `which cargo`. If a tool is absent, fall back to HTTP APIs:

- **npm not available:** use `WebFetch` to `https://registry.npmjs.org/<pkg>/<version>` — the JSON response contains `_npmUser`, `maintainers`, `dependencies`, `dist.integrity`, `dist.signatures`
- **cargo not available:** use `WebFetch` to `https://crates.io/api/v1/crates/<crate>/<version>` — already the primary method for Cargo checks

### npm packages

1. **Registry verification** — `npm view <pkg>@<new_version>` (or `WebFetch` to `https://registry.npmjs.org/<pkg>/<version>` if npm is unavailable) to get publisher, date, dist.integrity, maintainers. Check SLSA provenance with `npm audit signatures` (note: this only works for packages published with npm provenance via OIDC — most packages don't have it yet, so a clean output is not a positive signal). Verify download stats via `WebFetch` to `https://api.npmjs.org/downloads/point/last-week/<pkg>`.
2. **Publish method verification (CRITICAL)** — check `_npmUser` field from `npm view <pkg>@<new_version>`. If previous versions were published via automated CI (e.g., `GitHub Actions <npm-oidc-no-reply@github.com>`) but the new version was published by a human account, this is a **HIGH-SEVERITY red flag** — it may indicate a compromised maintainer token used to bypass CI/CD (cf. axios 1.14.1 supply chain attack, March 2026). Compare `npm view <pkg>@<old_version> _npmUser` vs `npm view <pkg>@<new_version> _npmUser`. The publish method must be consistent.
3. **GitHub release notes** — fetch changelog/release notes from the package's GitHub repository. Identify what changed.
4. **Security advisories** — search GitHub Advisory Database and/or `WebSearch` for known CVEs. Use this query:

   ```bash
   gh api graphql -f query='{ securityVulnerabilities(first: 10, ecosystem: NPM, package: "<pkg>") { nodes { advisory { summary severity ghsaId publishedAt identifiers { type value } } vulnerableVersionRange firstPatchedVersion { identifier } } } }'
   ```

5. **Maintainer continuity** — compare `npm view <pkg>@<old_version> maintainers` vs `npm view <pkg>@<new_version> maintainers`. Flag any changes.
6. **Dependency delta** — compare `npm view <pkg>@<old_version> dependencies` vs `npm view <pkg>@<new_version> dependencies`. Flag new deps or major version bumps. Any **new dependency** not present in the previous version is a red flag and must be independently verified (cf. `plain-crypto-js` injection in axios 1.14.1).

### Cargo (Rust) crates

1. **Registry verification** — `WebFetch` to `https://crates.io/api/v1/crates/<crate>/<new_version>` to get published_by, created_at, downloads, checksum.
2. **Publish method verification (CRITICAL)** — compare `published_by` between old and new version via crates.io API. If the publisher changed (different GitHub user) or the crate was previously published via automated CI (GitHub Actions) but the new version was published manually, this is a **HIGH-SEVERITY red flag**. Verify that `published_by.login` is consistent across versions.
3. **GitHub release notes** — find the repository URL from crate metadata (`repository` field) and fetch changelog/release notes.
4. **Security advisories** — search GitHub Advisory Database and `WebSearch` for `rustsec <crate_name>`. Use this query:

   ```bash
   gh api graphql -f query='{ securityVulnerabilities(first: 10, ecosystem: RUST, package: "<crate>") { nodes { advisory { summary severity ghsaId publishedAt identifiers { type value } } vulnerableVersionRange firstPatchedVersion { identifier } } } }'
   ```

5. **Maintainer continuity** — compare owners via `WebFetch` to `https://crates.io/api/v1/crates/<crate>/owners`. Flag any changes.
6. **Dependency delta** — compare `Cargo.toml` `[dependencies]` between old and new version (from the crate's GitHub repo tags). Flag new deps or major version bumps. Any **new dependency** not present in the previous version must be independently verified.

### GitHub Actions

1. **Repository verification** — verify the action is from a known, trusted org (e.g., `actions/*`, `github/*`, `codecov/*`). Use `WebFetch` or `gh api` to check the repo's owner, stars, and activity.
2. **SHA-to-tag verification (CRITICAL)** — Dependabot pins actions by SHA (e.g., `actions/checkout@abc1234`). Verify that the new SHA corresponds to a signed, tagged release — a SHA that doesn't match any release tag is a **HIGH-SEVERITY red flag** (could be a malicious commit pushed directly). Use:

   ```bash
   gh api repos/<owner>/<action>/git/matching-refs/tags --jq '.[].object'
   ```

   For each tag ref: if `object.type` is `"tag"` (annotated tag), dereference to the commit SHA:

   ```bash
   gh api repos/<owner>/<action>/git/tags/<object.sha> --jq '.object.sha'
   ```

   If `object.type` is `"commit"` (lightweight tag), use the SHA directly. Cross-reference the dereferenced commit SHAs against the new SHA from the PR diff. Also verify the tag points to the expected version via `gh api repos/<owner>/<action>/releases`.

3. **Release/tag inspection** — fetch the release notes for the new version tag. Check what changed.
4. **Security advisories** — `WebSearch` for any known security incidents involving the action (e.g., compromised action, credential theft).
5. **Maintainer continuity** — check if the action's repository recently changed ownership or had unusual force-pushes to release tags.
6. **Permissions scope** — check what permissions the action requests in its `action.yml`. Flag any new permissions or scope changes between versions. Cross-reference with the workflow file to see what `permissions:` the workflow grants.

### Docker base images

1. **Image verification** — verify the image is from an official or trusted source (Docker Official Images, verified publishers). Use `WebSearch` or Docker Hub API to check.
2. **Release notes** — find changelog for the new image tag. Check what OS/package updates are included.
3. **Security advisories** — `WebSearch` for CVEs fixed or introduced in the new image version. Check if the update is motivated by a security patch (e.g., Alpine CVE, Node.js vulnerability).
4. **Tag stability** — verify the tag is a specific version tag (e.g., `node:22.5.1-alpine`, not `latest` or a floating major tag like `node:22`). Speedwave uses specific version tags in Containerfiles (not digest pins), so a specific version tag is the passing bar.
5. **Size/layer changes** — note any significant changes in image size that might indicate unexpected additions.

### For all ecosystems — runtime/production dependencies

Additionally research:

- How the dependency is used in the Speedwave codebase (what operations, any security-sensitive usage like auth, tokens, crypto, container config)
- Whether behavioral changes in the update could affect those operations
- **CI coverage note** — CI (`test.yml`) does not run all local tests. Pre-push hook runs `make test` which includes `test-desktop-build` (bundle script tests). For npm MCP updates, recommend running `make test-desktop-build` locally before approving.

## Step 4 — Compile Analysis

Once all agents complete, compile findings into the following format. For each dependency, work through ALL seven aspects:

You will be acting as a critical security reviewer evaluating package update suggestions from Dependabot. Your goal is to establish beyond any doubt that the suggested package updates are safe, not poisoned/compromised, and will not break the project or introduce security vulnerabilities or bugs. You must be highly critical and thorough in your analysis.

For each package update, you must critically analyze the following aspects:

1. **Supply Chain Security**: Check if there are any indicators that the package might be poisoned or compromised (e.g., sudden maintainer changes, suspicious version jumps, typosquatting concerns, unusual download patterns)

2. **Package Authenticity**: Verify the package source, maintainer reputation, and whether this is the legitimate package (not a malicious fork or impersonation)

3. **Breaking Changes**: Identify any breaking changes in the update that could cause the project to fail or behave unexpectedly

4. **Security Vulnerabilities**: Assess whether the update fixes security issues or potentially introduces new ones

5. **Dependency Chain**: Consider if the update pulls in new dependencies that could be problematic

6. **Changelog Analysis**: Review what changes are included in the update and assess their risk level

7. **Version Jump Assessment**: Evaluate if the version change is minor/patch (lower risk) or major (higher risk)

8. **Build Pipeline Impact**: For npm workspace updates, note that `package-lock.json` changes can affect isolated install contexts (bundle scripts, Docker builds). Recommend `make test-desktop-build` for MCP dependency updates.

Before providing your final assessment, use the <analysis> section to think through each package update systematically. For each package, work through all seven aspects listed above.

<analysis>
[Your detailed critical analysis here]
</analysis>

After your analysis, provide your final recommendation inside <recommendation> tags. Your recommendation should:

- List each package update with a clear APPROVE or REJECT decision
- Provide specific reasoning for each decision
- Highlight any concerns or conditions for approval (e.g., "approve but test thoroughly in staging")
- If you cannot establish safety beyond reasonable doubt, you MUST recommend rejection or further investigation
- Be conservative - when in doubt, recommend caution

Format your recommendation clearly with each package on a separate line or section.

Remember: Your final output should include both the <analysis> section showing your critical thinking process and the <recommendation> section with clear decisions. Be thorough and err on the side of caution - it's better to reject a safe update than to approve a dangerous one.

## Step 5 — Output

Present the full `<analysis>` and `<recommendation>` sections to the user. Do not truncate or summarize — the user needs the complete audit trail.
