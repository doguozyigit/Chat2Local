// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "LocalDevMenuBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LocalDevMenuBar", targets: ["LocalDevMenuBar"])
    ],
    targets: [
        .target(
            name: "LocalDevApiAuth",
            path: "Sources/LocalDevApiAuth"
        ),
        .executableTarget(
            name: "LocalDevMenuBar",
            dependencies: ["LocalDevApiAuth"],
            path: "Sources/LocalDevMenuBar"
        )
    ]
)
