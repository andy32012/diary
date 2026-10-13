// swift-tools-version: 5.9

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "Diary",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "Diary",
            targets: ["AppModule"],
            bundleIdentifier: "com.hixuanye.diary",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .book),
            accentColor: .presetColor(.pink),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
