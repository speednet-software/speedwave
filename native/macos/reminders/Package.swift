// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "reminders-cli",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "reminders-cli",
            path: "Sources"
        ),
        .testTarget(
            name: "RemindersTests",
            dependencies: ["reminders-cli"],
            path: "Tests"
        ),
    ]
)
