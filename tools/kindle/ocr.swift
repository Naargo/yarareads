// OCR a page image with Apple Vision: prints JSON [{text, x, y, w, h}] per line, in pixels from the top left.
// Usage: swift tools/kindle/ocr.swift <image.png>
import Vision
import AppKit

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let image = NSImage(contentsOf: url)!
var rect = CGRect(origin: .zero, size: image.size)
let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: cg).perform([req])
var out: [[String: Any]] = []
for o in req.results ?? [] {
  guard let t = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  out.append(["text": t.string, "x": Int(b.minX * W), "y": Int((1 - b.maxY) * H), "w": Int(b.width * W), "h": Int(b.height * H)])
}
print(String(data: try JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
