#!/usr/bin/env bats

# Guards scripts/sign-windows-binaries.ps1 and its two Tauri hooks in tauri.windows.conf.json
# (ADR-086). Static checks: the script itself only runs on a Windows host with an Azure login.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sign-windows-binaries.ps1"
TAURI_WINDOWS_CONF="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.windows.conf.json"

@test "script exists" {
    [ -f "$SCRIPT" ]
}

@test "script starts with a UTF-8 BOM" {
    # Windows PowerShell reads a BOM-less .ps1 in the system locale (cross-platform rules).
    [ "$(od -An -tx1 -N3 "$SCRIPT" | tr -d ' \n')" = "efbbbf" ]
}

@test "script stops on the first error" {
    grep -qF "\$ErrorActionPreference = 'Stop'" "$SCRIPT"
}

@test "script pins the ArtifactSigning module version" {
    grep -qE "^\\\$ModuleVersion = '[0-9]+\.[0-9]+\.[0-9]+'\$" "$SCRIPT"
    grep -qF -- "-RequiredVersion \$ModuleVersion" "$SCRIPT"
}

@test "script timestamps with the Microsoft RFC3161 authority" {
    # Artifact Signing certificates expire after three days; an untimestamped signature dies with them.
    grep -qF "http://timestamp.acs.microsoft.com" "$SCRIPT"
    grep -qF -- "-TimestampRfc3161 \$TimestampServer" "$SCRIPT"
}

@test "script no-ops without the AZURE_ARTIFACT_SIGNING_* env" {
    grep -qF 'AZURE_ARTIFACT_SIGNING_ENDPOINT' "$SCRIPT"
    grep -qF 'AZURE_ARTIFACT_SIGNING_ACCOUNT' "$SCRIPT"
    grep -qF 'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE' "$SCRIPT"
    grep -qF 'skipping Windows code signing' "$SCRIPT"
}

@test "script excludes the managed-identity probe but keeps the Azure CLI credential" {
    # Hosted runners have no IMDS endpoint; the probe only delays every signing call. The CLI
    # credential is how azure/login's OIDC session reaches the signer.
    grep -qF -- "-ExcludeManagedIdentityCredential" "$SCRIPT"
    if grep -qF -- "-ExcludeAzureCliCredential" "$SCRIPT"; then
        echo "ERROR: AzureCliCredential must stay enabled — azure/login's session is the CI credential" >&2
        return 1
    fi
}

@test "script verifies the signature and its timestamp after signing" {
    grep -qF "Get-AuthenticodeSignature" "$SCRIPT"
    grep -qF "TimeStamperCertificate" "$SCRIPT"
}

@test "SignTargets lists the CLI and no vendor-signed binary" {
    grep -qF "'cli\\speedwave.exe'" "$SCRIPT"
    for vendor in node.exe vulkan-1.dll; do
        if awk '/^\$SignTargets = @\(/,/^\)/' "$SCRIPT" | grep -qF "$vendor"; then
            echo "ERROR: $vendor is vendor-signed (vulkan-1.dll is also hash-pinned) and must not be re-signed" >&2
            return 1
        fi
    done
}

@test "every SignTargets entry is a Windows bundle resource" {
    # Alignment pair: $SignTargets ↔ tauri.windows.conf.json bundle.resources (alignments rules).
    local resources
    resources="$(python3 -c "import json; print('\n'.join(json.load(open('$TAURI_WINDOWS_CONF'))['bundle']['resources'].keys()))")"
    local count=0
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        count=$((count + 1))
        echo "$resources" | grep -qxF "${target//\\//}"
    done < <(awk '/^\$SignTargets = @\(/,/^\)/' "$SCRIPT" | sed -n "s/^ *'\(.*\)'.*$/\1/p")
    [ "$count" -ge 1 ]
}

@test "tauri.windows.conf.json runs the -Bundled pass before bundling from the repo root" {
    python3 - "$TAURI_WINDOWS_CONF" <<'EOF'
import json, sys
hook = json.load(open(sys.argv[1]))["build"]["beforeBundleCommand"]
assert hook["cwd"] == "../..", hook
assert "sign-windows-binaries.ps1" in hook["script"] and "-Bundled" in hook["script"], hook
assert "-NonInteractive" in hook["script"] and "-ExecutionPolicy Bypass" in hook["script"], hook
EOF
}

@test "tauri.windows.conf.json signCommand hands every binary to the script" {
    python3 - "$TAURI_WINDOWS_CONF" <<'EOF'
import json, sys
cmd = json.load(open(sys.argv[1]))["bundle"]["windows"]["signCommand"]
assert cmd["cmd"] == "powershell", cmd
assert cmd["args"][-1] == "%1", cmd
assert any(a.endswith("scripts/sign-windows-binaries.ps1") for a in cmd["args"]), cmd
assert "-NonInteractive" in cmd["args"] and "Bypass" in cmd["args"], cmd
EOF
}
