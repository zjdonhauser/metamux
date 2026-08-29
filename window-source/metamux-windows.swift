// Tier 1 window source: reports which windows are on the active Space, their
// CGWindowIDs, bounds, and display, so the daemon can pair cmux with Chrome.
//
// Deliberately permission-free. CGWindowListCopyWindowInfo needs no TCC grant
// for window id, owner, or bounds; only kCGWindowName is gated behind Screen
// Recording, and the geometry join never uses titles. That matters because a
// per-version TCC grant lapsing on auto-update is exactly what broke this
// machine on 2026-08-28: a source that cannot lose its permission cannot go
// dark silently.
//
// .optionOnScreenOnly is implicitly a Space filter: windows on other Spaces are
// simply absent. Measured 2 on-Space against 4 total.
//
// Usage: metamux-windows --once      print one snapshot as JSON
//        metamux-windows --watch N   print a snapshot every N seconds

import CoreGraphics
import AppKit
import Foundation

struct Snapshot: Codable {
    struct Win: Codable {
        let id: Int
        let owner: String
        let x: Double, y: Double, w: Double, h: Double
    }
    struct Disp: Codable {
        let id: Int
        let x: Double, y: Double, w: Double, h: Double
    }
    let windows: [Win]
    let displays: [Disp]
}

/// CG's origin is the PRIMARY screen's top-left with y growing down; NSScreen is
/// bottom-left with y growing up. Flipping against the union's max Y instead of
/// the primary's makes a full-height window match two displays, and a secondary
/// display placed ABOVE the primary is what exposes it. This machine has one.
func displaysInCGSpace() -> [Snapshot.Disp] {
    guard let primary = NSScreen.screens.first else { return [] }
    let flipY = primary.frame.maxY
    return NSScreen.screens.enumerated().map { (i, s) in
        Snapshot.Disp(id: i, x: s.frame.origin.x, y: flipY - s.frame.maxY,
                      w: s.frame.width, h: s.frame.height)
    }
}

/// Drop toolbars, dividers, and tab strips. Relative to display area rather than
/// a fixed pixel size, so a tiled half on a small display is still kept while a
/// 12px tile divider on a large one is not.
func isRealWindow(_ r: CGRect, displays: [Snapshot.Disp]) -> Bool {
    guard r.width > 200, r.height > 200 else { return false }
    let area = r.width * r.height
    let smallest = displays.map { $0.w * $0.h }.min() ?? (1512 * 982)
    return area > smallest * 0.05
}

func snapshot() -> Snapshot {
    let displays = displaysInCGSpace()
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let raw = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
    var wins: [Snapshot.Win] = []
    for w in raw {
        guard let owner = w[kCGWindowOwnerName as String] as? String,
              let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
        let r = CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0,
                       width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0)
        guard isRealWindow(r, displays: displays) else { continue }
        wins.append(Snapshot.Win(id: id, owner: owner,
                                 x: r.origin.x, y: r.origin.y, w: r.width, h: r.height))
    }
    return Snapshot(windows: wins, displays: displays)
}

func emit() {
    let enc = JSONEncoder()
    guard let data = try? enc.encode(snapshot()), let s = String(data: data, encoding: .utf8) else { return }
    print(s)
    fflush(stdout)
}

let args = CommandLine.arguments
if args.contains("--watch") {
    let idx = args.firstIndex(of: "--watch")!
    let secs = idx + 1 < args.count ? (Double(args[idx + 1]) ?? 1.0) : 1.0
    while true { emit(); Thread.sleep(forTimeInterval: secs) }
} else {
    emit()
}
