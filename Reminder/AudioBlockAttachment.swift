import AppKit

/// 简化的音频块附件：仅作为占位图标和文件名显示，不包含复杂的播放逻辑，以确保主流程稳定性。
final class AudioBlockAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init(data: nil, ofType: nil)
        
        // 设置一个默认图标作为附件的视觉呈现
        if let image = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "音频附件") {
            image.size = NSSize(width: 24, height: 24)
            self.image = image
        }

        // 尽量把音频文件打包进 RTFD
        if let wrapper = try? FileWrapper(url: fileURL, options: []) {
            self.fileWrapper = wrapper
        }
    }

    required init?(coder: NSCoder) {
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

        if let wrapper = decodedWrapper {
            self.fileWrapper = wrapper
        }
        
        if let image = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "音频附件") {
            image.size = NSSize(width: 24, height: 24)
            self.image = image
        }
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        if let wrapper = fileWrapper {
            coder.encode(wrapper, forKey: "NSFileWrapper")
        }
    }
}
