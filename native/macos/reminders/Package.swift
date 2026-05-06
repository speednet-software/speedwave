// swift-tools-version: 5.9
import PackageDescription

// Embeds Resources/Info.plist into Mach-O `__TEXT,__info_plist` section so the
// CLI binary carries `CFBundleIdentifier` (`pl.speedwave.desktop.reminders`) and
// `NSRemindersFullAccessUsageDescription` directly — required by TCC for
// EventKit's `requestFullAccessToReminders` on macOS 14+. See calendar/Package.swift
// for the full rationale (parent .app's Info.plist is not inherited across spawn).
let package = Package(
    name: "reminders-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "reminders-cli",
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
            name: "RemindersTests",
            dependencies: ["reminders-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
