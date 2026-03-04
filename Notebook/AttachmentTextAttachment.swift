import AppKit

/// 用于把本地附件路径写入富文本中，便于序列化/反序列化。
/// 主要用于图片（通过 fileWrapper 打包进 RTFD）；音频展示/播放使用 `AudioBlockAttachment`。
final class AttachmentTextAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let attachmentFileURL: URL
    let kind: AttachmentKind

    init(fileURL: URL, kind: AttachmentKind) {
        self.attachmentFileURL = fileURL
        self.kind = kind
        super.init(data: nil, ofType: nil)

        if let wrapper = try? FileWrapper(url: fileURL, options: []) {
            self.fileWrapper = wrapper
        }

        if kind == .audio {
            self.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        } else if kind == .image {
            // 加载图片并设置合适的尺寸
            if let image = NSImage(contentsOf: fileURL) {
                // 限制图片显示的最大尺寸
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
        }
    }

    required init?(coder: NSCoder) {
        print("[AttachmentTextAttachment] Decoding started...")
        
        // 仅解码我们明确支持的类型，避免使用过宽的 allowedClasses
        let decodedWrapper = coder.decodeObject(of: FileWrapper.self, forKey: "NSFileWrapper")
        print("[AttachmentTextAttachment] Decoded wrapper: \(decodedWrapper != nil)")

        if let wrapper = decodedWrapper, let filename = wrapper.preferredFilename {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("NotebookExtracted", isDirectory: true)
            try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let out = tmp.appendingPathComponent(filename)
            try? wrapper.write(to: out, options: .atomic, originalContentsURL: nil)
            self.attachmentFileURL = out
            print("[AttachmentTextAttachment] File URL set to: \(out.path)")
        } else {
            self.attachmentFileURL = FileManager.default.temporaryDirectory
            print("[AttachmentTextAttachment] No wrapper or filename, using temp directory")
        }

        if let raw = coder.decodeObject(of: NSString.self, forKey: "NotebookAttachmentKind") as String? {
            self.kind = AttachmentKind(rawValue: raw) ?? .image
            print("[AttachmentTextAttachment] Kind decoded: \(self.kind)")
        } else {
            self.kind = .image
            print("[AttachmentTextAttachment] No kind found, defaulting to image")
        }

        super.init(coder: coder)
        print("[AttachmentTextAttachment] super.init completed")

        // super.init 之后再赋值 fileWrapper，避免 "self used before super.init"
        if let wrapper = decodedWrapper {
            self.fileWrapper = wrapper
        }

        if kind == .audio {
            self.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        }
        
        print("[AttachmentTextAttachment] Decoding completed")
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(kind.rawValue as NSString, forKey: "NotebookAttachmentKind")
        if let wrapper = fileWrapper {
            coder.encode(wrapper, forKey: "NSFileWrapper")
        }
    }
}
