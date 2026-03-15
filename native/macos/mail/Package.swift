// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "mail-cli",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "mail-cli",
            path: "Sources",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        ),
        .testTarget(
            name: "MailTests",
            dependencies: ["mail-cli"],
            path: "Tests"
        ),
    ]
)
