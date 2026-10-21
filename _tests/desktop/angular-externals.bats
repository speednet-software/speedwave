#!/usr/bin/env bats

ANGULAR_JSON="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/desktop/src/angular.json"

_build_target() {
    node -e '
      const build = require(process.argv[1]).projects["speedwave-desktop-ui"].architect.build;
      process.stdout.write(JSON.stringify(build[process.argv[2]] ?? null));
    ' "$ANGULAR_JSON" "$1"
}

@test "build options keep elkjs out of the bundle" {
    run _build_target options
    [ "$status" -eq 0 ]
    run node -e 'process.exit(JSON.parse(process.argv[1]).externalDependencies?.includes("elkjs") ? 0 : 1)' "$output"
    [ "$status" -eq 0 ]
}

@test "no build configuration replaces externalDependencies without elkjs" {
    run _build_target configurations
    [ "$status" -eq 0 ]
    run node -e '
      const configs = JSON.parse(process.argv[1]) ?? {};
      const dropped = Object.entries(configs)
        .filter(([, c]) => "externalDependencies" in c && !c.externalDependencies.includes("elkjs"))
        .map(([name]) => name);
      process.stdout.write(dropped.join(","));
    ' "$output"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
