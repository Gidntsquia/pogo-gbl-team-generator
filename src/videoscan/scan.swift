// Frame + pixel extractor for the video importer (src/videoscan).
//
// macOS-only helper, run as a Swift script (`swift scan.swift ...`) by
// src/videoscan/probe.js. It is deliberately DUMB: it knows nothing about
// Pokemon, appraisal bars, or IVs. It decodes a video, runs Apple's Vision
// text recognizer on each sampled frame, and run-length-encodes the pixels
// of one rectangular region so the JS side can do all the interpretation
// (and be unit-tested against recorded JSON fixtures).
//
// Usage:
//   swift scan.swift <video> <intervalSeconds> <rx> <ry> <rw> <rh>
//                    [<sx> <sy> <sw> <sh> [<bx> <by> <bw> <bh>]...]
//
// <rx,ry,rw,rh> are the pixel-region of interest in normalized, TOP-LEFT
// origin coordinates. <sx,sy,sw,sh> is an optional second region, the
// "strip", summarised one row at a time instead of run-length encoded.
// Any further quadruples are "boxes", each summarised as a single mean
// colour -- the coarsest summary there is, for a caller that only wants to
// compare one patch of the screen against another.
//
// Output: JSON Lines on stdout, one object per sampled frame:
//   {"t":0.25,"w":384,"h":832,
//    "text":[{"x":..,"y":..,"w":..,"h":..,"c":0.5,"s":"CP1498"}],
//    "rows":[{"y":645,"runs":[[x,len,r,g,b],...]}],
//    "strip":[[r,g,b],...],"boxes":[[r,g,b],...]}
//
// `text` boxes are normalized with a TOP-LEFT origin (Vision's own
// bottom-left origin is converted here) so JS never has to flip anything.
// `rows` holds only rows that contain a long non-white run -- a generic
// structural filter that keeps horizontal bar-like shapes and throws away
// the flat background, keeping the JSON small on long videos.
// `strip` is the mean colour of every row of the strip region, top to
// bottom -- the cheapest possible summary of a tall narrow slice, for
// finding a horizontal band whose colour matters but whose edges do not.
// `boxes` is one mean colour per box argument, in the order given.

import AVFoundation
import CoreImage
import Foundation
import Vision

// ---------------------------------------------------------------- args --

let args = CommandLine.arguments
guard args.count >= 7 else {
  FileHandle.standardError.write("usage: scan.swift <video> <interval> <rx> <ry> <rw> <rh>\n".data(using: .utf8)!)
  exit(2)
}
let videoPath = args[1]
let interval = Double(args[2]) ?? 0.25
let rx = Double(args[3]) ?? 0.0
let ry = Double(args[4]) ?? 0.0
let rw = Double(args[5]) ?? 1.0
let rh = Double(args[6]) ?? 1.0
let strip: (Double, Double, Double, Double)? =
  args.count >= 11
    ? (Double(args[7]) ?? 0.0, Double(args[8]) ?? 0.0, Double(args[9]) ?? 0.0, Double(args[10]) ?? 0.0)
    : nil
/// Every complete quadruple after the strip. A trailing partial one is
/// ignored rather than read as zeroes, which would average the whole frame.
let boxArgs: [(Double, Double, Double, Double)] = stride(from: 11, to: args.count - 3, by: 4).map {
  (Double(args[$0]) ?? 0.0, Double(args[$0 + 1]) ?? 0.0, Double(args[$0 + 2]) ?? 0.0, Double(args[$0 + 3]) ?? 0.0)
}

// Two pixels belong to the same run when every channel is within this of the
// run's first pixel. Large enough to survive video compression noise on a
// flat UI fill, small enough that an orange->grey bar boundary always splits.
let COLOR_TOLERANCE = 10
// A row is emitted only if it holds two runs at least this fraction of the
// region wide whose colours clearly differ. That is exactly the shape of a
// progress-bar row (filled part next to empty track, or bar next to card
// background) and it rejects flat backgrounds, text lines, and artwork.
let MIN_RUN_FRACTION = 0.06
// How far apart two long runs must be, on any one channel, to count as a
// colour boundary rather than compression drift across a gradient.
let RUN_CONTRAST = 18
// Vision is fed a downscaled copy of the frame when the video is wider than
// this. A phone screen recording is ~1200px wide and the text on it stays
// legible well below that, so the full-resolution pass is several times the
// work for identical output. Pixel measurement still uses the full frame --
// only the text recognizer sees the smaller copy, and its boxes come back
// normalized either way.
let OCR_MAX_WIDTH = 720
// Rows this fragmented are photographic content, never flat UI.
let MAX_RUNS_PER_ROW = 120
// Runs shorter than this are anti-aliasing, glyph strokes, and photo noise.
// They are absorbed into whichever neighbouring run they are closer to in
// colour, so the emitted runs still tile the region with no gaps -- that
// gapless coverage is what lets the JS side measure a bar by simple ratio.
let MIN_EMIT_RUN = 4
// Two long runs only read as a bar boundary if they are adjacent -- at most
// this many pixels of anything in between.
let MAX_BOUNDARY_GAP = 6

// ------------------------------------------------------------ decoding --

let url = URL(fileURLWithPath: videoPath)
let asset = AVURLAsset(url: url)
guard let track = asset.tracks(withMediaType: .video).first else {
  FileHandle.standardError.write("no video track\n".data(using: .utf8)!)
  exit(3)
}

let transform = track.preferredTransform
let natural = track.naturalSize
let rotated = natural.applying(transform)
let outW = Int(abs(rotated.width).rounded())
let outH = Int(abs(rotated.height).rounded())

let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(
  track: track,
  outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
)
output.alwaysCopiesSampleData = false
reader.add(output)
reader.startReading()

let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let colorSpace = CGColorSpaceCreateDeviceRGB()

// Region in absolute pixels, clamped to the frame.
let x0 = max(0, min(outW - 1, Int(rx * Double(outW))))
let y0 = max(0, min(outH - 1, Int(ry * Double(outH))))
let x1 = max(x0 + 1, min(outW, Int((rx + rw) * Double(outW))))
let y1 = max(y0 + 1, min(outH, Int((ry + rh) * Double(outH))))
let regionW = x1 - x0
let minRunLen = max(4, Int(MIN_RUN_FRACTION * Double(regionW)))

// Strip region, same clamping.
let sx0 = strip.map { max(0, min(outW - 1, Int($0.0 * Double(outW)))) } ?? 0
let sy0 = strip.map { max(0, min(outH - 1, Int($0.1 * Double(outH)))) } ?? 0
let sx1 = strip.map { max(sx0 + 1, min(outW, Int(($0.0 + $0.2) * Double(outW)))) } ?? 0
let sy1 = strip.map { max(sy0 + 1, min(outH, Int(($0.1 + $0.3) * Double(outH)))) } ?? 0

/// Boxes in pixels, clamped the same way, resolved once rather than per frame.
let boxes: [(Int, Int, Int, Int)] = boxArgs.map { b in
  let bx0 = max(0, min(outW - 1, Int(b.0 * Double(outW))))
  let by0 = max(0, min(outH - 1, Int(b.1 * Double(outH))))
  return (bx0, by0,
          max(bx0 + 1, min(outW, Int((b.0 + b.2) * Double(outW)))),
          max(by0 + 1, min(outH, Int((b.1 + b.3) * Double(outH)))))
}

var buf = [UInt8](repeating: 0, count: outW * outH * 4)

func jsonString(_ s: String) -> String {
  var out = "\""
  for ch in s.unicodeScalars {
    switch ch {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) } else { out.unicodeScalars.append(ch) }
    }
  }
  return out + "\""
}

func fmt(_ d: Double) -> String { String(format: "%.4f", d) }

/// Collapse sub-MIN_EMIT_RUN runs into the neighbouring run they most
/// resemble, then coalesce touching same-owner runs. Output tiles the same
/// x span as the input with no holes.
func absorbShortRuns(_ runs: [(Int, Int, Int, Int, Int)]) -> [(Int, Int, Int, Int, Int)] {
  guard runs.count > 1 else { return runs }
  let longIdx = runs.indices.filter { runs[$0].1 >= MIN_EMIT_RUN }
  guard !longIdx.isEmpty else { return runs }

  func dist(_ a: (Int, Int, Int, Int, Int), _ b: (Int, Int, Int, Int, Int)) -> Int {
    abs(a.2 - b.2) + abs(a.3 - b.3) + abs(a.4 - b.4)
  }

  // owner[i] = index of the long run each run's pixels are credited to.
  var owner = [Int](repeating: 0, count: runs.count)
  var prevLong: Int? = nil
  var nextLongFor = [Int?](repeating: nil, count: runs.count)
  var seen: Int? = nil
  for i in runs.indices.reversed() {
    nextLongFor[i] = seen
    if runs[i].1 >= MIN_EMIT_RUN { seen = i }
  }
  for i in runs.indices {
    if runs[i].1 >= MIN_EMIT_RUN {
      owner[i] = i
      prevLong = i
      continue
    }
    let nxt = nextLongFor[i]
    switch (prevLong, nxt) {
    case let (p?, n?): owner[i] = dist(runs[i], runs[p]) <= dist(runs[i], runs[n]) ? p : n
    case let (p?, nil): owner[i] = p
    case let (nil, n?): owner[i] = n
    default: owner[i] = i
    }
  }

  var out: [(Int, Int, Int, Int, Int)] = []
  var current: Int? = nil
  for i in runs.indices {
    if current == owner[i], var last = out.popLast() {
      last.1 += runs[i].1
      out.append(last)
    } else {
      let o = runs[owner[i]]
      out.append((runs[i].0, runs[i].1, o.2, o.3, o.4))
      current = owner[i]
    }
  }
  return out
}

/// Run-length encode one row of the region, returning `nil` when the row
/// holds nothing bar-like (see MIN_RUN_FRACTION).
func encodeRow(_ y: Int) -> String? {
  var runs: [(Int, Int, Int, Int, Int)] = []
  var startX = x0
  var (sr, sg, sb) = (0, 0, 0)
  var first = true

  func close(_ endX: Int) {
    let len = endX - startX
    if len <= 0 { return }
    runs.append((startX, len, sr, sg, sb))
  }

  for x in x0..<x1 {
    let o = (y * outW + x) * 4
    // 32BGRA drawn through a DeviceRGB context comes back as R,G,B,A here.
    let r = Int(buf[o]), g = Int(buf[o + 1]), b = Int(buf[o + 2])
    if first {
      (sr, sg, sb) = (r, g, b); startX = x; first = false
      continue
    }
    if abs(r - sr) > COLOR_TOLERANCE || abs(g - sg) > COLOR_TOLERANCE || abs(b - sb) > COLOR_TOLERANCE {
      close(x)
      (sr, sg, sb) = (r, g, b); startX = x
    }
  }
  close(x1)

  // Does this row contain a bar boundary: two wide flat runs of clearly
  // different colour, separated by at most a hairline?
  var boundary = false
  outer: for i in 0..<runs.count where runs[i].1 >= minRunLen {
    var gap = 0
    for j in (i + 1)..<runs.count {
      if runs[j].1 >= minRunLen {
        let a = runs[i], b = runs[j]
        if abs(a.2 - b.2) >= RUN_CONTRAST || abs(a.3 - b.3) >= RUN_CONTRAST || abs(a.4 - b.4) >= RUN_CONTRAST {
          boundary = true
          break outer
        }
        break
      }
      gap += runs[j].1
      if gap > MAX_BOUNDARY_GAP { break }
    }
  }
  if !boundary { return nil }

  let kept = absorbShortRuns(runs)
  if kept.count > MAX_RUNS_PER_ROW { return nil }
  let body = kept.map { "[\($0.0),\($0.1),\($0.2),\($0.3),\($0.4)]" }.joined(separator: ",")
  return "{\"y\":\(y),\"runs\":[\(body)]}"
}

/// Mean colour of every row of the strip region, top to bottom.
func encodeStrip() -> String {
  guard strip != nil else { return "" }
  var out: [String] = []
  out.reserveCapacity(sy1 - sy0)
  let width = sx1 - sx0
  for y in sy0..<sy1 {
    var r = 0, g = 0, b = 0
    for x in sx0..<sx1 {
      let o = (y * outW + x) * 4
      r += Int(buf[o]); g += Int(buf[o + 1]); b += Int(buf[o + 2])
    }
    out.append("[\(r / width),\(g / width),\(b / width)]")
  }
  return out.joined(separator: ",")
}

/// Mean colour of each box, in the order the boxes were given.
func encodeBoxes() -> String {
  boxes.map { box in
    let (bx0, by0, bx1, by1) = box
    var r = 0, g = 0, b = 0
    for y in by0..<by1 {
      for x in bx0..<bx1 {
        let o = (y * outW + x) * 4
        r += Int(buf[o]); g += Int(buf[o + 1]); b += Int(buf[o + 2])
      }
    }
    let n = (bx1 - bx0) * (by1 - by0)
    return "[\(r / n),\(g / n),\(b / n)]"
  }.joined(separator: ",")
}

/// Downscale a frame for the text recognizer, or hand it back as-is when it
/// is already small enough.
func forOCR(_ cg: CGImage) -> CGImage {
  guard cg.width > OCR_MAX_WIDTH else { return cg }
  let scale = Double(OCR_MAX_WIDTH) / Double(cg.width)
  let scaled = CIImage(cgImage: cg).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
  return ciContext.createCGImage(scaled, from: scaled.extent) ?? cg
}

func recognizeText(_ cg: CGImage) -> [String] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  req.recognitionLanguages = ["en-US"]
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  guard (try? handler.perform([req])) != nil else { return [] }
  var out: [String] = []
  for obs in (req.results ?? []) {
    guard let c = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    // Vision: origin bottom-left. Convert to top-left origin.
    let top = 1.0 - (b.minY + b.height)
    out.append(
      "{\"x\":\(fmt(b.minX)),\"y\":\(fmt(top)),\"w\":\(fmt(b.width)),\"h\":\(fmt(b.height))," +
        "\"c\":\(fmt(Double(c.confidence))),\"s\":\(jsonString(c.string))}"
    )
  }
  return out
}

var nextSampleTime = 0.0
var emitted = 0
let stdout = FileHandle.standardOutput

while reader.status == .reading, let sample = output.copyNextSampleBuffer() {
  let ts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
  guard ts + 1e-6 >= nextSampleTime, let pb = CMSampleBufferGetImageBuffer(sample) else { continue }
  nextSampleTime = ts + interval

  var ci = CIImage(cvPixelBuffer: pb)
  if !transform.isIdentity {
    ci = ci.transformed(by: transform)
    ci = ci.transformed(by: CGAffineTransform(translationX: -ci.extent.origin.x, y: -ci.extent.origin.y))
  }
  guard let cg = ciContext.createCGImage(ci, from: CGRect(x: 0, y: 0, width: outW, height: outH)) else { continue }

  buf.withUnsafeMutableBytes { raw in
    guard let ctx = CGContext(
      data: raw.baseAddress, width: outW, height: outH, bitsPerComponent: 8,
      bytesPerRow: outW * 4, space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: outW, height: outH))
  }

  var rows: [String] = []
  for y in y0..<y1 { if let r = encodeRow(y) { rows.append(r) } }

  let line = "{\"t\":\(fmt(ts)),\"w\":\(outW),\"h\":\(outH)," +
    "\"text\":[\(recognizeText(forOCR(cg)).joined(separator: ","))]," +
    "\"rows\":[\(rows.joined(separator: ","))]," +
    "\"strip\":[\(encodeStrip())],"  +
    "\"boxes\":[\(encodeBoxes())]}\n"
  stdout.write(line.data(using: .utf8)!)
  emitted += 1
}

if reader.status == .failed {
  FileHandle.standardError.write("read failed: \(reader.error?.localizedDescription ?? "unknown")\n".data(using: .utf8)!)
  exit(4)
}
if emitted == 0 {
  FileHandle.standardError.write("no frames decoded\n".data(using: .utf8)!)
  exit(5)
}
