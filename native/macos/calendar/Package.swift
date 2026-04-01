// swift-tools-version: 5.9
import PackageDescription

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
            path: "Sources"
        ),
        .testTarget(
            name: "CalendarTests",
            dependencies: ["calendar-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
