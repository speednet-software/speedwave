// swift-tools-version: 5.9
import PackageDescription

let infoPlist = Context.packageDirectory + "/Resources/Info.plist"

let package = Package(
    name: "reminders-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../shared"),
    ],
    targets: [
        .executableTarget(
            name: "reminders-cli",
            dependencies: [.product(name: "SharedCLI", package: "shared")],
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
            name: "RemindersTests",
            dependencies: ["reminders-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
