// swift-tools-version: 5.9
import PackageDescription

// The `-sectcreate __TEXT __info_plist Resources/Info.plist` linker flags embed
// the package's Info.plist into the resulting Mach-O's `__TEXT,__info_plist`
// section, which is what macOS reads for `Bundle.main.bundleIdentifier` and TCC
// usage descriptions when the binary runs as a standalone CLI tool (no parent
// .app bundle wrapping it). Without this, EventKit's `requestFullAccessToEvents`
// silently rejects on macOS 14+ because it cannot find
// `NSCalendarsFullAccessUsageDescription` — the parent .app's Info.plist is not
// inherited across `posix_spawn`.
//
// The path is relative to the package root at swift build time. The version
// string in Resources/Info.plist is stamped from tauri.conf.json by
// `scripts/build-native-macos.sh` before this build runs.
let package = Package(
    name: "calendar-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "calendar-cli",
            dependencies: [.product(name: "SharedCLI", package: "shared")],
            path: "Sources",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Resources/Info.plist",
                ]),
            ]
        ),
        .testTarget(
            name: "CalendarTests",
            dependencies: ["calendar-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
