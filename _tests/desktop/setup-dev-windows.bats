#!/usr/bin/env bats


SETUP_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/setup-dev-windows.ps1"
BUDGET_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/check-vulkan-path-budget.sh"
REPO_ROOT="$BATS_TEST_DIRNAME/../.."

line_of() {
    grep -n -- "$1" "$SETUP_SCRIPT" | head -1 | cut -d: -f1
}

package_loop() {
    awk '/^foreach \(\$pkg in \$packages\) \{$/,/^\}$/' "$SETUP_SCRIPT"
}

@test "script starts with a UTF-8 BOM" {
    [ "$(od -An -tx1 -N3 "$SETUP_SCRIPT" | tr -d ' \n')" = "efbbbf" ]
}

@test "the script writes only the msvc env, bashrc and the crate-local cargo config" {
    local targets
    targets="$(grep -oE '(Set-Content|Add-Content|Out-File) -Path \$[A-Za-z_]+' "$SETUP_SCRIPT" |
        awk '{ print $NF }' | sort -u | tr '\n' ' ')"
    [ "$targets" = '$bashrc $envShWin $tauriCargoConfig ' ]
}

@test "desktop/src-tauri/.gitignore keeps the generated cargo config untracked" {
    grep -qx "/\.cargo/" "$REPO_ROOT/desktop/src-tauri/.gitignore"
}

@test "the generated target-dir fits the budget check-vulkan-path-budget.sh enforces" {
    local leaf len suffix maxpath
    leaf="$(grep -oE "SystemDrive \+ '[^']+'" "$SETUP_SCRIPT" | sed "s/.*'\(.*\)'/\1/")"
    [ -n "$leaf" ]
    len=$(( 2 + ${#leaf} ))
    suffix="$(grep -oE '^SUFFIX_BUDGET=[0-9]+' "$BUDGET_SCRIPT" | cut -d= -f2)"
    maxpath="$(grep -oE '^MAX_PATH=[0-9]+' "$BUDGET_SCRIPT" | cut -d= -f2)"
    [ $(( len + suffix )) -le "$maxpath" ]
}

@test "the crate-local config is only kept when it actually pins a target-dir" {
    grep -qF "(?m)^\\s*target-dir\\s*=" "$SETUP_SCRIPT"
    grep -qF 'target-dir = `"$shortTargetDir`"' "$SETUP_SCRIPT"
}

@test "setup-dev-windows installs one package per choco invocation" {
    [ "$(grep -cE '^[[:space:]]*choco ' "$SETUP_SCRIPT")" = "1" ]
    grep -qF 'choco $verb -y --no-progress $pkg.Name' "$SETUP_SCRIPT"
}

@test "the package loop never exits early" {
    ! package_loop | grep -vE '^[[:space:]]*#' | grep -qE '(^|[[:space:]]|\{)exit([[:space:]]|$)'
}

@test "a package still missing after a 3010 reboot code stays a reported failure" {
    local hits
    hits="$(package_loop | grep -cE '3010.*continue' || true)"
    [ "$hits" -eq 0 ]
    package_loop | grep -qF '$failedItems += @{ Name = $pkg.Name'
}

@test "a 3010 reboot signal is captured before the success-path continue" {
    local code reboot have
    code="$(package_loop | grep -vE '^[[:space:]]*#')"
    reboot="$(printf '%s\n' "$code" | grep -n '3010' | head -1 | cut -d: -f1)"
    have="$(printf '%s\n' "$code" | grep -nF 'if (& $pkg.Have) { continue }' | head -1 | cut -d: -f1)"
    [ -n "$reboot" ]
    [ "$reboot" -lt "$have" ]
}

@test "an existing crate-local config's own target-dir is the one managed" {
    grep -qF '$shortTargetDir = $Matches[1]' "$SETUP_SCRIPT"
    grep -qF 'IsPathRooted($shortTargetDir)' "$SETUP_SCRIPT"
}

@test "the short target-dir is created here, and a foreign owner is refused" {
    grep -qF 'GetOwner([Security.Principal.SecurityIdentifier])' "$SETUP_SCRIPT"
    grep -qF "@(\$mySid, 'S-1-5-32-544', 'S-1-5-18') -notcontains \$owner" "$SETUP_SCRIPT"
    grep -qF '$failedItems += @{ Name = $shortTargetWin' "$SETUP_SCRIPT"
}

@test "the short target-dir drops the inherited drive-root ACEs" {
    grep -qF 'icacls $shortTargetWin /inheritance:r /grant:r' "$SETUP_SCRIPT"
    ! grep -qE 'icacls \$shortTargetWin /grant[^:]' "$SETUP_SCRIPT"
}

@test "every ACL principal is a well-known SID, never an account name" {
    local hits
    hits="$(grep -vE '^[[:space:]]*#' "$SETUP_SCRIPT" | grep -cE 'BUILTIN.|NT AUTHORITY.' || true)"
    [ "$hits" -eq 0 ]
    grep -qF "\$SID_ADMINISTRATORS = '*S-1-5-32-544'" "$SETUP_SCRIPT"
    grep -qF "\$SID_LOCAL_SYSTEM = '*S-1-5-18'" "$SETUP_SCRIPT"
    grep -qF '([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value' "$SETUP_SCRIPT"
}

@test "a target-dir with a foreign owner is refused, not re-ACLed" {
    grep -qF '$ownerTrusted = $false' "$SETUP_SCRIPT"
    grep -qF 'if ($ownerTrusted) {' "$SETUP_SCRIPT"
}

@test "a missing git cannot abort the long-paths step" {
    local block
    block="$(awk '/^# No 2>&1 capture:/,/^\}$/' "$SETUP_SCRIPT")"
    printf '%s\n' "$block" | grep -qF 'git config --system core.longpaths true'
    printf '%s\n' "$block" | grep -qF 'try {'
    printf '%s\n' "$block" | grep -qF "\$failedItems += @{ Name = 'git core.longpaths'"
}

@test "the node probe enforces the .node-version floor, not mere presence" {
    grep -qF 'Have = { Test-PinnedNode }' "$SETUP_SCRIPT"
    grep -qF "Join-Path \$repoRoot '.node-version'" "$SETUP_SCRIPT"
    grep -qE "Name = 'nodejs-lts'.*Upgrade = \\\$true" "$SETUP_SCRIPT"
}

@test "no bats package is listed (none exists on the Chocolatey feed)" {
    ! awk '/\$packages = @\(/,/^\)$/' "$SETUP_SCRIPT" | grep -q 'bats'
}

@test "setup-dev-windows installs ninja for the forced Ninja generator" {
    grep -qF "Name = 'ninja'" "$SETUP_SCRIPT"
    grep -qF "export CMAKE_GENERATOR='Ninja'" "$SETUP_SCRIPT"
}

@test "every package carries a capability probe re-checked after the install" {
    local block declared probes
    block="$(awk '/\$packages = @\(/,/^\)$/' "$SETUP_SCRIPT")"
    declared="$(printf '%s\n' "$block" | grep -c "@{ Name = '")"
    probes="$(printf '%s\n' "$block" | grep -c "Have = {")"
    [ "$declared" -eq "$probes" ]
    grep -qF 'if (& $pkg.Have) { continue }' "$SETUP_SCRIPT"
}

@test "a failed item is reported after the config phases, not before them" {
    local vulkan longpaths targetdir report
    vulkan="$(line_of '== Vulkan SDK')"
    longpaths="$(line_of 'LongPathsEnabled')"
    targetdir="$(line_of 'Wrote desktop/src-tauri/.cargo/config.toml')"
    report="$(line_of '== Incomplete')"
    [ -n "$report" ]
    [ "$vulkan" -lt "$report" ]
    [ "$longpaths" -lt "$report" ]
    [ "$targetdir" -lt "$report" ]
}

@test "a missing item still fails the script" {
    local report exit_line
    report="$(line_of '== Incomplete')"
    exit_line="$(awk -v s="$report" 'NR > s && $0 ~ /^[[:space:]]*exit 1$/ { print NR; exit }' \
        "$SETUP_SCRIPT")"
    [ -n "$exit_line" ]
}
