// swift-tools-version: 5.9
import PackageDescription

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
            path: "Sources"
        ),
        .testTarget(
            name: "NotesTests",
            dependencies: ["notes-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
