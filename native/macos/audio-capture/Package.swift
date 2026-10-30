// swift-tools-version: 5.9
import PackageDescription

let infoPlist = Context.packageDirectory + "/Resources/Info.plist"

let package = Package(
    name: "audio-capture-cli",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .target(
            name: "SafeAudioTap",
            path: "SafeAudioTap",
            linkerSettings: [.linkedFramework("AVFoundation")]
        ),
        .executableTarget(
            name: "audio-capture-cli",
            dependencies: ["SafeAudioTap", .product(name: "SharedCLI", package: "shared")],
            path: "Sources",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", infoPlist,
                ]),
            ]
        ),
        .testTarget(
            name: "AudioCaptureTests",
            dependencies: [
                "audio-capture-cli", "SafeAudioTap",
                .product(name: "SharedCLI", package: "shared"),
            ],
            path: "Tests"
        ),
    ]
)
