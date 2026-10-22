# ADR-101: Custom MCP Pinning and Locally Built Server Images

> **Status:** Accepted
> **Date:** 2026-10-08
> **Context:** An npm Custom MCP server (ADR-100) is third-party code the user approves once. What runs later must be exactly what was approved: the same package version, the same dependency tree, no install scripts, and an image built on the user's machine from Speedwave's own template, never one pulled from a registry.

## Decision

1. **Resolution in a one-shot container.** `custom_mcp::npm_resolve::resolve_npm_lock` writes a Speedwave-generated `package.json` and `.npmrc` (only `consts::CUSTOM_MCP_NPM_REGISTRY`, scripts off) into the review's own `custom-mcp/<project>/<name>/previews/<id>/` (moved to `<name>/build/` when that review is approved, so two reviews of one name never share a directory) and runs `npm install --package-lock-only --ignore-scripts --before=<now − min release age>` in the digest-pinned `consts::CUSTOM_MCP_RESOLVER_IMAGE`. npm documents `--package-lock-only` as using only `package-lock.json` and ignoring `node_modules` (its no-download wording, "instead of checking `node_modules` and downloading dependencies", is spelled out for `npm update`; that `npm install --package-lock-only` downloads no tarballs is not separately stated there and is unverified), `--before` as using only versions available on or before the date, and `ignore-scripts` as not running package scripts[^1]. The repository's own lockfile and `.npmrc` are never read. The result must be `lockfileVersion` 3, must carry a sha512 integrity for the package, and must mark no package `hasInstallScript`, which npm documents as the flag for a `preinstall`, `install` or `postinstall` script[^2].

2. **Accepted deviation: the resolver has full internet.** The one-shot container runs on the default bridge, not behind an egress allowlist, because npm metadata and tarball hosts are not enumerable in advance. The container is hardened (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, UID 1000, memory/CPU bounds, a deadline, force-removed on failure), runs no package code (`--ignore-scripts`, metadata only) and writes only into the build directory.

3. **The image tag is part of the consent.** `custom_mcp::build::image_tag_for` gives `speedwave-mcp-custom-<name>:<version>-<digest16>`. The version is sanitized to the OCI tag alphabet and cut to 100 characters (a tag must match `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`[^3]); the digest covers the server name, version, `SERVER_TEMPLATE_VERSION`, the resolver's `package.json`, `.npmrc` and `package-lock.json`, the generated launcher `entry.json` (`node` running the package's bin from the lockfile plus the approved arguments) and a digest of the launcher sources and `Containerfile.npm.template`. The Desktop records `image_tag_for_dir` in `lock.image_tag` at approval, so the tag is inside the consent digest.

4. **Builds refuse anything that drifted.** `custom_mcp::build::ensure_custom_images` runs from the render (when a runtime is passed) and from Desktop's lazy build, under the build lock and the shared build recovery. Before building it refuses a `lock.image_tag` outside the server's own repository (checked before the engine is asked whether the image exists), a lockfile whose sha256 is not `lock.lockfile_sha256`, another template version, and inputs that give a tag other than the approved one. The context is staged in `<name>/image/` from exactly the files the launcher digest reads (`bundle::read_build_inputs`) and removed after the build. Built tags are recorded per project; `prune_custom_images` removes only recorded tags no running server uses, never by repository name.

## Consequences

- A change to the launcher sources or the template retags every server image; a server whose image is missing then needs a new approval before it can be rebuilt. An image already present keeps running under its recorded tag.
- `Containerfile.npm.template` ships in the bundled build context (both bundle scripts).
- The server image is never pulled (`pull_policy: never`, `CustomMcpImage` rule).

## Rejected alternatives

- **Trusting the repository's lockfile.** A cloned repository would choose the dependency tree.
- **Resolving behind the egress proxy.** The allowlist would have to include every tarball host of every transitive dependency.
- **Pulling a prebuilt image.** It would move trust to whoever published it.

[^1]: npm CLI v11, `npm install`: `--package-lock-only`, `--before`, `ignore-scripts`. https://docs.npmjs.com/cli/v11/commands/npm-install

[^2]: npm CLI v11, `package-lock.json`: `lockfileVersion` 3, `hasInstallScript`, `integrity`. https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json

[^3]: OCI Distribution Specification, tag grammar. https://github.com/opencontainers/distribution-spec/blob/main/spec.md
