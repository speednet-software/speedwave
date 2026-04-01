// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SharedCLI",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SharedCLI", targets: ["SharedCLI"]),
    ],
    targets: [
        .target(
            name: "SharedCLI",
            path: "Sources/SharedCLI",
            linkerSettings: [
                .linkedFramework("EventKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .testTarget(
            name: "SharedCLITests",
            dependencies: ["SharedCLI"],
            path: "Tests/SharedCLITests"
        ),
    ]
)
