// swift-tools-version:5.9
// Il cuore dell'app: protocollo della penna Neo, scaricamento delle pagine, archivio e invio.
// Non dipende da CoreBluetooth né da UIKit: si compila e si prova anche fuori da Xcode.
import PackageDescription

let package = Package(
    name: "NeoPenKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "NeoPenKit", targets: ["NeoPenKit"])],
    targets: [
        .target(name: "NeoPenKit"),
        .testTarget(name: "NeoPenKitTests", dependencies: ["NeoPenKit"]),
    ]
)
