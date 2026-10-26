import AppKit
import Foundation

// This process observes only its own controls. Real input comes from the operator.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class ProbeTarget: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
    private var window: NSWindow!
    private var field: NSTextField!
    private var button: NSButton!
    private var clicks = 0
    private var edits = 0
    private var timer: Timer?
    private let report: URL
    private let origin: NSPoint
    private let size: NSSize

    init(arguments: [String]) {
        report = URL(fileURLWithPath: arguments[1])
        origin = NSPoint(x: Double(arguments[2])!, y: Double(arguments[3])!)
        size = NSSize(width: Double(arguments[4])!, height: Double(arguments[5])!)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let top = NSScreen.screens.first!.frame.maxY
        window = NSWindow(contentRect: NSRect(x: origin.x, y: top - origin.y - size.height, width: size.width, height: size.height),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Faangin Overlay QA Target"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = FlippedView(frame: NSRect(origin: .zero, size: size))
        window.contentView = content
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedRed: 0.91, green: 0.96, blue: 1, alpha: 1).cgColor
        let title = NSTextField(labelWithString: "Native input target · disposable QA")
        title.font = .boldSystemFont(ofSize: 23)
        title.frame = NSRect(x: 40, y: 32, width: 600, height: 36)
        content.addSubview(title)
        let instructions = NSTextField(wrappingLabelWithString: "A separate process receives the real clicks and typing below. The overlay should remain visible while passive. Use public test text only.")
        instructions.font = .systemFont(ofSize: 15)
        instructions.frame = NSRect(x: 40, y: 78, width: 600, height: 58)
        content.addSubview(instructions)
        button = NSButton(title: "Click target · count 0", target: self, action: #selector(clicked))
        button.bezelStyle = .rounded
        button.font = .boldSystemFont(ofSize: 18)
        button.frame = NSRect(x: 56, y: 150, width: 270, height: 56)
        content.addSubview(button)
        let label = NSTextField(labelWithString: "Public test text:")
        label.font = .systemFont(ofSize: 15)
        label.frame = NSRect(x: 56, y: 225, width: 250, height: 25)
        content.addSubview(label)
        field = NSTextField(frame: NSRect(x: 56, y: 260, width: 560, height: 44))
        field.font = .systemFont(ofSize: 21)
        field.placeholderString = "Type overlay-qa-public here"
        field.delegate = self
        content.addSubview(field)
        let note = NSTextField(wrappingLabelWithString: "Only this window’s focus, click count and public text are written to the QA report. No microphone, capture, provider or network access.")
        note.font = .systemFont(ofSize: 13)
        note.frame = NSRect(x: 40, y: 345, width: 600, height: 55)
        content.addSubview(note)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.save() }
        save()
    }

    @objc private func clicked() {
        clicks += 1
        button.title = "Click target · count \(clicks)"
        save()
    }

    func controlTextDidChange(_ notification: Notification) { edits += 1; save() }
    func windowDidBecomeKey(_ notification: Notification) { save() }
    func windowDidResignKey(_ notification: Notification) { save() }
    func applicationDidBecomeActive(_ notification: Notification) { save() }
    func applicationDidResignActive(_ notification: Notification) { save() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); save(terminated: true) }

    private func rectangle(_ frame: NSRect) -> [String: Double] {
        let top = NSScreen.screens.first!.frame.maxY
        return ["x": frame.minX, "y": top - frame.maxY, "width": frame.width, "height": frame.height]
    }

    private func controlBounds(_ view: NSView) -> [String: Double] {
        rectangle(window.convertToScreen(view.convert(view.bounds, to: nil)))
    }

    private func save(terminated: Bool = false) {
        guard window != nil, field != nil, button != nil else { return }
        let bounds = window.convertToScreen(window.contentView!.bounds)
        let values: [String: Any] = [
            "schema": 1, "pid": ProcessInfo.processInfo.processIdentifier,
            "appActive": NSApp.isActive, "windowKey": window.isKeyWindow,
            "windowMain": window.isMainWindow, "fieldFocused": field.currentEditor() != nil,
            "clickCount": clicks, "textEditCount": edits, "publicText": field.stringValue,
            "contentBounds": rectangle(bounds), "buttonBounds": controlBounds(button),
            "inputBounds": controlBounds(field), "terminated": terminated
        ]
        if let data = try? JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: report, options: .atomic)
        }
    }
}

guard CommandLine.arguments.count == 6 else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeTarget(arguments: CommandLine.arguments)
app.delegate = delegate
app.run()
