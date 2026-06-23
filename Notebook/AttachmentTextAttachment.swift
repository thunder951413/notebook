import AppKit

/// 用于把本地附件路径写入富文本中，便于序列化/反序列化。
/// 主要用于图片（通过 fileWrapper 打包进 RTFD）；音频展示/播放使用 `AudioBlockAttachment`。
final class AttachmentTextAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let attachmentFileURL: URL
    let attachmentFilename: String
    let kind: AttachmentKind
    private let embeddedFileData: Data?

    private static func uniqueTemporaryFileURL(directoryName: String, preferredFilename: String) -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let ext = URL(fileURLWithPath: preferredFilename).pathExtension
        let base = URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent
        let safeBase = base.isEmpty ? "attachment" : base
        let uniqueName = "\(safeBase)-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
        return directory.appendingPathComponent(uniqueName, isDirectory: false)
    }

    init(fileURL: URL, kind: AttachmentKind, embeddedFileData: Data? = nil, attachmentFilename: String? = nil) {
        self.attachmentFileURL = fileURL
        self.attachmentFilename = attachmentFilename ?? (fileURL.lastPathComponent.isEmpty ? Self.defaultFilename(for: kind) : fileURL.lastPathComponent)
        self.kind = kind
        self.embeddedFileData = embeddedFileData ?? (try? Data(contentsOf: fileURL))
        super.init(data: nil, ofType: nil)

        // 运行时不要挂 fileWrapper，避免 NSTextView 把它当成“文件附件”并显示右上角系统菜单
        if kind == .audio {
            self.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        } else if kind == .image {
            applyImagePresentationIfNeeded()
        }
    }

    required init?(coder: NSCoder) {
        DebugLog.attachment("Decoding started...", level: .debug)

        if let raw = coder.decodeObject(of: NSString.self, forKey: "NotebookAttachmentKind") as String? {
            self.kind = AttachmentKind(rawValue: raw) ?? .image
            DebugLog.attachment("Kind decoded: \(self.kind)", level: .debug)
        } else {
            self.kind = .image
            DebugLog.attachment("No kind found, defaulting to image", level: .debug)
        }

        let decodedFilename = coder.decodeObject(of: NSString.self, forKey: "NotebookAttachmentFilename") as String?
        let fallbackFilename = decodedFilename.flatMap { $0.isEmpty ? nil : String($0) } ?? Self.defaultFilename(for: kind)
        
        let decodedWrapper = coder.decodeObject(of: FileWrapper.self, forKey: "NSFileWrapper")
        DebugLog.attachment("Decoded wrapper: \(decodedWrapper != nil)", level: .debug)

        if let wrapper = decodedWrapper {
            let filename = wrapper.preferredFilename?.isEmpty == false ? wrapper.preferredFilename! : fallbackFilename
            self.attachmentFilename = filename
            let out = Self.uniqueTemporaryFileURL(directoryName: "NotebookExtracted", preferredFilename: filename)
            try? wrapper.write(to: out, options: .atomic, originalContentsURL: nil)
            self.attachmentFileURL = out
            self.embeddedFileData = wrapper.regularFileContents
            DebugLog.attachment("File URL set to: \(out.path)", level: .debug)
        } else {
            self.attachmentFilename = fallbackFilename
            self.attachmentFileURL = Self.uniqueTemporaryFileURL(directoryName: "NotebookExtracted", preferredFilename: fallbackFilename)
            self.embeddedFileData = nil
            DebugLog.attachment("No wrapper found, using temp file path", level: .debug)
        }

        super.init(coder: coder)
        DebugLog.attachment("super.init completed", level: .debug)

        // 关键：清掉运行时 fileWrapper，避免被 NSTextView 识别为“文件附件”并出现系统浮层
        self.fileWrapper = nil

        // 解码后保留 attachmentFileURL 供我们自己的图片/音频渲染与播放。
        if kind == .audio {
            self.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        } else if kind == .image {
            applyImagePresentationIfNeeded()
        }
        
        DebugLog.attachment("Decoding completed", level: .debug)
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(kind.rawValue as NSString, forKey: "NotebookAttachmentKind")
        coder.encode(attachmentFilename as NSString, forKey: "NotebookAttachmentFilename")

        if let data = embeddedFileData {
            let wrapper = FileWrapper(regularFileWithContents: data)
            wrapper.preferredFilename = attachmentFilename
            coder.encode(wrapper, forKey: "NSFileWrapper")
        } else if let wrapper = try? FileWrapper(url: attachmentFileURL, options: []) {
            wrapper.preferredFilename = attachmentFilename
            coder.encode(wrapper, forKey: "NSFileWrapper")
        }
    }

    func attachmentData() -> Data? {
        if let data = try? Data(contentsOf: attachmentFileURL) {
            return data
        }
        if let embeddedFileData {
            return embeddedFileData
        }
        if let wrapperData = fileWrapper?.regularFileContents {
            return wrapperData
        }
        return nil
    }

    func refreshPresentationIfNeeded() {
        if kind == .image {
            applyImagePresentationIfNeeded()
        } else if kind == .audio {
            self.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        }
    }

    private func applyImagePresentationIfNeeded() {
        guard let data = attachmentData(),
              let image = NSImage(data: data) else { return }

        // 如果附件已经有有效尺寸（例如用户拖拽缩放后持久化的 bounds），优先保留
        if bounds.width > 1, bounds.height > 1 {
            self.image = image
            return
        }

        let maxWidth: CGFloat = 600
        let maxHeight: CGFloat = 400
        let imageSize = image.size

        var newSize = imageSize
        if imageSize.width > maxWidth || imageSize.height > maxHeight {
            let widthRatio = maxWidth / imageSize.width
            let heightRatio = maxHeight / imageSize.height
            let ratio = min(widthRatio, heightRatio)
            newSize = NSSize(width: imageSize.width * ratio, height: imageSize.height * ratio)
        }

        self.image = image
        self.bounds = NSRect(origin: .zero, size: newSize)
    }

    private static func defaultFilename(for kind: AttachmentKind) -> String {
        switch kind {
        case .image:
            return "attachment.png"
        case .audio:
            return "attachment.m4a"
        }
    }
}
