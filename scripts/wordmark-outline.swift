import Foundation
import CoreText
import CoreGraphics

// Outline the bundled, unmodified Pacifico font with CoreText shaping.
// The font's SIL Open Font License ships in renderer/public/licenses.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fontURL = root.appendingPathComponent("src/renderer/src/assets/fonts/Pacifico-Regular.ttf")
guard let provider = CGDataProvider(url: fontURL as CFURL), let graphicsFont = CGFont(provider) else {
  fatalError("The bundled wordmark font is missing.")
}
let font = CTFontCreateWithGraphicsFont(graphicsFont, 1000, nil, nil)
let label = NSAttributedString(string: "faangin.", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
let line = CTLineCreateWithAttributedString(label)
let outline = CGMutablePath()
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count)
  var positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
  for index in 0..<count {
    if let path = CTFontCreatePathForGlyph(font, glyphs[index], nil) {
      outline.addPath(path, transform: CGAffineTransform(translationX: positions[index].x, y: positions[index].y))
    }
  }
}
func number(_ value: CGFloat) -> String { String(format: "%.3f", Double(value)) }
func point(_ value: CGPoint) -> String { "\(number(value.x)) \(number(value.y))" }
var commands = ""
outline.applyWithBlock { element in
  let item = element.pointee
  switch item.type {
  case .moveToPoint: commands += "M\(point(item.points[0]))"
  case .addLineToPoint: commands += "L\(point(item.points[0]))"
  case .addQuadCurveToPoint: commands += "Q\(point(item.points[0])) \(point(item.points[1]))"
  case .addCurveToPoint: commands += "C\(point(item.points[0])) \(point(item.points[1])) \(point(item.points[2]))"
  case .closeSubpath: commands += "Z"
  @unknown default: fatalError("Unsupported wordmark path element.")
  }
}
let bounds = outline.boundingBoxOfPath
let padding: CGFloat = 40
let wordmark = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(number(bounds.width + padding * 2)) \(number(bounds.height + padding * 2))" role="img" aria-label="faangin.">
  <path fill="currentColor" transform="translate(\(number(padding - bounds.minX)) \(number(padding + bounds.maxY))) scale(1 -1)" d="\(commands)"/>
</svg>
"""
let scale = min(800 / bounds.width, 480 / bounds.height)
let x = (1024 - bounds.width * scale) / 2 - bounds.minX * scale
let y = (1024 + bounds.height * scale) / 2 + bounds.minY * scale
let icon = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="surface" x2="0" y2="1"><stop stop-color="#262626"/><stop offset="1" stop-color="#111111"/></linearGradient></defs>
  <rect x="42" y="42" width="940" height="940" rx="214" fill="url(#surface)"/>
  <rect x="44" y="44" width="936" height="936" rx="212" fill="none" stroke="#fff" stroke-opacity=".15" stroke-width="3"/>
  <path fill="#fff" transform="translate(\(number(x)) \(number(y))) scale(\(number(scale)) -\(number(scale)))" d="\(commands)"/>
</svg>
"""
let output = root.appendingPathComponent("src/renderer/public/branding")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try wordmark.write(to: output.appendingPathComponent("faangin-wordmark.svg"), atomically: true, encoding: .utf8)
try icon.write(to: root.appendingPathComponent("resources/icon.svg"), atomically: true, encoding: .utf8)
print("Outlined the full wordmark and native app icon.")
