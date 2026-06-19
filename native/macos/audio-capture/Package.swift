// swift-tools-version: 5.9
import PackageDescription

// Embeds Resources/Info.plist into Mach-O `__TEXT,__info_plist` so the CLI binary
// carries CFBundleIdentifier, NSAudioCaptureUsageDescription, NSMicrophoneUsageDescription.
let package = Package(
    name: "audio-capture-cli",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "audio-capture-cli",
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
            name: "AudioCaptureTests",
            dependencies: ["audio-capture-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
