# ADR-086: Windows Code Signing via Azure Artifact Signing and GitHub OIDC

> **Status:** Accepted
> **Context:** Windows release artifacts (the NSIS `.exe` installer, the `.msi`, the app binary and the standalone CLI) shipped unsigned. The release workflow exported `WINDOWS_CERTIFICATE` secrets that neither Tauri nor `tauri-action` reads, so the pipeline looked configured while SmartScreen warned on every install. ADR-037 covers macOS only and left Windows "tracked separately".

## Decision

Sign every Windows PE artifact with Azure Artifact Signing (formerly Trusted Signing), Microsoft's managed code-signing service, using the existing `Speednet` account in Poland Central and its `Speedwave` Public Trust certificate profile. Two hooks in `desktop/src-tauri/tauri.windows.conf.json` route all signing through one script, `scripts/sign-windows-binaries.ps1`:

- `bundle.windows.signCommand` (object form): Tauri calls the script with `%1` for the main executable, the NSIS installer and uninstaller, the NSIS plugin DLLs and the MSI.[^1][^2]
- `build.beforeBundleCommand` (Windows override, cwd `../..`): runs the script with `-Bundled`, which signs the PE files we build ourselves that Tauri copies in as plain resources (`$SignTargets`, today `cli\speedwave.exe`). This is the Windows counterpart of ADR-037's `sign-bundled-binaries.sh`.

The `cli` release job signs the standalone Windows CLI with the same script before zipping it.

The script signs through Microsoft's `ArtifactSigning` PowerShell module (pinned by `$ModuleVersion`), which fetches the pinned SignTool and dlib packages itself and authenticates with `DefaultAzureCredential`.[^3][^4] Every signature carries an RFC 3161 timestamp from `http://timestamp.acs.microsoft.com`: Artifact Signing certificates are valid for three days, so an untimestamped signature would expire with them.[^3] After each call the script re-reads the file with `Get-AuthenticodeSignature` and fails unless the status is `Valid`, a timestamper certificate is present, and the signer certificate carries the EKU `1.3.6.1.4.1.311.97.1.0` that every Artifact Signing Public Trust certificate contains.[^13] The EKU check is what proves the signature is ours: a file that already carried another publisher's valid signature passed the first two checks in a live smoke run.

CI authenticates with **OpenID Connect and no stored secret**. The `publish-tauri` and `cli` jobs run in the `release` GitHub environment with `id-token: write`; `azure/login` exchanges the job's OIDC token for an Azure session; an Entra app registration carries a federated credential whose subject is exactly `repo:speednet-software/speedwave:environment:release`.[^5][^6] That app holds only the `Artifact Signing Certificate Profile Signer` role, scoped to the signing account. The endpoint, account and profile names plus the client, tenant and subscription ids are GitHub variables on the `release` environment (none of them is a secret); `.github/actions/azure-signing-login` validates them and exports the `AZURE_ARTIFACT_SIGNING_*` env the script reads.

Without that env the script exits 0 with a notice, so PR builds, `desktop-build.yml` and a local `make build-desktop` stay unsigned without any Azure access, the same contract `APPLE_SIGNING_IDENTITY` gives macOS in ADR-037. A client id with an incomplete signing target fails the job instead: a half-configured release must never ship unsigned by accident.

## Why

- **A PFX in a secret is no longer an option.** Tauri's `certificateThumbprint` flow applies only to OV certificates acquired before June 1, 2023; newer certificates keep the private key on hardware or in a cloud HSM.[^1] Artifact Signing is the cloud-HSM path with the smallest surface: Microsoft issues short-lived certificates on demand, so nothing sensitive exists to leak or rotate.
- **The account already existed.** Poland Central is a supported region, EU organizations are eligible for Public Trust, and the company's identity validation and certificate profile were already complete.[^4]
- **OIDC beats a client secret.** `artifact-signing-cli`, the tool Tauri's guide shows, shells out to `az login --service-principal` and therefore needs a long-lived client secret in GitHub.[^1][^7] The official dlib and PowerShell module use `DefaultAzureCredential`, which picks up the `azure/login` session, so a federated credential replaces the secret entirely.[^3][^6]
- **Signing must happen inside `tauri build`.** `makensis` signs the uninstaller through Tauri's `!uninstfinalize` hook, and the main executable must be signed before it is packed into the installer. A post-build pass over the output folder (the `azure/artifact-signing-action` pattern) would leave the uninstaller and the embedded binary unsigned.[^2][^8]
- **Tauri does not sign `bundle.resources`.** The bundler signs binaries, sidecars, the WebView2 loader, the NSIS plugins and the produced installers, and copies resources verbatim.[^9] The `-Bundled` pass covers that gap for the files we build; vendor-signed `node.exe` and the hash-pinned `vulkan-1.dll` are never re-signed.

## Where it lives in code

- **Signing script (SSOT)**: `scripts/sign-windows-binaries.ps1` holds `$ModuleVersion`, `$TimestampServer`, `$SignTargets`, the credential exclusions and the post-sign verification. `$SignTargets` ↔ `tauri.windows.conf.json` `bundle.resources` is an alignment pair (alignments rules).
- **Hooks**: `desktop/src-tauri/tauri.windows.conf.json`, `build.beforeBundleCommand` and `bundle.windows.signCommand`.
- **Login and env export**: `.github/actions/azure-signing-login/action.yml`, used by the `publish-tauri` and `cli` jobs in `.github/workflows/desktop-release.yml`.
- **Guards**: `_tests/desktop/sign-windows-binaries.bats` and `_tests/desktop/release-workflow-signing.bats`.

## Rejected alternatives

- **`certificateThumbprint` plus a base64 PFX secret.** The shape the old `WINDOWS_CERTIFICATE` secrets implied; unusable with any certificate issued after the hardware-key requirement.[^1]
- **`artifact-signing-cli` with `AZURE_CLIENT_SECRET`.** Works, but stores a long-lived credential in GitHub for no gain over OIDC.[^7]
- **`azure/artifact-signing-action` after `tauri build`.** Leaves the uninstaller and the embedded binary unsigned (see above).[^8]
- **SignPath Foundation (free for open source).** Every release needs a manual approval in their portal and signing runs outside the build, which does not fit the automated release-please flow.[^10]
- **A Polish CA cloud certificate (Certum SimplySign).** Needs a desktop signing session on a dedicated agent, so it is unusable on hosted runners.[^11]

## Notes

- The hooks invoke `powershell` (Windows PowerShell 5.1) by name: a JSON config cannot compute the System32 path that `binary::run_powershell` uses in Rust. This is the same trust in the runner's `PATH` that every bare tool Tauri spawns (`makensis`, `candle`) already relies on.
- The `ArtifactSigning` module is published for PowerShell 7 only (`PSEdition_Core`), so Windows PowerShell cannot find it on the gallery.[^12] The hooks still launch 5.1, the one edition present on every Windows host, and the script re-executes itself under `pwsh` only after the no-op check: an unsigned build needs no PowerShell 7, a signing host does (hosted runners ship it).
- The `release` environment has a deployment-branch policy: only runs whose ref is the `main` branch or a `v*` tag may enter it. Since the OIDC subject carries the environment name only when the job references that environment, and a job on any other ref is rejected before it starts, a collaborator cannot mint a signature from a feature branch, and a fork pull request cannot obtain a write-scoped token at all.[^5][^14] Adding required reviewers on top would gate every release build, not only signing.
- The module cache on disk belongs to the runner: hosted runners are ephemeral, the module version is pinned, and the SignTool and dlib package versions are pinned inside that module version.[^12]

[^1]: [Windows Code Signing - Tauri](https://v2.tauri.app/distribute/sign/windows/): the `certificateThumbprint` flow applies only to OV certificates acquired before June 1, 2023; `signCommand` with `%1`; the Azure Artifact Signing example uses `artifact-signing-cli`.

[^2]: [Configuration - Tauri](https://v2.tauri.app/reference/config/#customsigncommandconfig): `CustomSignCommandConfig` string and `{ cmd, args }` forms, `%1` replaced with the path of the binary to sign.

[^3]: [Set up signing integrations to use Artifact Signing - Microsoft Learn](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations): SignTool plus dlib, `DefaultAzureCredential` with per-credential exclusion, three-day certificate validity and the `http://timestamp.acs.microsoft.com` time stamping authority.

[^4]: [Quickstart: Set up Artifact Signing - Microsoft Learn](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart): Public Trust eligibility for EU organizations, the Poland Central region and its `plc.codesigning.azure.net` endpoint, the `Certificate Profile Signer` role.

[^5]: [Configuring OpenID Connect in Azure - GitHub Docs](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure): federated credential on an Entra app, `id-token: write`, environment-scoped subject claim.

[^6]: [Azure/login - GitHub](https://github.com/Azure/login): OIDC login with `client-id`, `tenant-id`, `subscription-id`, `allow-no-subscriptions`.

[^7]: [levminer/trusted-signing-cli - GitHub](https://github.com/levminer/trusted-signing-cli): the `artifact-signing-cli` crate; requires `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.

[^8]: [Azure/artifact-signing-action - GitHub](https://github.com/Azure/artifact-signing-action): signs files under a folder after the build and installs the `ArtifactSigning` PowerShell module.

[^9]: [tauri-bundler `windows/nsis/mod.rs` - GitHub](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs): `try_sign` runs on binaries, the WebView2 loader, the NSIS plugins and the produced installer; `generate_resource_data` copies `bundle.resources` without signing.

[^10]: [SignPath Foundation terms](https://signpath.org/terms): OSI license requirement, manual approval of every release, code signing policy on the project homepage.

[^11]: [Certum Standard Code Signing in the Cloud](https://shop.certum.eu/standard-code-signing-in-the-cloud.html): SimplySign Desktop emulates a card reader on the signing workstation.

[^12]: [ArtifactSigning - PowerShell Gallery](https://www.powershellgallery.com/packages/ArtifactSigning): the module exporting `Invoke-ArtifactSigning`, tagged `PSEdition_Core`.

[^14]: [Workflow syntax for GitHub Actions - GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): for pull requests from forks the `permissions` key cannot grant `write` access (so `id-token: write` is unavailable), and a job that references an environment is subject to that environment's protection rules and deployment branch policy.

[^13]: [Artifact Signing certificate management - Microsoft Learn](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management): all Artifact Signing Public Trust certificates contain the `1.3.6.1.4.1.311.97.1.0` EKU, in addition to the code signing EKU `1.3.6.1.5.5.7.3.3`.
