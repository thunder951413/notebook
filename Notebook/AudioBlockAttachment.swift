import AppKit
import SwiftUI

/// 音频块附件：显示音频卡片（模仿苹果备忘录样式）
final class AudioBlockAttachment: NSTextAttachment {
    override static var supportsSecureCoding: Bool { true }

    let fileURL: URL
    let duration: TimeInterval
    let createDate: Date
    private static var fileURLKey: String { "AudioBlockAttachment.fileURL" }
    private static var durationKey: String { "AudioBlockAttachment.duration" }
    private static var dateKey: String { "AudioBlockAttachment.date" }

    init(fileURL: URL, duration: TimeInterval = 0, createDate: Date = Date()) {
        self.fileURL = fileURL
        self.duration = duration
        self.createDate = createDate
        super.init(data: nil, ofType: nil)
        
        // 设置附件大小（更紧凑的尺寸，适合文本编辑器）
        self.bounds = CGRect(x: 0, y: 0, width: 229, height: 60)
        
        // 创建卡片图像
        self.image = createCardImage()
        
        print("[AudioBlockAttachment] 创建附件: \(fileURL.path)")
    }

    required init?(coder: NSCoder) {
        // 尝试解码保存的数据
        if let savedPath = coder.decodeObject(of: NSString.self, forKey: Self.fileURLKey) as String? {
            self.fileURL = URL(fileURLWithPath: savedPath)
            print("[AudioBlockAttachment] 从保存路径恢复: \(savedPath)")
        } else if let fileWrapper = coder.decodeObject(of: FileWrapper.self, forKey: "NSFileWrapper")
            ?? coder.decodeObject(of: FileWrapper.self, forKey: NSAttributedString.Key.attachment.rawValue),
                  let filename = fileWrapper.preferredFilename,
                  let resolved = Self.resolveAudioFileURL(fromFilename: filename) {
            // 兼容 RTFD 反序列化为普通 NSTextAttachment 的场景：优先根据文件名定位真实附件
            self.fileURL = resolved
            print("[AudioBlockAttachment] 从 fileWrapper 恢复: \(resolved.path)")
        } else {
            self.fileURL = FileManager.default.temporaryDirectory
            print("[AudioBlockAttachment] 未找到可恢复路径，使用临时目录")
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
        coder.encode(duration, forKey: Self.durationKey)
        coder.encode(createDate, forKey: Self.dateKey)
        print("[AudioBlockAttachment] 编码保存路径: \(fileURL.path)")
    }
    
    /// 检测当前是否为暗色模式
    private var isDarkMode: Bool {
        if let appearance = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
            return appearance == .darkAqua
        }
        return false
    }

    /// 创建音频卡片图像（仿苹果备忘录）
    private func createCardImage() -> NSImage {
        let cardWidth: CGFloat = 229  // 185(按钮X) + 32(按钮宽) + 12(右边距)
        let cardHeight: CGFloat = 60
        let size = NSSize(width: cardWidth, height: cardHeight)
        let image = NSImage(size: size)

        // 在 lockFocus 前获取颜色设置
        let darkMode = isDarkMode
        let primaryTextColor = darkMode ? NSColor.white : NSColor.black
        let secondaryTextColor = darkMode
            ? NSColor(calibratedWhite: 0.75, alpha: 0.95)
            : NSColor(calibratedWhite: 0.35, alpha: 0.95)
        let cardBgColor = darkMode
            ? NSColor(calibratedWhite: 0.25, alpha: 0.95)
            : NSColor(calibratedWhite: 0.92, alpha: 0.95)
        let buttonBgColor = darkMode
            ? NSColor(calibratedWhite: 0.15, alpha: 0.95)
            : NSColor(calibratedWhite: 0.85, alpha: 0.95)

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
        let manifestURL = fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        return FileManager.default.fileExists(atPath: manifestURL.path)
    }

    private static func resolveAudioFileURL(fromFilename filename: String) -> URL? {
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
