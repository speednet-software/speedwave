// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "calendar-cli",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "calendar-cli",
            path: "Sources"
        ),
        .testTarget(
            name: "CalendarTests",
            dependencies: ["calendar-cli"],
            path: "Tests"
        ),
    ]
)
