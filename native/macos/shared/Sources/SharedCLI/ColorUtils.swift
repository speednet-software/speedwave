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
