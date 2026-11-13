import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Compile the existing Noteject artwork as an opaque iOS AppIcon asset.
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let size = 1024
guard let images = CGImageSourceCreateWithURL(source as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(images, 0, nil),
      let canvas = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                             bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("Could not load the Noteject icon.")
}

let bounds = CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))
canvas.setFillColor(red: 33.0 / 255, green: 30.0 / 255, blue: 54.0 / 255, alpha: 1)
canvas.fill(bounds)
canvas.interpolationQuality = .high
canvas.draw(logo, in: bounds)
guard let icon = canvas.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Could not prepare the iOS icon.")
}
CGImageDestinationAddImage(destination, icon, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not save the iOS icon.") }
