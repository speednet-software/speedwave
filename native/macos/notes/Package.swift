// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "notes-cli",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "notes-cli",
            path: "Sources"
        ),
        .testTarget(
            name: "NotesTests",
            dependencies: ["notes-cli"],
            path: "Tests"
        ),
    ]
)
