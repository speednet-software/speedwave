// swift-tools-version: 5.9
import PackageDescription

// The `-sectcreate __TEXT __info_plist Resources/Info.plist` linker flags embed
// Info.plist into the Mach-O so TCC reads the EventKit usage descriptions.
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
