// swift-tools-version: 5.9
import PackageDescription

// Embeds Resources/Info.plist into Mach-O `__TEXT,__info_plist` section so the
// CLI binary carries `CFBundleIdentifier` (`pl.speedwave.desktop.notes`) and
// `NSAppleEventsUsageDescription` directly — required by TCC for
// AEDeterminePermissionToAutomateTarget when the binary calls into Notes.
// See calendar/Package.swift for the full rationale.
let package = Package(
    name: "notes-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "notes-cli",
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
            name: "NotesTests",
            dependencies: ["notes-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
