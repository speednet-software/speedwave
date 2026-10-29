// swift-tools-version: 5.9
import Foundation
import PackageDescription

let stagedInfoPlist = Context.packageDirectory + "/.build/Info.plist"
let infoPlist = FileManager.default.fileExists(atPath: stagedInfoPlist)
    ? stagedInfoPlist
    : Context.packageDirectory + "/Resources/Info.plist"

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
            name: "NotesTests",
            dependencies: ["notes-cli", .product(name: "SharedCLI", package: "shared")],
            path: "Tests"
        ),
    ]
)
