// swift-tools-version: 5.9
import PackageDescription

// Embeds Resources/Info.plist into the Mach-O `__TEXT,__info_plist` section so the CLI binary
// carries `CFBundleIdentifier` + `NSRemindersFullAccessUsageDescription` (TCC/EventKit, macOS 14+).
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
