// swift-tools-version: 5.9
import PackageDescription

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
            path: "Sources"
        ),
        .testTarget(
            name: "MailTests",
            dependencies: ["mail-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
