// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CodictateParakeetHelper",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "CodictateParakeetHelper", targets: ["CodictateParakeetHelper"]),
  ],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.13.6"),
  ],
  targets: [
    .systemLibrary(
      name: "CNemoTextProcessing",
      path: "Sources/CNemoTextProcessing"
    ),
    .executableTarget(
      name: "CodictateParakeetHelper",
      dependencies: [
        .product(name: "FluidAudio", package: "FluidAudio"),
        "CNemoTextProcessing",
      ],
      linkerSettings: [
        // CNemoTextProcessing modulemap links `text_processing_rs`; only the search path is extra.
        .unsafeFlags(["-LVendor/lib"]),
        .linkedFramework("AVFoundation"),
        .linkedFramework("CoreAudio"),
      ]
    ),
  ]
)
