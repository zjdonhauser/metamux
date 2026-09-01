// metamux-opener: a minimal default-browser shim. Registers as an
// http/https URL handler (CFBundleURLTypes in the generated Info.plist --
// see scripts/install-opener.sh, which compiles and bundles this file).
//
// Routing decision (docs/protocol.md, "Link routing"):
//   1. Capture the frontmost app's bundle id FAST, before this process
//      itself steals focus by handling the URL event.
//   2. Frontmost == com.cmuxterm.app -> POST http://127.0.0.1:<port>/open
//      {token, url}, 1s timeout.
//   3. Daemon down / non-2xx / any other frontmost app -> passthrough:
//      open the URL with Google Chrome EXPLICITLY, never via the OS
//      default handler (that's ourselves -- an infinite loop).
//
// Step 3 carries the weight it did not used to. This process has no tmux
// session, so under the identity model it cannot name a workspace, and
// /open answers 404 rather than guessing at the active one. An OS-level
// link therefore lands in plain unmanaged Chrome, which is what "no tmux
// session, no linkage" means for a caller with no terminal to fail into.
//   4. Never shows UI, never a Dock icon (LSUIElement in Info.plist).
//
// No test rig for Swift in this repo -- the routing decision stays here,
// documented above and in protocol.md, rather than duplicated as an
// untested TS mirror with no real connection to this file. Verify instead
// with `--test cmux <url>` / `--test passthrough <url>`, which force each
// branch directly (frontmost-app detection can't be controlled reliably
// from a test harness).

import Cocoa
import Foundation

let BUNDLE_ID = "com.metamux.opener"
let CMUX_BUNDLE_ID = "com.cmuxterm.app"
let DEFAULT_PORT = 8377
let REQUEST_TIMEOUT_SECONDS = 1.0
let CHROME_APP_PATH = "/Applications/Google Chrome.app"

func logLine(_ msg: String) {
  let stamped = "[metamux-opener] \(msg)\n"
  FileHandle.standardError.write(stamped.data(using: .utf8)!)
}

/// Reads `port` from ~/.config/metamux/config.json, honoring the port
/// override the same way the daemon itself does -- falls back to
/// DEFAULT_PORT if the file is missing, malformed, or has no `port` key.
func metamuxPort() -> Int {
  let path = (NSHomeDirectory() as NSString).appendingPathComponent(".config/metamux/config.json")
  guard let data = FileManager.default.contents(atPath: path),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let port = json["port"] as? Int
  else {
    return DEFAULT_PORT
  }
  return port
}

/// Reads the daemon's auth secret fresh every time (docs/protocol.md,
/// "Paths") -- never cached, so a daemon restart's fresh secret is always
/// picked up. nil if the daemon has never started (no secret file yet).
func metamuxSecret() -> String? {
  let path = (NSHomeDirectory() as NSString).appendingPathComponent(".local/state/metamux/secret")
  guard let data = FileManager.default.contents(atPath: path) else { return nil }
  return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Opens `url` in Chrome explicitly (never the OS default handler --
/// that's this app itself, which would loop forever). Always calls
/// `completion` exactly once, on the main queue.
func passthroughOpen(_ url: URL, completion: @escaping () -> Void) {
  let chromeURL = URL(fileURLWithPath: CHROME_APP_PATH)
  let config = NSWorkspace.OpenConfiguration()
  config.activates = true
  NSWorkspace.shared.open([url], withApplicationAt: chromeURL, configuration: config) { _, err in
    if let err = err {
      logLine("passthrough to Chrome failed: \(err.localizedDescription)")
    } else {
      logLine("passthrough -> Chrome: \(url.absoluteString)")
    }
    DispatchQueue.main.async { completion() }
  }
}

/// POSTs to the daemon's /open endpoint; falls back to passthroughOpen on
/// any failure (no secret file, request error, non-2xx). Always calls
/// `completion` exactly once, on the main queue.
func routeToMetamux(_ url: URL, completion: @escaping () -> Void) {
  guard let secret = metamuxSecret() else {
    logLine("no secret file -- daemon likely not running, passthrough")
    passthroughOpen(url, completion: completion)
    return
  }
  guard let daemonURL = URL(string: "http://127.0.0.1:\(metamuxPort())/open") else {
    passthroughOpen(url, completion: completion)
    return
  }

  var request = URLRequest(url: daemonURL)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "content-type")
  request.timeoutInterval = REQUEST_TIMEOUT_SECONDS
  let body: [String: Any] = ["token": secret, "url": url.absoluteString]
  request.httpBody = try? JSONSerialization.data(withJSONObject: body)

  let task = URLSession.shared.dataTask(with: request) { _, response, error in
    if error == nil, let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
      logLine("routed to metamux: \(url.absoluteString)")
      DispatchQueue.main.async { completion() }
      return
    }
    let reason = error?.localizedDescription ?? "HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)"
    logLine("daemon POST /open failed (\(reason)), passthrough")
    passthroughOpen(url, completion: completion)
  }
  task.resume()
}

/// The frontmost app at THIS instant -- must be captured before anything
/// else (activating ourselves, spinning the run loop past the URL event)
/// has a chance to change it. NSWorkspace.frontmostApplication reflects
/// whichever app the user was actually looking at when they clicked the
/// link, as long as this is called immediately on launch.
func frontmostBundleIdentifier() -> String? {
  return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
}

/// Routes a URL per the decision table above, using an already-captured
/// frontmost bundle id (real launches capture it at applicationDidFinish-
/// Launching; --test forces it directly, since a test harness can't
/// control real frontmost-app state).
func route(_ url: URL, frontmost: String?, completion: @escaping () -> Void) {
  logLine("url=\(url.absoluteString) frontmost=\(frontmost ?? "unknown")")
  if frontmost == CMUX_BUNDLE_ID {
    routeToMetamux(url, completion: completion)
  } else {
    passthroughOpen(url, completion: completion)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  var capturedFrontmost: String?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Capture immediately -- before Apple Event dispatch, before this app
    // has a chance to become frontmost itself.
    capturedFrontmost = frontmostBundleIdentifier()
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )
  }

  @objc func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
    guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
      let url = URL(string: urlString)
    else {
      exit(1)
    }
    route(url, frontmost: capturedFrontmost) {
      exit(0)
    }
  }
}

/// Registers metamux-opener as the default handler for http/https.
/// LSSetDefaultHandlerForURLScheme triggers macOS's own confirmation
/// dialog when this app isn't already the default -- a real user click is
/// required there, this only requests the change (see scripts/
/// install-opener.sh and the README's "Link routing" section for exactly
/// what that dialog looks like and where to go if it never appears).
func registerAsDefaultBrowser() {
  for scheme in ["http", "https"] {
    let status = LSSetDefaultHandlerForURLScheme(scheme as CFString, BUNDLE_ID as CFString)
    if status == noErr {
      print("Requested default handler for \(scheme):// -> \(BUNDLE_ID)")
    } else {
      print("LSSetDefaultHandlerForURLScheme(\(scheme)) returned OSStatus \(status)")
    }
  }
  print("")
  print("If macOS didn't show a confirmation dialog, set it manually:")
  print("  System Settings > Desktop & Dock > Default web browser > metamux-opener")
}

// --- Entry point: CLI-style flags bypass the NSApplication run loop
// entirely (this binary is invoked directly for these, not via a URL
// event); a real URL-open launch (no argv) runs the normal app delegate
// loop above.

let args = CommandLine.arguments

if args.contains("--register") {
  registerAsDefaultBrowser()
  exit(0)
}

if let testIndex = args.firstIndex(of: "--test") {
  guard args.count > testIndex + 2,
    let forcedFrontmost = args[testIndex + 1] == "cmux" ? CMUX_BUNDLE_ID : (args[testIndex + 1] == "passthrough" ? "com.example.other" : nil),
    let testURL = URL(string: args[testIndex + 2])
  else {
    print("usage: metamux-opener --test <cmux|passthrough> <url>")
    exit(1)
  }
  let semaphore = DispatchSemaphore(value: 0)
  route(testURL, frontmost: forcedFrontmost) {
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + REQUEST_TIMEOUT_SECONDS + 2.0)
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited) // no Dock icon, no menu bar, belt-and-suspenders with LSUIElement
app.run()
