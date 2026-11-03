import CoreGraphics

public func hexColor(from cgColor: CGColor) -> String? {
    guard let components = cgColor.components, components.count >= 3 else {
        return nil
    }
    let r = min(max(Int(components[0] * 255), 0), 255)
    let g = min(max(Int(components[1] * 255), 0), 255)
    let b = min(max(Int(components[2] * 255), 0), 255)
    return String(format: "#%02x%02x%02x", r, g, b)
}

/// Parses `#RRGGBB` (the format `hexColor(from:)` writes) into an sRGB color; nil for anything else.
public func parseHexColor(_ string: String) -> CGColor? {
    let digits = Array(string.dropFirst())
    guard string.hasPrefix("#"), digits.count == 6, digits.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
        return nil
    }
    let bytes = stride(from: 0, to: 6, by: 2).compactMap { Int(String(digits[$0...$0 + 1]), radix: 16) }
    let channels = bytes.map { min((Double($0) + 0.5) / 255, 1) }
    return CGColor(srgbRed: channels[0], green: channels[1], blue: channels[2], alpha: 1)
}
