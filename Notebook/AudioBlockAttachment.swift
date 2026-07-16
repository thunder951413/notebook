@preconcurrency import AppKit
import SwiftUI

/// 音频块附件：显示音频卡片（模仿苹果备忘录样式）
/// NSTextAttachment 的编解码入口由 AppKit 定义为非隔离；实例仍只由编辑器在主线程展示。
nonisolated final class AudioBlockAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let fileURL: URL
    let attachmentFilename: String
    let manifestFilename: String?
    let duration: TimeInterval
    let createDate: Date
    private let embeddedAudioData: Data?
    private let embeddedManifestData: Data?
    private static var fileURLKey: String { "AudioBlockAttachment.fileURL" }
    private static var filenameKey: String { "AudioBlockAttachment.filename" }
    private static var manifestFilenameKey: String { "AudioBlockAttachment.manifestFilename" }
    private static var durationKey: String { "AudioBlockAttachment.duration" }
    private static var dateKey: String { "AudioBlockAttachment.date" }
    private static var audioWrapperKey: String { "AudioBlockAttachment.audioWrapper" }
    private static var manifestWrapperKey: String { "AudioBlockAttachment.manifestWrapper" }

    init(
        fileURL: URL,
        duration: TimeInterval = 0,
        createDate: Date = Date(),
        embeddedAudioData: Data? = nil,
        attachmentFilename: String? = nil,
        embeddedManifestData: Data? = nil,
        deferAudioDataLoading: Bool = false
    ) {
        self.fileURL = fileURL
        self.attachmentFilename = attachmentFilename ?? fileURL.lastPathComponent
        let candidateManifestFilename = Self.manifestFilename(for: self.attachmentFilename)
        let manifestURL = fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        let resolvedManifestData = embeddedManifestData ?? (try? Data(contentsOf: manifestURL))
        self.manifestFilename = resolvedManifestData != nil ? candidateManifestFilename : nil
        self.duration = duration
        self.createDate = createDate
        self.embeddedAudioData = embeddedAudioData ?? (deferAudioDataLoading ? nil : (try? Data(contentsOf: fileURL)))
        self.embeddedManifestData = resolvedManifestData
        super.init(data: nil, ofType: nil)
        
        // 设置附件大小（更紧凑的尺寸，适合文本编辑器）
        self.bounds = CGRect(x: 0, y: 0, width: 229, height: 60)
        
        // 创建卡片图像
        self.image = createCardImage()
        
        DebugLog.attachment("创建附件: \(fileURL.path)", level: .debug)
    }

    required init?(coder: NSCoder) {
        let decodedFilename = coder.decodeObject(of: NSString.self, forKey: Self.filenameKey) as String?
        self.attachmentFilename = decodedFilename?.isEmpty == false ? String(decodedFilename!) : "attachment.m4a"

        let decodedManifestFilename = coder.decodeObject(of: NSString.self, forKey: Self.manifestFilenameKey) as String?
        let audioWrapper = coder.decodeObject(of: FileWrapper.self, forKey: Self.audioWrapperKey)
            ?? coder.decodeObject(of: FileWrapper.self, forKey: "NSFileWrapper")
            ?? coder.decodeObject(of: FileWrapper.self, forKey: NSAttributedString.Key.attachment.rawValue)
        let manifestWrapper = coder.decodeObject(of: FileWrapper.self, forKey: Self.manifestWrapperKey)

        self.embeddedAudioData = audioWrapper?.regularFileContents
        self.embeddedManifestData = manifestWrapper?.regularFileContents
        self.manifestFilename = decodedManifestFilename?.isEmpty == false
            ? String(decodedManifestFilename!)
            : (self.embeddedManifestData != nil ? Self.manifestFilename(for: self.attachmentFilename) : nil)

        if let audioWrapper {
            let extractedURL = Self.uniqueTemporaryFileURL(directoryName: "NotebookAudioExtracted", preferredFilename: attachmentFilename)
            try? audioWrapper.write(to: extractedURL, options: .atomic, originalContentsURL: nil)
            self.fileURL = extractedURL
            if let manifestWrapper, let manifestFilename {
                let manifestURL = extractedURL.deletingPathExtension().appendingPathExtension("tracks.json")
                let wrapper = manifestWrapper
                wrapper.preferredFilename = manifestFilename
                try? wrapper.write(to: manifestURL, options: .atomic, originalContentsURL: nil)
            }
            DebugLog.attachment("从嵌入数据恢复: \(extractedURL.path)", level: .debug)
        } else if let savedPath = coder.decodeObject(of: NSString.self, forKey: Self.fileURLKey) as String? {
            self.fileURL = URL(fileURLWithPath: savedPath)
            DebugLog.attachment("从保存路径恢复: \(savedPath)", level: .debug)
        } else if let resolved = Self.resolveAudioFileURL(fromFilename: attachmentFilename) {
            self.fileURL = resolved
            DebugLog.attachment("从文件名恢复: \(resolved.path)", level: .debug)
        } else {
            self.fileURL = Self.uniqueTemporaryFileURL(directoryName: "NotebookAudioExtracted", preferredFilename: attachmentFilename)
            DebugLog.attachment("未找到可恢复路径，使用临时文件", level: .debug)
        }

        self.duration = coder.decodeDouble(forKey: Self.durationKey)
        if let date = coder.decodeObject(of: NSDate.self, forKey: Self.dateKey) as Date? {
            self.createDate = date
        } else {
            self.createDate = Date()
        }

        super.init(coder: coder)

        // 设置附件大小
        if self.bounds.isEmpty {
            self.bounds = CGRect(x: 0, y: 0, width: 229, height: 60)
        }
        
        // 重新创建卡片图像
        self.image = createCardImage()
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(fileURL.path as NSString, forKey: Self.fileURLKey)
        coder.encode(attachmentFilename as NSString, forKey: Self.filenameKey)
        if let manifestFilename {
            coder.encode(manifestFilename as NSString, forKey: Self.manifestFilenameKey)
        }
        coder.encode(duration, forKey: Self.durationKey)
        coder.encode(createDate, forKey: Self.dateKey)
        if let audioData = audioData() {
            let wrapper = FileWrapper(regularFileWithContents: audioData)
            wrapper.preferredFilename = attachmentFilename
            coder.encode(wrapper, forKey: Self.audioWrapperKey)
        }
        if let manifestData = manifestData(), let manifestFilename {
            let wrapper = FileWrapper(regularFileWithContents: manifestData)
            wrapper.preferredFilename = manifestFilename
            coder.encode(wrapper, forKey: Self.manifestWrapperKey)
        }
        DebugLog.attachment("编码保存路径: \(fileURL.path)", level: .debug)
    }

    func audioData() -> Data? {
        if let data = try? Data(contentsOf: fileURL) {
            return data
        }
        return embeddedAudioData
    }

    func manifestData() -> Data? {
        let manifestURL = fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        if let data = try? Data(contentsOf: manifestURL) {
            return data
        }
        return embeddedManifestData
    }
    
    func refreshPresentationIfNeeded() {
        image = createCardImage()
    }

    private func createCardImage() -> NSImage {
        let cardWidth: CGFloat = 229  // 185(按钮X) + 32(按钮宽) + 12(右边距)
        let cardHeight: CGFloat = 60
        let size = NSSize(width: cardWidth, height: cardHeight)
        let image = NSImage(size: size)

        let primaryTextColor = AttachmentAppearance.primaryTextColor
        let secondaryTextColor = AttachmentAppearance.secondaryTextColor
        let cardBgColor = AttachmentAppearance.backgroundColor
        let buttonBgColor = AttachmentAppearance.secondaryBackgroundColor

        image.lockFocus()

        // 背景卡片
        let rect = CGRect(x: 0, y: 0, width: cardWidth, height: cardHeight)
        let cardPath = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        cardBgColor.setFill()
        cardPath.fill()

        // 日期（去掉"新录音"标题）- 更紧凑
        let dateAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: primaryTextColor
        ]
        let dateText = formatDate(createDate)
        dateText.draw(at: CGPoint(x: 12, y: 32), withAttributes: dateAttributes)

        // 副标题（音频·时长）
        let subAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .regular),
            .foregroundColor: secondaryTextColor
        ]
        let durationText = "\(max(1, Int(duration.rounded())))秒"
        let subText = "音频 · \(durationText)"
        subText.draw(at: CGPoint(x: 12, y: 16), withAttributes: subAttributes)

        // 若存在双轨清单，在时长后面显示"双轨"文字
        if hasDualTrackManifest() {
            let dualTrackAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: secondaryTextColor
            ]
            // 计算"音频 · 3秒"的宽度，在其后绘制" 双轨"
            let subTextWidth = subText.size(withAttributes: subAttributes).width
            let dualTrackText = " 双轨"
            dualTrackText.draw(at: CGPoint(x: 12 + subTextWidth, y: 16), withAttributes: dualTrackAttrs)
        }

        // 右侧播放按钮（正方形，与文字间距为原来的1/3）
        let buttonSize: CGFloat = 32
        // 文字区域右边界约160，按钮放在文字右侧，间距约25pt（原来的1/3）
        let buttonX: CGFloat = 185
        let buttonY = (cardHeight - buttonSize) / 2
        let buttonRect = CGRect(x: buttonX, y: buttonY, width: buttonSize, height: buttonSize)
        let buttonPath = NSBezierPath(roundedRect: buttonRect, xRadius: 6, yRadius: 6)
        buttonBgColor.setFill()
        buttonPath.fill()

        // 播放图标（在正方形按钮内居中）
        if let playImage = NSImage(systemSymbolName: "play.fill", accessibilityDescription: nil) {
            playImage.isTemplate = true
            primaryTextColor.set()
            // 图标稍小于按钮，居中
            let iconSize: CGFloat = 16
            let iconX = buttonRect.midX - iconSize / 2
            let iconY = buttonRect.midY - iconSize / 2
            playImage.draw(in: CGRect(x: iconX, y: iconY, width: iconSize, height: iconSize))
        }

        image.unlockFocus()

        return image
    }
    
    private func formatDuration(_ duration: TimeInterval) -> String {
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy年M月d日 HH:mm"
        return formatter.string(from: date)
    }

    private func hasDualTrackManifest() -> Bool {
        if embeddedManifestData != nil {
            return true
        }
        let manifestURL = fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        return FileManager.default.fileExists(atPath: manifestURL.path)
    }

    private static func resolveAudioFileURL(fromFilename filename: String) -> URL? {
        guard Thread.isMainThread else { return nil }
        return MainActor.assumeIsolated {
            let location = StorageLocationManager.shared
            guard let base = location.baseDirectoryURL else { return nil }

            var result: URL?
            location.withSecurityScopedAccess(base) {
                guard let attachmentsDir = try? location.attachmentsDirectoryURL(),
                      let noteDirs = try? FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil) else {
                    return
                }

                for noteDir in noteDirs {
                    let candidate = noteDir.appendingPathComponent(filename)
                    if FileManager.default.fileExists(atPath: candidate.path) {
                        result = candidate
                        break
                    }
                }
            }
            return result
        }
    }

    private static func uniqueTemporaryFileURL(directoryName: String, preferredFilename: String) -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = URL(fileURLWithPath: preferredFilename).pathExtension
        let base = URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent
        let safeBase = base.isEmpty ? "attachment" : base
        let uniqueName = "\(safeBase)-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
        return directory.appendingPathComponent(uniqueName, isDirectory: false)
    }

    private static func manifestFilename(for audioFilename: String) -> String {
        URL(fileURLWithPath: audioFilename).deletingPathExtension().lastPathComponent + ".tracks.json"
    }
}
