// swift-tools-version: 5.9
import PackageDescription

// Embeds Resources/Info.plist into Mach-O `__TEXT,__info_plist` section so the
// CLI binary carries `CFBundleIdentifier` (`pl.speedwave.desktop.mail`) and
// `NSAppleEventsUsageDescription` directly — required by TCC for
// AEDeterminePermissionToAutomateTarget when the binary calls into Apple Mail.
// See calendar/Package.swift for the full rationale.
let package = Package(
    name: "mail-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "mail-cli",
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
            name: "MailTests",
            dependencies: ["mail-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
