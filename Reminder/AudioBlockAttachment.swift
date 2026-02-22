import AppKit
import AVFoundation

/// 音频块附件：显示“[音频] 文件名 + 播放按钮”，点击即可播放/暂停。
final class AudioBlockAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init(data: nil, ofType: nil)
        self.attachmentCell = AudioBlockAttachmentCell(fileURL: fileURL)

        // 尽量把音频文件打包进 RTFD
        if let wrapper = try? FileWrapper(url: fileURL, options: []) {
            self.fileWrapper = wrapper
        }
    }

    required init?(coder: NSCoder) {
        // 仅解码我们明确支持的类型
        let decodedWrapper = coder.decodeObject(of: FileWrapper.self, forKey: "NSFileWrapper")

        if let wrapper = decodedWrapper, let filename = wrapper.preferredFilename {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ReminderExtractedAudio", isDirectory: true)
            try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let out = tmp.appendingPathComponent(filename)
            try? wrapper.write(to: out, options: .atomic, originalContentsURL: nil)
            self.fileURL = out
        } else {
            self.fileURL = FileManager.default.temporaryDirectory
        }

        super.init(coder: coder)

        // super.init 之后再赋值 fileWrapper，避免 "self used before super.init"
        if let wrapper = decodedWrapper {
            self.fileWrapper = wrapper
        }

        self.attachmentCell = AudioBlockAttachmentCell(fileURL: fileURL)
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        if let wrapper = fileWrapper {
            coder.encode(wrapper, forKey: "NSFileWrapper")
        }
    }
}

final class AudioBlockAttachmentCell: NSTextAttachmentCell {
    private let fileURL: URL
    private let filename: String

    // 使用锁保护状态，供 nonisolated 的 draw/cellSize 安全读取
    private let stateLock = NSLock()
    private var _isPlaying: Bool = false

    // player 只在主线程访问（通过 DispatchQueue.main.async/sync）
    private var player: AVAudioPlayer?

    init(fileURL: URL) {
        self.fileURL = fileURL
        self.filename = fileURL.lastPathComponent
        super.init(textCell: "")

        DispatchQueue.main.async { [weak self] in
            self?.loadPlayerOnMain()
        }
    }

    required init(coder: NSCoder) {
        self.fileURL = FileManager.default.temporaryDirectory
        self.filename = "音频"
        super.init(coder: coder)

        DispatchQueue.main.async { [weak self] in
            self?.loadPlayerOnMain()
        }
    }

    private var isPlaying: Bool {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isPlaying
        }
        set {
            stateLock.lock()
            defer { stateLock.unlock() }
            _isPlaying = newValue
        }
    }

    // 显式标记为 nonisolated：确保 override 与父类隔离一致（Swift 6）
    nonisolated override func cellSize() -> NSSize {
        NSSize(width: 260, height: 34)
    }

    // 显式标记为 nonisolated：确保 override 与父类隔离一致（Swift 6）
    nonisolated override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let radius: CGFloat = 8
        let bg = NSColor.white.withAlphaComponent(0.08)
        let stroke = NSColor.white.withAlphaComponent(0.10)

        let path = NSBezierPath(roundedRect: cellFrame.insetBy(dx: 1, dy: 2), xRadius: radius, yRadius: radius)
        bg.setFill()
        path.fill()
        stroke.setStroke()
        path.lineWidth = 1
        path.stroke()

        // play button
        let btnSize: CGFloat = 22
        let btnRect = CGRect(
            x: cellFrame.minX + 10,
            y: cellFrame.midY - btnSize/2,
            width: btnSize,
            height: btnSize
        )

        let btnPath = NSBezierPath(roundedRect: btnRect, xRadius: 6, yRadius: 6)
        NSColor.white.withAlphaComponent(0.10).setFill()
        btnPath.fill()

        let currentPlaying = isPlaying
        let iconName = currentPlaying ? "pause.fill" : "play.fill"
        if let img = NSImage(systemSymbolName: iconName, accessibilityDescription: nil) {
            img.size = NSSize(width: 12, height: 12)
            img.draw(in: btnRect.insetBy(dx: 5, dy: 5))
        }

        // label
        let label = "[音频] " + filename
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.white.withAlphaComponent(0.9)
        ]
        let labelRect = CGRect(
            x: btnRect.maxX + 10,
            y: cellFrame.minY,
            width: cellFrame.width - (btnRect.maxX - cellFrame.minX) - 20,
            height: cellFrame.height
        )
        (label as NSString).draw(in: labelRect, withAttributes: attrs)
    }

    // 显式标记为 nonisolated：确保 override 与父类隔离一致（Swift 6）
    nonisolated override func trackMouse(with event: NSEvent, in cellFrame: NSRect, of controlView: NSView?, untilMouseUp flag: Bool) -> Bool {
        guard let view = controlView else { return false }

        let btnSize: CGFloat = 22
        let btnRect = CGRect(
            x: cellFrame.minX + 10,
            y: cellFrame.midY - btnSize/2,
            width: btnSize,
            height: btnSize
        )

        // 坐标转换只能在主线程上调用
        let point = DispatchQueue.main.sync {
            view.convert(event.locationInWindow, from: nil)
        }

        if btnRect.contains(point) {
            DispatchQueue.main.async { [weak self] in
                self?.togglePlayOnMain()
                view.needsDisplay = true
            }
            return true
        }

        return false
    }

    // 主线程方法（通过 DispatchQueue.main 调用）
    private func loadPlayerOnMain() {
        do {
            player = try AVAudioPlayer(contentsOf: fileURL)
            player?.prepareToPlay()
        } catch {
            player = nil
        }
    }

    // 主线程方法（通过 DispatchQueue.main 调用）
    private func togglePlayOnMain() {
        guard let p = player else { return }
        if p.isPlaying {
            p.pause()
            isPlaying = false
        } else {
            p.play()
            isPlaying = true
        }
    }
}
