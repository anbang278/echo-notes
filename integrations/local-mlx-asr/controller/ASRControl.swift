import AppKit
import Foundation

func option(_ name: String, environment: String, fallback: String) -> String {
    if let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[index + 1]
    }
    return ProcessInfo.processInfo.environment[environment] ?? fallback
}
private let root = URL(fileURLWithPath: option("--root", environment: "ECHONOTES_ASR_ROOT", fallback: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/echonotes-asr").path))
private let port = option("--port", environment: "ECHONOTES_ASR_PORT", fallback: "18080")
private let api = "http://127.0.0.1:\(port)/v1"
private let bundleID = "local.anbang.echonotes-asr-control"

struct Health: Decodable {
    let status: String
    let busy: Bool
    let error: String?
    let model: String?
    let last_request: Metrics?
    let diarization: DiarizationHealth?
    let alignment: DiarizationHealth?
    let current_request: RequestHealth?
}
struct DiarizationHealth: Decodable { let status: String; let error: String? }
struct RequestHealth: Decodable { let mode: String; let stage: String }
struct Metrics: Decodable {
    let segments: Int
    let duration_seconds: Double
    let elapsed_seconds: Double
    let mode: String?
    let speakers: Int?
}
struct Snapshot: Decodable {
    let pid: Int?
    let health: Health?
}
struct CommandResult {
    let output: String
    let code: Int32
}

// Run only this installation's fixed scripts. Never accept arbitrary shell text.
func runControl(_ action: String) -> CommandResult {
    guard ["start", "stop", "status"].contains(action) else {
        return CommandResult(output: "未知操作", code: 2)
    }
    let process = Process()
    process.executableURL = root.appendingPathComponent("\(action).sh")
    process.currentDirectoryURL = root
    process.arguments = ["--root", root.path, "--port", port]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return CommandResult(output: String(data: data, encoding: .utf8) ?? "无法读取服务状态", code: process.terminationStatus)
    } catch {
        return CommandResult(output: "无法运行 \(action).sh：\(error.localizedDescription)", code: 2)
    }
}

func decodeSnapshot(_ result: CommandResult) -> Snapshot? {
    guard result.code == 0 || result.code == 1,
          let data = result.output.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snapshot.self, from: data)
}

enum ServicePhase: String {
    case stopped = "已停止", loading = "正在加载模型", ready = "已就绪"
    case busy = "正在转写", stopping = "正在停止", error = "需要处理"

    static func resolve(_ snapshot: Snapshot, stopping: Bool) -> ServicePhase {
        guard snapshot.pid != nil else { return .stopped }
        if stopping { return .stopping }
        guard let health = snapshot.health else { return .error }
        if health.status == "loading" { return .loading }
        if health.status != "ready" { return .error }
        return health.busy ? .busy : .ready
    }

    var color: NSColor {
        switch self {
        case .ready: return .systemGreen
        case .loading, .busy, .stopping: return .systemOrange
        case .error: return .systemRed
        case .stopped: return .secondaryLabelColor
        }
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var startMenu: NSMenuItem!
    private var stopMenu: NSMenuItem!
    private var menuState: NSMenuItem!
    private var timer: Timer?
    private var snapshot: Snapshot?
    private var phase: ServicePhase = .stopped
    private var operation: String?
    private var checking = false
    private var stopPending = false
    private var failure: String?
    private var notification: String?
    private let queue = DispatchQueue(label: "local.asr.controller", qos: .utility)
    private let stateLabel = NSTextField(labelWithString: "读取状态…")
    private let detail = NSTextField(wrappingLabelWithString: "正在检查本地服务。")
    private let metrics = NSTextField(wrappingLabelWithString: "")
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let updated = NSTextField(labelWithString: "")
    private let startButton = NSButton(title: "启动服务", target: nil, action: nil)
    private let stopButton = NSButton(title: "停止服务", target: nil, action: nil)
    private let progress = NSProgressIndicator()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if port == "18080", let other = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            other.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        makeMenus()
        makeWindow()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        showWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Keep a startup/stop operation supervised until the script completes.
        if operation != nil {
            showWindow()
            notification = "启停操作尚未结束，请等待状态更新后退出。"
            render()
            return .terminateCancel
        }
        return .terminateNow
    }

    private func makeMenus() {
        let main = NSMenu()
        let appMenu = NSMenu()
        let rootItem = NSMenuItem()
        rootItem.submenu = appMenu
        main.addItem(rootItem)
        appMenu.addItem(item("显示控制台", #selector(showWindow), "1"))
        appMenu.addItem(.separator())
        appMenu.addItem(item("退出控制台（服务保持当前状态）", #selector(quit), "q"))
        NSApp.mainMenu = main

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "本地 ASR")
        statusItem.button?.title = " ASR"
        let menu = NSMenu()
        menu.autoenablesItems = false
        menuState = NSMenuItem(title: "读取状态…", action: nil, keyEquivalent: "")
        menuState.isEnabled = false
        menu.addItem(menuState)
        menu.addItem(item("显示控制台", #selector(showWindow)))
        menu.addItem(.separator())
        startMenu = item("启动服务", #selector(start))
        stopMenu = item("停止服务", #selector(stop))
        menu.addItem(startMenu)
        menu.addItem(stopMenu)
        menu.addItem(.separator())
        menu.addItem(item("复制 API 地址", #selector(copyAPI)))
        menu.addItem(item("查看日志", #selector(openLogs)))
        menu.addItem(item("使用说明", #selector(openGuide)))
        menu.addItem(.separator())
        menu.addItem(item("退出控制台（服务保持当前状态）", #selector(quit)))
        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.target = self
        return result
    }

    private func label(_ value: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> NSTextField {
        let result = NSTextField(wrappingLabelWithString: value)
        result.font = .systemFont(ofSize: size, weight: weight)
        return result
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let result = NSButton(title: title, target: self, action: action)
        result.bezelStyle = .rounded
        return result
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let result = NSStackView(views: views)
        result.orientation = .horizontal
        result.spacing = 10
        result.alignment = .centerY
        return result
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 550),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "MLX ASR 控制台"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 15
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 25)
        ])
        stack.addArrangedSubview(label("本地转写，随用随开", size: 23, weight: .semibold))
        let subtitle = label("mlx-audio · Qwen3-ASR + Sortformer · Echo Notes")
        subtitle.textColor = .secondaryLabelColor
        stack.addArrangedSubview(subtitle)
        stateLabel.font = .systemFont(ofSize: 23, weight: .semibold)
        progress.style = .spinning
        progress.controlSize = .small
        progress.isDisplayedWhenStopped = false
        stack.addArrangedSubview(row([stateLabel, progress]))
        detail.font = .systemFont(ofSize: 13)
        detail.heightAnchor.constraint(equalToConstant: 42).isActive = true
        stack.addArrangedSubview(detail)
        for (control, action) in [(startButton, #selector(start)), (stopButton, #selector(stop))] {
            control.bezelStyle = .rounded
            control.controlSize = .large
            control.target = self
            control.action = action
        }
        startButton.keyEquivalent = "\r"
        stack.addArrangedSubview(row([startButton, stopButton, button("刷新", #selector(refresh))]))
        let address = label(api, size: 13, weight: .medium)
        address.isSelectable = true
        stack.addArrangedSubview(row([address, button("复制地址", #selector(copyAPI)), button("复制分离模型", #selector(copyDiarModel))]))
        metrics.textColor = .secondaryLabelColor
        metrics.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(metrics)
        stack.addArrangedSubview(row([button("查看日志", #selector(openLogs)), button("使用说明", #selector(openGuide)),
                                     button("说话人分离说明", #selector(openPlan))]))
        notice.font = .systemFont(ofSize: 12)
        notice.heightAnchor.constraint(equalToConstant: 48).isActive = true
        stack.addArrangedSubview(notice)
        let footer = label("仅本机访问 · 手动启停\n关闭窗口后可从菜单栏 ASR 重新打开；退出控制台不会停止服务。", size: 11)
        footer.textColor = .secondaryLabelColor
        stack.addArrangedSubview(footer)
        updated.font = .systemFont(ofSize: 10)
        updated.textColor = .tertiaryLabelColor
        stack.addArrangedSubview(updated)
        for view in [detail, metrics, notice, footer] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    @objc func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refresh()
    }

    @objc func refresh() {
        guard !checking, operation == nil else { return }
        checking = true
        queue.async { [weak self] in
            let result = runControl("status")
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checking = false
                if let next = decodeSnapshot(result) {
                    self.snapshot = next
                    if next.pid == nil {
                        if self.stopPending { self.notification = "服务已停止，模型内存已释放。" }
                        self.stopPending = false
                    }
                    let nextPhase = ServicePhase.resolve(next, stopping: self.stopPending)
                    if nextPhase == .busy && self.phase != .busy { self.notification = nil }
                    if nextPhase == .ready && self.phase == .error { self.failure = nil }
                    self.phase = nextPhase
                } else {
                    self.phase = .error
                    self.failure = "读取状态失败：\(result.output.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160))"
                }
                self.updated.stringValue = "更新于 " + DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
                self.render()
            }
        }
    }

    @objc func start() { perform("start") }
    @objc func stop() { perform("stop") }

    private func perform(_ action: String) {
        guard operation == nil else { return }
        operation = action
        failure = nil
        notification = nil
        if action == "stop" { stopPending = true }
        render()
        queue.async { [weak self] in
            let result = runControl(action)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.operation = nil
                if result.code != 0 {
                    if action == "stop" && result.output.contains("still finishing") {
                        self.notification = "已发出停止请求，正在等待当前录音处理结束。"
                    } else {
                        self.stopPending = false
                        self.failure = Self.describeFailure(result.output)
                    }
                } else {
                    self.notification = action == "start" ? "模型已就绪，可以在 Echo Notes 中转写。" : "服务已停止，模型内存已释放。"
                }
                self.refresh()
                self.render()
            }
        }
    }

    static func describeFailure(_ output: String) -> String {
        if output.contains("Port \(port) is occupied") { return "\(port) 端口被其他进程占用，启动失败。未结束其他进程。" }
        if output.contains("Model loading failed") { return "模型加载失败，请查看日志核对固定缓存。" }
        if output.contains("exceeded 120") { return "模型启动超过 120 秒，已停止此次启动，请查看日志。" }
        if output.contains("Service startup failed") { return "服务启动失败，请查看日志。" }
        return String(output.trimmingCharacters(in: .whitespacesAndNewlines).prefix(220))
    }

    private func render() {
        let visible: ServicePhase = operation == "start" ? .loading : operation == "stop" ? .stopping : phase
        stateLabel.stringValue = visible.rawValue
        stateLabel.textColor = visible.color
        menuState.title = "本地 ASR：\(visible.rawValue)"
        statusItem.button?.toolTip = "MLX ASR 控制台 · \(visible.rawValue)"
        let working = operation != nil || visible == .loading || visible == .stopping
        if working { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        let known = snapshot != nil
        startButton.isEnabled = known && operation == nil && snapshot?.pid == nil
        stopButton.isEnabled = known && operation == nil && snapshot?.pid != nil && !stopPending
        startMenu.isEnabled = startButton.isEnabled
        stopMenu.isEnabled = stopButton.isEnabled
        switch visible {
        case .stopped: detail.stringValue = "点击「启动服务」加载模型。未运行时不占用模型内存。"
        case .ready: detail.stringValue = "Echo Notes 可以连接本机接口。支持长录音；单个文件最多 1GiB、8 小时。"
        case .busy: detail.stringValue = "正在处理录音。点击停止会取消当前任务，并在当前计算结束后释放模型。"
        case .loading: detail.stringValue = "正在校验缓存并加载模型，完成后才可转写。最长等待 120 秒。"
        case .stopping: detail.stringValue = "正在等待服务退出。当前计算结束后会取消任务并释放内存。"
        case .error: detail.stringValue = "\(snapshot?.health?.error ?? "服务进程或接口状态异常")。请查看日志；进程仍在时可停止后重试。"
        }
        if visible == .busy, let request = snapshot?.health?.current_request {
            let stage = ["decode":"解码音频", "load_diarization":"加载分离模型", "diarization":"标注说话人", "transcribe":"转写文字", "load_alignment":"加载时间对齐模型", "alignment":"对齐文字与说话人", "uploading":"接收音频", "decoding":"解码音频", "diarizing":"标注说话人", "transcribing":"转写文字", "aligning":"对齐文字与说话人", "canceling":"取消任务"][request.stage] ?? "处理录音"
            detail.stringValue = "\(request.mode == "diarized" ? "说话人分离" : "普通转写")：\(stage)。停止会取消当前任务。"
        }
        let diarStatus = snapshot?.health?.diarization?.status ?? "not_loaded"
        let diarLabel = ["not_loaded":"首次分离请求时加载", "loading":"正在加载", "ready":"已就绪", "error":"加载失败，普通转写仍可用"][diarStatus] ?? "状态未知"
        if let last = snapshot?.health?.last_request {
            metrics.stringValue = String(format: "最近\(last.mode == "diarized" ? "分离转写" : "普通转写")：%.1f 秒音频 · 耗时 %.1f 秒 · %d 段", last.duration_seconds, last.elapsed_seconds, last.segments)
        } else {
            metrics.stringValue = "可用模式：普通转写 / 说话人分离（最多 4 人，匿名编号）"
        }
        metrics.stringValue += "\n说话人模型：\(diarLabel)"
        let alignStatus = snapshot?.health?.alignment?.status ?? "not_loaded"
        let alignLabel = ["not_loaded":"首次分离请求时加载", "loading":"正在加载", "ready":"已就绪", "error":"加载失败，普通转写仍可用"][alignStatus] ?? "状态未知"
        metrics.stringValue += " · 时间对齐：\(alignLabel)"
        notice.textColor = failure == nil ? .secondaryLabelColor : .systemRed
        notice.stringValue = failure ?? notification ?? "打开控制台不会自动启动模型。AI 分析仍按 Echo Notes 原有配置运行。"
    }

    @objc func copyAPI() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(api, forType: .string)
        notification = "已复制 API 地址。"
        render()
    }
    @objc func copyDiarModel() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("local/qwen3-asr-0.6b-sortformer-4spk", forType: .string)
        notification = "已复制分离模型 ID。粘贴到 Echo Notes 的离线转写模型设置即可使用。"
        render()
    }
    @objc func openLogs() { NSWorkspace.shared.open(root.appendingPathComponent("logs/service.log")) }
    @objc func openGuide() { NSWorkspace.shared.open(root.appendingPathComponent("README.md")) }
    @objc func openPlan() { NSWorkspace.shared.open(root.appendingPathComponent("README.md")) }
    @objc func quit() { NSApp.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    func expect(_ condition: Bool, _ name: String) {
        guard condition else { fputs("FAIL: \(name)\n", stderr); exit(1) }
        print("PASS: \(name)")
    }
    let stopped = decodeSnapshot(CommandResult(output: "{\"pid\":null,\"health\":null}", code: 1))
    expect(stopped != nil && ServicePhase.resolve(stopped!, stopping: false) == .stopped, "status exit 1 means stopped")
    let busy = Snapshot(pid: 123, health: Health(status: "ready", busy: true, error: nil, model: nil, last_request: nil, diarization: nil, alignment: nil, current_request: nil))
    expect(ServicePhase.resolve(busy, stopping: false) == .busy, "busy does not become ready")
    expect(ServicePhase.resolve(busy, stopping: true) == .stopping, "pending stop remains visible")
    expect(ServicePhase.resolve(Snapshot(pid: 123, health: nil), stopping: false) == .error, "unreachable process is not stopped")
    expect(decodeSnapshot(CommandResult(output: "bad", code: 1)) == nil, "invalid status is not success")
    expect(Controller.describeFailure("Port \(port) is occupied").contains("启动失败"), "occupied port is explicit failure")
    exit(0)
}

let application = NSApplication.shared
let delegate = Controller()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
