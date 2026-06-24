import SwiftUI
import AppKit
import Foundation
import Combine

@MainActor
protocol PasteCoordinatorProtocol: AnyObject {
    func handlePaste(in textView: NSTextView) -> Bool
    func syncBindingFromTextView(_ textView: NSTextView)
}

extension NSTextView {
    func richTextToolbarAction(_ selector: Selector) {
        NSApp.sendAction(selector, to: nil, from: self)
    }
}

class RichTextView: NSTextView {
    weak var pasteCoordinator: PasteCoordinatorProtocol?
    private var audioPlayerPanel: NSPanel?

    private struct ImageResizeState {
        let range: NSRange
        let initialPoint: CGPoint
        let initialSize: CGSize
        let aspectRatio: CGFloat
        let freeResize: Bool
    }

    private var imageResizeState: ImageResizeState?
    private let minImageWidth: CGFloat = 120
    private let maxImageWidth: CGFloat = 1200

    // 双击检测相关属性
    private var lastClickTime: TimeInterval = 0
    private var lastClickLocation: CGPoint = .zero
    private let doubleClickInterval: TimeInterval = 0.3 // 双击时间间隔（秒）
    private let doubleClickDistanceThreshold: CGFloat = 10.0 // 双击位置最大偏移（像素）
    private var suppressNextMouseUp = false // 用于阻止双击后的 mouseUp 触发链接

    // 当视图从 window 移除时（即将被释放），清除所在 undoManager 的所有操作，
    // 防止已释放的 NSTextView 仍然作为 undo target 导致 EXC_BAD_ACCESS。
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil, let undoManager = self.undoManager {
            undoManager.removeAllActions()
        }
    }

    override func paste(_ sender: Any?) {
        DebugLog.editor("paste(_:) called, pasteCoordinator: \(pasteCoordinator != nil ? "set" : "nil")", level: .debug)
        // 首先尝试让 coordinator 处理图片粘贴
        if let coordinator = pasteCoordinator {
            if coordinator.handlePaste(in: self) {
                // 图片粘贴成功，不调用父类方法
                DebugLog.editor("Image paste handled by coordinator", level: .debug)
                return
            }
        }
        if insertNormalizedPlainTextFromPasteboard() {
            DebugLog.editor("Plain text paste normalized", level: .debug)
            return
        }
        // 如果不是图片，调用标准粘贴
        DebugLog.editor("Falling back to super.paste", level: .debug)
        super.paste(sender)
    }

    private func insertNormalizedPlainTextFromPasteboard() -> Bool {
        guard let rawText = NSPasteboard.general.string(forType: .string), !rawText.isEmpty else {
            return false
        }

        let normalizedText = rawText
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{00a0}", with: " ")

        let replacementRange = self.selectedRange()
        let attributes = attributesForPlainTextInsertion(at: replacementRange.location)
        let attributedText = attributedStringForNormalizedPaste(
            normalizedText,
            replacementRange: replacementRange,
            attributes: attributes
        )
        self.textStorage?.replaceCharacters(in: replacementRange, with: attributedText)
        self.setSelectedRange(NSRange(location: replacementRange.location + attributedText.length, length: 0))
        self.typingAttributes = attributes
        self.didChangeText()
        return true
    }

    private enum PasteLineContinuation {
        case textPrefix(String)
        case checkbox(indentation: String)
        case numbered(indentation: String, nextNumber: Int)
    }

    private func attributesForPlainTextInsertion(at location: Int) -> [NSAttributedString.Key: Any] {
        var attributes = self.typingAttributes

        if let textStorage, textStorage.length > 0 {
            let lookupLocation = location > 0
                ? min(location - 1, textStorage.length - 1)
                : min(location, textStorage.length - 1)
            var nearbyAttributes = textStorage.attributes(at: lookupLocation, effectiveRange: nil)
            for (key, value) in attributes {
                nearbyAttributes[key] = value
            }
            attributes = nearbyAttributes
        }

        attributes[.font] = attributes[.font] as? NSFont ?? AppSettings.shared.editorFont
        attributes[.foregroundColor] = attributes[.foregroundColor] as? NSColor ?? NSColor.textColor
        attributes.removeValue(forKey: .attachment)
        attributes.removeValue(forKey: .link)
        attributes.removeValue(forKey: .paragraphStyle)
        attributes.removeValue(forKey: .notebookHeadingLevel)
        attributes.removeValue(forKey: .notebookExplicitBold)
        attributes.removeValue(forKey: .notebookExplicitItalic)
        attributes.removeValue(forKey: .notebookExplicitFontFamily)
        attributes.removeValue(forKey: .notebookExplicitFontSize)
        attributes.removeValue(forKey: .notebookExplicitForegroundColor)
        return attributes
    }

    private func attributedStringForNormalizedPaste(
        _ text: String,
        replacementRange: NSRange,
        attributes: [NSAttributedString.Key: Any]
    ) -> NSAttributedString {
        guard text.contains("\n"),
              let continuation = pasteLineContinuation(at: replacementRange.location) else {
            return NSAttributedString(string: text, attributes: attributes)
        }

        let result = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n")
        guard let firstLine = lines.first else {
            return NSAttributedString(string: text, attributes: attributes)
        }

        result.append(NSAttributedString(string: firstLine, attributes: attributes))

        var nextNumber: Int?
        if case .numbered(_, let number) = continuation {
            nextNumber = number
        }

        for index in lines.indices.dropFirst() {
            let line = lines[index]
            let isTrailingEmptyLine = index == lines.indices.last && line.isEmpty

            result.append(NSAttributedString(string: "\n", attributes: attributes))
            guard !isTrailingEmptyLine else { continue }

            switch continuation {
            case .textPrefix(let prefix):
                result.append(NSAttributedString(string: prefix, attributes: attributes))
            case .checkbox(let indentation):
                result.append(NSAttributedString(string: indentation, attributes: attributes))
                result.append(NSAttributedString(attachment: CheckboxTextAttachment(checked: false)))
                result.append(NSAttributedString(string: " ", attributes: attributes))
            case .numbered(let indentation, _):
                let number = nextNumber ?? 1
                result.append(NSAttributedString(string: "\(indentation)\(number). ", attributes: attributes))
                nextNumber = number + 1
            }

            result.append(NSAttributedString(string: line, attributes: attributes))
        }

        return result
    }

    private func pasteLineContinuation(at location: Int) -> PasteLineContinuation? {
        let nsString = self.string as NSString
        let safeLocation = max(0, min(location, nsString.length))
        let lineRange = nsString.lineRange(for: NSRange(location: safeLocation, length: 0))
        let indentation = indentationPrefix(for: lineRange)

        if findCheckboxAtLineStart(lineRange: lineRange) != nil {
            return .checkbox(indentation: indentation)
        }

        if findPrefixAtLineStart(lineRange: lineRange, prefix: "• ") != nil {
            return .textPrefix(indentation + "• ")
        }

        if findPrefixAtLineStart(lineRange: lineRange, prefix: "- ") != nil {
            return .textPrefix(indentation + "- ")
        }

        if let (_, number) = findNumberedListAtLineStart(lineRange: lineRange) {
            return .numbered(indentation: indentation, nextNumber: number + 1)
        }

        return nil
    }

    // 处理拖放粘贴
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        DebugLog.editor("readSelection(from:type:) called, type: \(type)", level: .debug)
        return super.readSelection(from: pboard, type: type)
    }
    
    // 处理拖放操作
    override func performDragOperation(_ draggingInfo: NSDraggingInfo) -> Bool {
        DebugLog.editor("performDragOperation called", level: .debug)
        
        let pasteboard = draggingInfo.draggingPasteboard
        
        // 尝试读取文件URL
        if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           !fileURLs.isEmpty {
            let fileURL = fileURLs[0]
            let imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "heic", "webp"]
            let ext = fileURL.pathExtension.lowercased()
            
            if imageExtensions.contains(ext) {
                DebugLog.editor("Dropped image file: \(fileURL)", level: .debug)
                if let coordinator = pasteCoordinator as? RichTextEditor.Coordinator {
                    if coordinator.handleDroppedImage(fileURL: fileURL, in: self) {
                        return true
                    }
                }
            }
        }
        
        // 如果不是图片，调用父类处理
        return super.performDragOperation(draggingInfo)
    }

    // 处理 validateMenuItem 确保粘贴菜单可用
    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(NSTextView.paste(_:)) {
            DebugLog.editor("validateMenuItem for paste", level: .debug)
            return true
        }
        return super.validateMenuItem(menuItem)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawImageResizeHandles()
    }

    private func drawImageResizeHandles() {
        guard let layoutManager = self.layoutManager,
              let textContainer = self.textContainer,
              let textStorage = self.textStorage,
              textStorage.length > 0 else {
            return
        }

        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length), options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment,
                  isImageAttachment(attachment) else { return }

            let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            attachmentRect.origin.x += self.textContainerInset.width
            attachmentRect.origin.y += self.textContainerInset.height

            let visualRect = attachmentRectForImage(attachment, glyphRange: glyphRange, layoutManager: layoutManager, textContainer: textContainer)

            let handleSize: CGFloat = 10
            let handleRect = CGRect(
                x: visualRect.maxX - handleSize - 2,
                y: visualRect.minY + 2,
                width: handleSize,
                height: handleSize
            )

            let path = NSBezierPath(roundedRect: handleRect, xRadius: 2, yRadius: 2)
            NSColor.white.withAlphaComponent(0.9).setFill()
            path.fill()

            NSColor.black.withAlphaComponent(0.45).setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard let layoutManager = self.layoutManager,
              let textContainer = self.textContainer,
              let textStorage = self.textStorage,
              textStorage.length > 0 else {
            return
        }

        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length), options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment,
                  isImageAttachment(attachment) else { return }

            let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let visualRect = attachmentRectForImage(attachment, glyphRange: glyphRange, layoutManager: layoutManager, textContainer: textContainer)

            let handleSize: CGFloat = 16
            let handleRect = CGRect(
                x: visualRect.maxX - handleSize - 2,
                y: visualRect.minY,
                width: handleSize,
                height: handleSize
            ).insetBy(dx: -8, dy: -8)

            self.addCursorRect(handleRect, cursor: .crosshair)
        }
    }

    // 处理鼠标点击事件 - 用于切换复选框
    override func mouseDown(with event: NSEvent) {
        let point = self.convert(event.locationInWindow, from: nil)

        // 0) 图片右下角拖拽缩放
        if beginImageResizeIfNeeded(at: point, event: event) {
            return
        }

        // 0.5) 检测表格点击（单击或双击都打开编辑器）
        if handleTableClick(at: point, event: event) {
            return
        }

        // 1) 最高优先级：按 link 属性识别音频 URL（跨重启最稳）
        if let layoutManager = self.layoutManager,
           let textContainer = self.textContainer {
            let textContainerPoint = CGPoint(
                x: point.x - self.textContainerInset.width,
                y: point.y - self.textContainerInset.height
            )
            let idx = layoutManager.characterIndex(
                for: textContainerPoint,
                in: textContainer,
                fractionOfDistanceBetweenInsertionPoints: nil
            )
            let safeIdx = max(0, min(idx, max(0, self.attributedString().length - 1)))
            if self.attributedString().length > 0 {
                let value = self.attributedString().attribute(.link, at: safeIdx, effectiveRange: nil)
                if let url = value as? URL, isAudioURL(url) {
                    let fallbackAttachment = AudioBlockAttachment(fileURL: url)
                    let rect = CGRect(x: point.x - 150, y: point.y - 35, width: 300, height: 70)
                    DebugLog.editor("通过 link 打开音频播放器: \(url.lastPathComponent)", level: .debug)
                    showAudioPlayerPopover(for: fallbackAttachment, at: rect)
                    return
                }
                if let str = value as? String,
                   let url = URL(string: str),
                   isAudioURL(url) {
                    let fallbackAttachment = AudioBlockAttachment(fileURL: url)
                    let rect = CGRect(x: point.x - 150, y: point.y - 35, width: 300, height: 70)
                    DebugLog.editor("通过 link(字符串) 打开音频播放器: \(url.lastPathComponent)", level: .debug)
                    showAudioPlayerPopover(for: fallbackAttachment, at: rect)
                    return
                }
            }
        }

        // 尝试多种方式获取点击位置的字符索引
        var index = self.characterIndexForInsertion(at: point)

        if (index == NSNotFound || index >= self.attributedString().length),
           let layoutManager = self.layoutManager,
           let textContainer = self.textContainer {
            index = layoutManager.characterIndex(for: point, in: textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
        }

        // 检查是否点击了复选框 - 检查点击位置以及前后几个位置
        if index != NSNotFound,
           let layoutManager = self.layoutManager,
           let textContainer = self.textContainer {
            let attr = self.attributedString()
            let checkRange = 5
            let startIndex = max(0, index - checkRange)
            let endIndex = min(attr.length - 1, index + checkRange)

            // 确保范围有效（当文本为空时 attr.length 为 0，endIndex 会是 -1）
            if startIndex <= endIndex {
                for checkIndex in startIndex...endIndex {
                    var effectiveRange = NSRange(location: NSNotFound, length: 0)

                    if let attachment = normalizedCheckboxAttachment(at: checkIndex, effectiveRange: &effectiveRange) {
                        let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
                        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
                        attachmentRect.origin.x += self.textContainerInset.width
                        attachmentRect.origin.y += self.textContainerInset.height

                        // 接近 macOS 备忘录：仅略微扩大点击热区，避免误触文本
                        let expandedRect = attachmentRect.insetBy(dx: -5, dy: -5)
                        if expandedRect.contains(point) {
                            let wasChecked = attachment.isChecked
                            attachment.toggle()
                            let isNowChecked = attachment.isChecked

                            self.textStorage?.beginEditing()
                            self.textStorage?.setAttributes([.attachment: attachment], range: effectiveRange)
                            self.textStorage?.endEditing()
                            self.didChangeText()

                            if !wasChecked && isNowChecked {
                                Task { @MainActor [weak self] in
                                    try? await Task.sleep(for: .milliseconds(300))
                                    self?.sortCheckboxesIfNeeded()
                                }
                            }

                            if let coordinator = self.delegate as? RichTextEditor.Coordinator {
                                coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: self))
                            }
                            return
                        }
                    }
                }
            }
        }

        // 检查是否点击了音频附件
        if let layoutManager = self.layoutManager,
           let textContainer = self.textContainer {
            let attr = self.attributedString()

            // 先用点击位置反查字符索引（比遍历所有附件更稳定）
            let textContainerPoint = CGPoint(
                x: point.x - self.textContainerInset.width,
                y: point.y - self.textContainerInset.height
            )
            var clickedIndex = layoutManager.characterIndex(
                for: textContainerPoint,
                in: textContainer,
                fractionOfDistanceBetweenInsertionPoints: nil
            )

            if clickedIndex >= attr.length {
                clickedIndex = max(0, attr.length - 1)
            }

            // 优先检查点击点附近（快路径）
            let candidateIndexes = [clickedIndex - 1, clickedIndex, clickedIndex + 1].filter { $0 >= 0 && $0 < attr.length }
            let hitNearby = candidateIndexes.contains { idx in
                openAudioAttachmentIfHit(at: idx, in: attr, layoutManager: layoutManager, textContainer: textContainer, clickPoint: point)
            }
            if hitNearby { return }

            // 兜底：全量扫描所有附件（修复重启后点击索引偏移导致的点不开）
            var found = false
            attr.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attr.length), options: []) { value, range, stop in
                guard !found, value is NSTextAttachment else { return }
                let opened = openAudioAttachmentIfHit(at: range.location, in: attr, layoutManager: layoutManager, textContainer: textContainer, clickPoint: point)
                if opened {
                    found = true
                    stop.pointee = true
                }
            }
            if found { return }
        }

        // 检测双击图片 - 用系统预览打开
        var doubleClickHandled = false
        if isDoubleClick(event, at: point) {
            if let layoutManager = self.layoutManager,
               let textContainer = self.textContainer {
                let attr = self.attributedString()
                let textContainerPoint = CGPoint(
                    x: point.x - self.textContainerInset.width,
                    y: point.y - self.textContainerInset.height
                )
                var clickedIndex = layoutManager.characterIndex(
                    for: textContainerPoint,
                    in: textContainer,
                    fractionOfDistanceBetweenInsertionPoints: nil
                )
                if clickedIndex >= attr.length {
                    clickedIndex = max(0, attr.length - 1)
                }

                // 优先检查点击点附近
                let candidateIndexes = [clickedIndex - 1, clickedIndex, clickedIndex + 1].filter { $0 >= 0 && $0 < attr.length }
                for idx in candidateIndexes {
                    if openImageInPreviewIfHit(at: idx, in: attr, layoutManager: layoutManager, textContainer: textContainer, clickPoint: point) {
                        doubleClickHandled = true
                        break
                    }
                }

                // 兜底：全量扫描所有附件
                if !doubleClickHandled {
                    attr.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attr.length), options: []) { value, range, stop in
                        guard !doubleClickHandled, value is NSTextAttachment else { return }
                        if openImageInPreviewIfHit(at: range.location, in: attr, layoutManager: layoutManager, textContainer: textContainer, clickPoint: point) {
                            doubleClickHandled = true
                            stop.pointee = true
                        }
                    }
                }
            }
        }

        // 如果双击成功打开了图片，不再调用 super.mouseDown，避免触发 link 的默认行为
        if doubleClickHandled {
            // 重置点击记录，避免三击被识别为双击
            lastClickTime = 0
            lastClickLocation = .zero
            suppressNextMouseUp = true // 标记需要阻止接下来的 mouseUp
            return
        }

        // 检测单击是否点在图片上，如果是则阻止系统处理 link 的默认行为（避免弹出"未设定用来打开 URL"的弹窗）
        if let layoutManager = self.layoutManager,
           let textContainer = self.textContainer {
            let attr = self.attributedString()
            let textContainerPoint = CGPoint(
                x: point.x - self.textContainerInset.width,
                y: point.y - self.textContainerInset.height
            )
            var clickedIndex = layoutManager.characterIndex(
                for: textContainerPoint,
                in: textContainer,
                fractionOfDistanceBetweenInsertionPoints: nil
            )
            if clickedIndex >= attr.length {
                clickedIndex = max(0, attr.length - 1)
            }

            // 检查是否点在图片上
            let candidateIndexes = [clickedIndex - 1, clickedIndex, clickedIndex + 1].filter { $0 >= 0 && $0 < attr.length }
            var clickedOnImage = false
            for idx in candidateIndexes {
                if isImageAttachmentAt(at: idx, in: attr, layoutManager: layoutManager, textContainer: textContainer, clickPoint: point) {
                    clickedOnImage = true
                    break
                }
            }

            // 如果点在图片上，阻止默认行为，只记录点击信息用于双击检测
            if clickedOnImage {
                // 记录本次点击时间和位置（用于下次双击检测）
                lastClickTime = Date.timeIntervalSinceReferenceDate
                lastClickLocation = point
                suppressNextMouseUp = true // 阻止 mouseUp 触发 link
                return
            }
        }

        // 记录本次点击时间和位置（用于下次双击检测）
        lastClickTime = Date.timeIntervalSinceReferenceDate
        lastClickLocation = point

        super.mouseDown(with: event)
    }

    /// 检查指定位置是否为图片附件且点击位置在图片范围内
    private func isImageAttachmentAt(
        at index: Int,
        in attr: NSAttributedString,
        layoutManager: NSLayoutManager,
        textContainer: NSTextContainer,
        clickPoint: CGPoint
    ) -> Bool {
        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        guard let attachment = attr.attribute(.attachment, at: index, effectiveRange: &effectiveRange) as? NSTextAttachment,
              isImageAttachment(attachment) else {
            return false
        }

        let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)

        // 使用 attachment.bounds 的真实尺寸
        if attachment.bounds.width > 0, attachment.bounds.height > 0 {
            attachmentRect.size = attachment.bounds.size
        }

        attachmentRect.origin.x += self.textContainerInset.width
        attachmentRect.origin.y += self.textContainerInset.height

        // 扩大点击热区，便于命中
        let expandedRect = attachmentRect.insetBy(dx: -10, dy: -10)
        return expandedRect.contains(clickPoint)
    }

    /// 判断是否为双击事件
    private func isDoubleClick(_ event: NSEvent, at point: CGPoint) -> Bool {
        let currentTime = Date.timeIntervalSinceReferenceDate
        let timeDelta = currentTime - lastClickTime
        let distance = hypot(point.x - lastClickLocation.x, point.y - lastClickLocation.y)
        return timeDelta < doubleClickInterval && distance < doubleClickDistanceThreshold
    }

    /// 如果点击位置是图片附件，则用系统预览打开
    private func openImageInPreviewIfHit(
        at index: Int,
        in attr: NSAttributedString,
        layoutManager: NSLayoutManager,
        textContainer: NSTextContainer,
        clickPoint: CGPoint
    ) -> Bool {
        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        guard let attachment = attr.attribute(.attachment, at: index, effectiveRange: &effectiveRange) as? NSTextAttachment,
              isImageAttachment(attachment) else {
            return false
        }

        let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)

        // 使用 attachment.bounds 的真实尺寸
        if attachment.bounds.width > 0, attachment.bounds.height > 0 {
            attachmentRect.size = attachment.bounds.size
        }

        attachmentRect.origin.x += self.textContainerInset.width
        attachmentRect.origin.y += self.textContainerInset.height

        // 扩大点击热区，便于命中
        let expandedRect = attachmentRect.insetBy(dx: -10, dy: -10)
        guard expandedRect.contains(clickPoint) else { return false }

        // 获取图片文件 URL
        var imageURL: URL?
        if let typedAttachment = attachment as? AttachmentTextAttachment {
            imageURL = typedAttachment.attachmentFileURL
        } else if let fileWrapper = attachment.fileWrapper,
                  let filename = fileWrapper.preferredFilename {
            // 尝试从附件目录中查找
            let location = StorageLocationManager.shared
            if let base = location.baseDirectoryURL {
                location.withSecurityScopedAccess(base) {
                    if let attachmentsDir = try? location.attachmentsDirectoryURL(),
                       let noteDirs = try? FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil) {
                        for noteDir in noteDirs {
                            let candidate = noteDir.appendingPathComponent(filename)
                            if FileManager.default.fileExists(atPath: candidate.path) {
                                imageURL = candidate
                                break
                            }
                        }
                    }
                }
            }
        }

        guard let url = imageURL, FileManager.default.fileExists(atPath: url.path) else {
            DebugLog.editor("图片文件不存在", level: .debug)
            return false
        }

        DebugLog.editor("双击打开图片: \(url.lastPathComponent)", level: .debug)

        // 使用系统预览打开图片
        NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Preview.app"), configuration: NSWorkspace.OpenConfiguration()) { app, error in
            if let error = error {
                DebugLog.editor("打开预览失败: \(error)", level: .warn)
                // 失败时使用默认方式打开
                NSWorkspace.shared.open(url)
            }
        }

        return true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let state = imageResizeState,
              let textStorage = self.textStorage,
              let attachment = textStorage.attribute(.attachment, at: state.range.location, effectiveRange: nil) as? NSTextAttachment,
              isImageAttachment(attachment) else {
            super.mouseDragged(with: event)
            return
        }

        let currentPoint = self.convert(event.locationInWindow, from: nil)
        let deltaX = currentPoint.x - state.initialPoint.x
        let deltaY = state.initialPoint.y - currentPoint.y

        var targetWidth = state.initialSize.width + deltaX
        var targetHeight = state.initialSize.height + deltaY

        if state.freeResize {
            targetWidth = min(max(targetWidth, minImageWidth), maxImageWidth)
            targetHeight = min(max(targetHeight, minImageWidth * 0.5), maxImageWidth)
        } else {
            targetWidth = min(max(targetWidth, minImageWidth), maxImageWidth)
            targetHeight = max(minImageWidth / max(state.aspectRatio, 0.001), targetWidth / max(state.aspectRatio, 0.001))
        }

        let newSize = CGSize(width: targetWidth, height: targetHeight)

        attachment.bounds = NSRect(origin: .zero, size: newSize)

        textStorage.beginEditing()
        textStorage.addAttribute(.attachment, value: attachment, range: state.range)
        textStorage.addAttribute(.notebookImageWidth, value: newSize.width, range: state.range)
        textStorage.addAttribute(.notebookImageHeight, value: newSize.height, range: state.range)
        if let typedAttachment = attachment as? AttachmentTextAttachment {
            let imageLink = imageMetadataLink(for: typedAttachment.attachmentFileURL, size: newSize)
            textStorage.addAttribute(.link, value: imageLink, range: state.range)
        }
        textStorage.endEditing()

        if let currentW = textStorage.attribute(.notebookImageWidth, at: state.range.location, effectiveRange: nil) as? CGFloat,
           let currentH = textStorage.attribute(.notebookImageHeight, at: state.range.location, effectiveRange: nil) as? CGFloat,
           let currentLink = textStorage.attribute(.link, at: state.range.location, effectiveRange: nil) {
            DebugLog.editor("new bounds=\(attachment.bounds.size), attrs=\(currentW)x\(currentH), link=\(currentLink), freeResize=\(state.freeResize)", level: .debug)
        } else {
            DebugLog.editor("new bounds=\(attachment.bounds.size), attrs=<missing>, freeResize=\(state.freeResize)", level: .debug)
        }
        self.didChangeText()
        if let coordinator = self.delegate as? RichTextEditor.Coordinator {
            coordinator.syncBindingFromTextView(self)
        }
        self.needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        // 如果标记了阻止 mouseUp，直接返回
        if suppressNextMouseUp {
            suppressNextMouseUp = false
            return
        }

        if imageResizeState != nil {
            imageResizeState = nil
            if let coordinator = self.delegate as? RichTextEditor.Coordinator {
                coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: self))
            }
            return
        }

        super.mouseUp(with: event)
    }

    private func attachmentRectForImage(_ attachment: NSTextAttachment,
                                        glyphRange: NSRange,
                                        layoutManager: NSLayoutManager,
                                        textContainer: NSTextContainer) -> CGRect {
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)

        // 关键：优先使用 attachment.bounds 的真实尺寸，避免 glyph rect 过小导致命中偏移
        if attachment.bounds.width > 0, attachment.bounds.height > 0 {
            attachmentRect.size = attachment.bounds.size
        }

        attachmentRect.origin.x += self.textContainerInset.width
        attachmentRect.origin.y += self.textContainerInset.height
        return attachmentRect
    }

    private func beginImageResizeIfNeeded(at point: CGPoint, event: NSEvent) -> Bool {
        guard let layoutManager = self.layoutManager,
              let textContainer = self.textContainer,
              let textStorage = self.textStorage,
              textStorage.length > 0 else {
            return false
        }

        let textContainerPoint = CGPoint(
            x: point.x - self.textContainerInset.width,
            y: point.y - self.textContainerInset.height
        )

        var index = layoutManager.characterIndex(
            for: textContainerPoint,
            in: textContainer,
            fractionOfDistanceBetweenInsertionPoints: nil
        )
        index = max(0, min(index, textStorage.length - 1))

        for checkIndex in [index - 1, index, index + 1] where checkIndex >= 0 && checkIndex < textStorage.length {
            var effectiveRange = NSRange(location: NSNotFound, length: 0)
            guard let attachment = textStorage.attribute(.attachment, at: checkIndex, effectiveRange: &effectiveRange) as? NSTextAttachment,
                  isImageAttachment(attachment) else {
                continue
            }

            let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
            let visualRect = attachmentRectForImage(attachment, glyphRange: glyphRange, layoutManager: layoutManager, textContainer: textContainer)

            let handleSize: CGFloat = 16
            let handleRect = CGRect(
                x: visualRect.maxX - handleSize - 2,
                y: visualRect.minY,
                width: handleSize,
                height: handleSize
            ).insetBy(dx: -8, dy: -8)

            if handleRect.contains(point) {
                let initialSize = attachment.bounds.size
                let safeWidth = max(initialSize.width, 1)
                let safeHeight = max(initialSize.height, 1)
                let useFreeResize = event.modifierFlags.contains(.shift)
                imageResizeState = ImageResizeState(
                    range: effectiveRange,
                    initialPoint: point,
                    initialSize: initialSize,
                    aspectRatio: safeWidth / safeHeight,
                    freeResize: useFreeResize
                )
                return true
            }
        }

        return false
    }

    private func isImageAttachment(_ attachment: NSTextAttachment) -> Bool {
        // 排除表格附件
        if attachment is TableTextAttachment {
            return false
        }
        if attachment is CheckboxTextAttachment {
            return false
        }
        if CheckboxTextAttachment.looksLikeCheckbox(attachment) {
            return false
        }
        if let typed = attachment as? AttachmentTextAttachment {
            return typed.kind == .image
        }
        if attachment is AudioBlockAttachment {
            return false
        }
        if attachment.image != nil {
            return true
        }
        if let filename = attachment.fileWrapper?.preferredFilename {
            return mimeTypeForFilename(filename).hasPrefix("image/")
        }
        return false
    }

    // MARK: - 表格点击处理

    private func attachmentRectForTable(_ attachment: TableTextAttachment,
                                        glyphRange: NSRange,
                                        layoutManager: NSLayoutManager,
                                        textContainer: NSTextContainer) -> CGRect {
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        if attachment.bounds.width > 0, attachment.bounds.height > 0 {
            attachmentRect.size = attachment.bounds.size
        }
        attachmentRect.origin.x += self.textContainerInset.width
        attachmentRect.origin.y += self.textContainerInset.height
        return attachmentRect
    }

    private func handleTableClick(at point: CGPoint, event: NSEvent) -> Bool {
        guard let layoutManager = self.layoutManager,
              let textContainer = self.textContainer,
              let textStorage = self.textStorage,
              textStorage.length > 0 else {
            return false
        }

        let textContainerPoint = CGPoint(
            x: point.x - self.textContainerInset.width,
            y: point.y - self.textContainerInset.height
        )

        var index = layoutManager.characterIndex(
            for: textContainerPoint,
            in: textContainer,
            fractionOfDistanceBetweenInsertionPoints: nil
        )
        index = max(0, min(index, textStorage.length - 1))

        for checkIndex in [index - 1, index, index + 1] where checkIndex >= 0 && checkIndex < textStorage.length {
            var effectiveRange = NSRange(location: NSNotFound, length: 0)
            guard let tableAttachment = textStorage.attribute(.attachment, at: checkIndex, effectiveRange: &effectiveRange) as? TableTextAttachment else {
                continue
            }

            let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
            let attachmentRect = attachmentRectForTable(tableAttachment, glyphRange: glyphRange, layoutManager: layoutManager, textContainer: textContainer)

            let expandedRect = attachmentRect.insetBy(dx: -5, dy: -5)
            if expandedRect.contains(point) {
                // 单击或双击都显示编辑器
                showTableEditor(for: tableAttachment, at: attachmentRect, range: effectiveRange)
                return true
            }
        }

        return false
    }

    private var activeTableEditor: TableInlineEditorView?
    private var activeTableAttachment: TableTextAttachment?
    private var activeTableRange: NSRange?

    var hasActiveTableEditor: Bool {
        activeTableEditor != nil
    }

    private func refreshActiveTableEditorLayout() {
        guard let editor = activeTableEditor,
              let range = activeTableRange,
              let textStorage = textStorage,
              range.location >= 0,
              range.location + range.length <= textStorage.length,
              let layoutManager = self.layoutManager,
              let textContainer = self.textContainer else {
            return
        }

        editor.updateTableData(editor.currentTableData())
        layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
        layoutManager.invalidateDisplay(forCharacterRange: range)
        layoutManager.ensureLayout(for: textContainer)

        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let attachmentRect: CGRect
        if let tableAttachment = activeTableAttachment {
            attachmentRect = attachmentRectForTable(tableAttachment, glyphRange: glyphRange, layoutManager: layoutManager, textContainer: textContainer)
        } else {
            var fallbackRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            fallbackRect.origin.x += textContainerInset.width
            fallbackRect.origin.y += textContainerInset.height
            attachmentRect = fallbackRect
        }

        let editorSize = editor.frame.size
        editor.frame = NSRect(
            x: attachmentRect.origin.x,
            y: attachmentRect.origin.y - editorSize.height + attachmentRect.height,
            width: editorSize.width,
            height: editorSize.height
        )
        editor.needsDisplay = true
        needsDisplay = true
    }

    private func showTableEditor(for attachment: TableTextAttachment, at rect: CGRect, range: NSRange) {
        // 如果已经有活动的编辑器，先关闭它
        hideActiveTableEditor()

        // 保存当前附件和范围
        activeTableAttachment = attachment
        activeTableRange = range

        // 创建内联编辑器
        let editorView = TableInlineEditorView(
            tableData: attachment.tableData,
            onDataChanged: { [weak self, weak attachment] newData in
                attachment?.tableData = newData
                attachment?.updateImage()
                guard let self = self else { return }
                self.activeTableEditor?.updateTableData(newData)
                if let range = self.activeTableRange {
                    self.textStorage?.edited(.editedAttributes, range: range, changeInLength: 0)
                    self.refreshActiveTableEditorLayout()
                    DispatchQueue.main.async { [weak self] in
                        self?.refreshActiveTableEditorLayout()
                    }
                }
            },
            onCellEdited: { [weak attachment] row, col, value in
                attachment?.updateCell(row: row, column: col, value: value)
            }
        )

        addSubview(editorView)
        activeTableEditor = editorView
        refreshActiveTableEditorLayout()

        // 不再替换为空白附件，保留真实表格附件以确保保存/恢复
        // 通过 editorView 覆盖展示即可
        if let textStorage = self.textStorage {
            textStorage.edited(.editedAttributes, range: range, changeInLength: 0)
        }

        // 点击外部时关闭编辑器
        DispatchQueue.main.async { [weak self] in
            NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self = self, let editor = self.activeTableEditor else { return event }
                let point = self.convert(event.locationInWindow, from: nil)
                if !editor.frame.contains(point) {
                    self.hideActiveTableEditor()
                }
                return event
            }
        }
    }

    private func hideActiveTableEditor() {
        guard let editor = activeTableEditor, let attachment = activeTableAttachment, let range = activeTableRange else {
            activeTableEditor?.removeFromSuperview()
            activeTableEditor = nil
            activeTableAttachment = nil
            activeTableRange = nil
            return
        }

        // 关闭前强制提交编辑内容
        editor.finalizeEditing()
        attachment.tableData = editor.currentTableData()
        attachment.updateImage()

        // 恢复原始表格附件
        if let textStorage = self.textStorage,
           range.location >= 0,
           range.location + range.length <= textStorage.length {
            let attrString = NSAttributedString(attachment: attachment)
            textStorage.replaceCharacters(in: range, with: attrString)
            if let data = try? JSONEncoder().encode(attachment.tableData) {
                DebugLog.editor("hideActiveTableEditor write notebookTableData bytes=\(data.count) rows=\(attachment.tableData.rowCount)", level: .debug)
                textStorage.addAttribute(.notebookTableData, value: data, range: NSRange(location: range.location, length: 1))
            }
            textStorage.edited(.editedAttributes, range: range, changeInLength: 0)
        }

        editor.removeFromSuperview()
        activeTableEditor = nil
        activeTableAttachment = nil
        activeTableRange = nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window = self.window {
            NotificationCenter.default.addObserver(self, selector: #selector(windowDidResignKey(_:)), name: NSWindow.didResignKeyNotification, object: window)
            NotificationCenter.default.addObserver(self, selector: #selector(windowDidBecomeKey(_:)), name: NSWindow.didBecomeKeyNotification, object: window)
        }
    }

    @objc private func windowDidResignKey(_ notification: Notification) {
        hideActiveTableEditor()
    }

    @objc private func windowDidBecomeKey(_ notification: Notification) {
        // 强制刷新表格渲染，避免切回应用后出现空渲染
        normalizeAttachmentsAfterLoad()
        setNeedsDisplay(self.bounds)
    }


    /// 在保存/切换笔记前强制提交表格编辑状态
    func finalizeActiveTableEditorIfNeeded() {
        if activeTableEditor != nil {
            hideActiveTableEditor()
        }
    }

    private func openAudioAttachmentIfHit(
        at index: Int,
        in attr: NSAttributedString,
        layoutManager: NSLayoutManager,
        textContainer: NSTextContainer,
        clickPoint: CGPoint
    ) -> Bool {
        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        guard let rawAttachment = attr.attribute(.attachment, at: index, effectiveRange: &effectiveRange) as? NSTextAttachment else {
            return false
        }

        let glyphRange = layoutManager.glyphRange(forCharacterRange: effectiveRange, actualCharacterRange: nil)
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)

        if let audioAttachment = rawAttachment as? AudioBlockAttachment {
            if attachmentRect.width < audioAttachment.bounds.width * 0.7 {
                attachmentRect.size = audioAttachment.bounds.size
            }

            attachmentRect.origin.x += self.textContainerInset.width
            attachmentRect.origin.y += self.textContainerInset.height

            let expandedRect = attachmentRect.insetBy(dx: -24, dy: -12)
            guard expandedRect.contains(clickPoint) else { return false }

            DebugLog.editor("打开音频播放器: \(audioAttachment.fileURL.lastPathComponent)", level: .debug)
            showAudioPlayerPopover(for: audioAttachment, at: attachmentRect)
            return true
        }

        if let fallbackURL = resolveAudioURLFromAttachment(rawAttachment) {
            let fallbackAttachment = AudioBlockAttachment(fileURL: fallbackURL)
            if attachmentRect.width < fallbackAttachment.bounds.width * 0.7 {
                attachmentRect.size = fallbackAttachment.bounds.size
            }

            attachmentRect.origin.x += self.textContainerInset.width
            attachmentRect.origin.y += self.textContainerInset.height

            let expandedRect = attachmentRect.insetBy(dx: -24, dy: -12)
            guard expandedRect.contains(clickPoint) else { return false }

            DebugLog.editor("打开音频播放器(兼容模式): \(fallbackURL.lastPathComponent)", level: .debug)
            showAudioPlayerPopover(for: fallbackAttachment, at: attachmentRect)
            return true
        }

        return false
    }

    private func isAudioURL(_ url: URL) -> Bool {
        let audioExts: Set<String> = ["m4a", "caf", "wav", "aiff", "mp3"]
        return audioExts.contains(url.pathExtension.lowercased())
    }

    func normalizeAttachmentsAfterLoad() {
        guard let textStorage else { return }
        let fullRange = NSRange(location: 0, length: textStorage.length)
        
        DebugLog.editor("normalizeAttachmentsAfterLoad: textStorage length = \(textStorage.length)", level: .debug)

        var tableRangesNeedingLayoutRefresh: [NSRange] = []

        textStorage.beginEditing()

        textStorage.enumerateAttribute(.attachment, in: fullRange, options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            
            DebugLog.editor("Found attachment at range \(range.location)-\(range.location + range.length), type: \(type(of: attachment))", level: .debug)

            // 0) 先做附件自愈：把普通 NSTextAttachment 的图片/音频替换为自定义附件
            if !(attachment is AttachmentTextAttachment),
               !(attachment is AudioBlockAttachment),
               !(attachment is TableTextAttachment),
               !TableTextAttachment.looksLikeTable(attachment) {
                if let convertedAudio = convertLegacyAudioAttachmentIfNeeded(attachment) {
                    textStorage.addAttribute(.attachment, value: convertedAudio, range: range)
                } else if let convertedImage = convertLegacyImageAttachmentIfNeeded(attachment) {
                    textStorage.addAttribute(.attachment, value: convertedImage, range: range)
                }
            }

            if let textAttachment = textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) as? AttachmentTextAttachment {
                if textAttachment.kind == .image,
                   mimeTypeForFilename(textAttachment.attachmentFilename).hasPrefix("audio/") {
                    let recoveredAudio = AudioBlockAttachment(
                        fileURL: textAttachment.attachmentFileURL,
                        embeddedAudioData: textAttachment.attachmentData(),
                        attachmentFilename: textAttachment.attachmentFilename
                    )
                    if !textAttachment.bounds.isEmpty {
                        recoveredAudio.bounds = textAttachment.bounds
                    }
                    textStorage.addAttribute(.attachment, value: recoveredAudio, range: range)
                    if textStorage.attribute(.link, at: range.location, effectiveRange: nil) == nil {
                        textStorage.addAttribute(.link, value: textAttachment.attachmentFileURL, range: range)
                    }
                    return
                }

                // 1) 图片附件：优先恢复持久化尺寸，再刷新展示
                if textAttachment.kind == .image {
                    var restored = false

                    let savedWidth = textStorage.attribute(.notebookImageWidth, at: range.location, effectiveRange: nil) as? CGFloat
                    let savedHeight = textStorage.attribute(.notebookImageHeight, at: range.location, effectiveRange: nil) as? CGFloat
                    if let savedWidth, let savedHeight, savedWidth > 1, savedHeight > 1 {
                        textAttachment.bounds = NSRect(x: 0, y: 0, width: savedWidth, height: savedHeight)
                        DebugLog.editor("Restored image bounds from attrs: \(savedWidth)x\(savedHeight)", level: .debug)
                        restored = true
                    }

                    if !restored,
                       let parsed = parseImageMetadataLink(textStorage.attribute(.link, at: range.location, effectiveRange: nil)) {
                        textAttachment.bounds = NSRect(x: 0, y: 0, width: parsed.width, height: parsed.height)
                        textStorage.addAttribute(.notebookImageWidth, value: parsed.width, range: range)
                        textStorage.addAttribute(.notebookImageHeight, value: parsed.height, range: range)
                        DebugLog.editor("Restored image bounds from link: \(parsed.width)x\(parsed.height)", level: .debug)
                    }
                }
                textAttachment.refreshPresentationIfNeeded()

                // 2) 音频附件：确保 link 属性存在，便于点击播放和 Markdown 提取
                let hasLink = textStorage.attribute(.link, at: range.location, effectiveRange: nil) != nil
                if !hasLink, textAttachment.kind == .audio {
                    textStorage.addAttribute(.link, value: textAttachment.attachmentFileURL, range: range)
                }
                return
            }

            // 3) 表格附件：检查并刷新
            if let tableAttachment = attachment as? TableTextAttachment {
                DebugLog.editor("Found TableTextAttachment, rows: \(tableAttachment.tableData.rowCount), cols: \(tableAttachment.tableData.columnCount)", level: .debug)
                if let rawData = textStorage.attribute(.notebookTableData, at: range.location, effectiveRange: nil) as? Data,
                   let decoded = try? JSONDecoder().decode(TableData.self, from: rawData) {
                    DebugLog.editor("load notebookTableData bytes=\(rawData.count) rows=\(decoded.rowCount)", level: .debug)
                    tableAttachment.tableData = decoded
                } else if let (tableData, _) = TableTextAttachment.extractTableData(from: tableAttachment.contents) {
                    DebugLog.editor("load from contents rows=\(tableData.rowCount)", level: .debug)
                    tableAttachment.tableData = tableData
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        DebugLog.editor("backfill notebookTableData bytes=\(encoded.count)", level: .debug)
                    }
                } else if let wrapper = tableAttachment.fileWrapper,
                          wrapper.isDirectory,
                          let jsonData = wrapper.fileWrappers?["table.json"]?.regularFileContents,
                          let tableData = try? JSONDecoder().decode(TableData.self, from: jsonData) {
                    DebugLog.editor("load from fileWrapper json bytes=\(jsonData.count) rows=\(tableData.rowCount)", level: .debug)
                    tableAttachment.tableData = tableData
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        DebugLog.editor("backfill notebookTableData bytes=\(encoded.count)", level: .debug)
                    }
                    if let pngData = wrapper.fileWrappers?["table.png"]?.regularFileContents, !pngData.isEmpty {
                        tableAttachment.contents = pngData
                    }
                } else if let wrapper = tableAttachment.fileWrapper,
                          wrapper.isRegularFile,
                          let data = wrapper.regularFileContents,
                          let (tableData, _) = TableTextAttachment.extractTableData(from: data) {
                    DebugLog.editor("load from fileWrapper bytes=\(data.count) rows=\(tableData.rowCount)", level: .debug)
                    tableAttachment.tableData = tableData
                    tableAttachment.contents = data
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        DebugLog.editor("backfill notebookTableData bytes=\(encoded.count)", level: .debug)
                    }
                } else {
                    DebugLog.editor("load failed: no table data", level: .warn)
                }
                if (tableAttachment.contents?.isEmpty ?? true),
                   let wrapper = tableAttachment.fileWrapper {
                    if wrapper.isDirectory,
                       let pngData = wrapper.fileWrappers?["table.png"]?.regularFileContents,
                       !pngData.isEmpty {
                        tableAttachment.contents = pngData
                    } else if wrapper.isRegularFile,
                              let data = wrapper.regularFileContents,
                              !data.isEmpty {
                        tableAttachment.contents = data
                    }
                }
                if tableAttachment.fileType == nil || tableAttachment.fileType?.hasPrefix("dyn.") == true {
                    tableAttachment.fileType = "public.png"
                }
                DebugLog.editor("TableAttachment contents: \(tableAttachment.contents?.count ?? 0) bytes, fileType: \(tableAttachment.fileType ?? "nil")", level: .debug)
                tableAttachment.updateImage()
                DebugLog.editor("TableAttachment image after update: \(tableAttachment.image != nil ? "exists" : "nil")", level: .debug)
                tableRangesNeedingLayoutRefresh.append(range)
                return
            }
            
            // 3.5) 尝试从普通 NSTextAttachment 恢复表格附件
            // RTFD 保存时可能丢失了自定义类信息，需要根据特征识别表格附件
            let attachmentClassName = String(describing: type(of: attachment))
            let isKnownCustomType = attachment is AttachmentTextAttachment ||
                                   attachment is AudioBlockAttachment ||
                                   attachment is TableTextAttachment ||
                                   attachment is CheckboxTextAttachment
            DebugLog.editor("Attachment class: \(attachmentClassName), isKnownCustom: \(isKnownCustomType)", level: .debug)
            
            if !isKnownCustomType {
                DebugLog.editor("Unknown attachment type, checking if looks like table...", level: .debug)
                DebugLog.editor("Attachment bounds: \(attachment.bounds.width) x \(attachment.bounds.height)", level: .debug)
                DebugLog.editor("Attachment contents: \(attachment.contents?.count ?? 0) bytes", level: .debug)
                DebugLog.editor("Attachment image: \(attachment.image != nil ? "exists" : "nil")", level: .debug)
                
                if TableTextAttachment.looksLikeTable(attachment) {
                    DebugLog.editor("Found potential table attachment, attempting recovery...", level: .debug)
                    
                    // 尝试恢复表格附件
                    if let recovered = TableTextAttachment.recover(from: attachment) {
                        let tableDataAttr = textStorage.attribute(.notebookTableData, at: range.location, effectiveRange: nil)
                        textStorage.addAttribute(.attachment, value: recovered, range: range)
                        if let tableDataAttr {
                            textStorage.addAttribute(.notebookTableData, value: tableDataAttr, range: range)
                        }
                        tableRangesNeedingLayoutRefresh.append(range)
                        DebugLog.editor("Successfully recovered TableTextAttachment with \(recovered.tableData.rowCount) rows", level: .debug)
                        return
                    }
                } else {
                    DebugLog.editor("Does not look like table", level: .debug)
                }
            }

            // 4) 其他音频附件兜底
            let hasLink = textStorage.attribute(.link, at: range.location, effectiveRange: nil) != nil
            if hasLink { return }

            if let audioAttachment = attachment as? AudioBlockAttachment {
                textStorage.addAttribute(.link, value: audioAttachment.fileURL, range: range)
                return
            }

            if let fallbackURL = resolveAudioURLFromAttachment(attachment) {
                textStorage.addAttribute(.link, value: fallbackURL, range: range)
            }
        }
        textStorage.endEditing()

        if !tableRangesNeedingLayoutRefresh.isEmpty {
            for range in tableRangesNeedingLayoutRefresh {
                layoutManager?.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
                layoutManager?.invalidateDisplay(forCharacterRange: range)
            }
            if let textContainer {
                layoutManager?.ensureLayout(for: textContainer)
            }
            needsDisplay = true
        }
    }

    private func convertLegacyImageAttachmentIfNeeded(_ attachment: NSTextAttachment) -> AttachmentTextAttachment? {
        func uniqueMigratedFileURL(preferredFilename: String) -> URL {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("NotebookMigrated", isDirectory: true)
            try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

            let ext = URL(fileURLWithPath: preferredFilename).pathExtension
            let base = URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent
            let safeBase = base.isEmpty ? "attachment" : base
            let uniqueName = "\(safeBase)-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
            return tmp.appendingPathComponent(uniqueName, isDirectory: false)
        }

        // 先尝试从 fileWrapper 恢复原图
        if let fileWrapper = attachment.fileWrapper,
           let data = fileWrapper.regularFileContents,
           let filename = fileWrapper.preferredFilename {
            let mimeType = mimeTypeForFilename(filename)
            if mimeType.hasPrefix("image/") {
                let out = uniqueMigratedFileURL(preferredFilename: filename)
                do {
                    try data.write(to: out, options: .atomic)
                    let newAttachment = AttachmentTextAttachment(fileURL: out, kind: .image)
                    // 尽量保留旧 bounds
                    if attachment.bounds.width > 1, attachment.bounds.height > 1 {
                        newAttachment.bounds = attachment.bounds
                    }
                    return newAttachment
                } catch {
                    DebugLog.editor("Failed writing legacy image data: \(error)", level: .warn)
                }
            }
        }

        // 再尝试从 image 导出 PNG
        if let image = attachment.image,
           let tiffData = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiffData),
           let pngData = bitmap.representation(using: .png, properties: [:]) {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("NotebookMigrated", isDirectory: true)
            try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let out = tmp.appendingPathComponent("legacy-\(UUID().uuidString).png")
            do {
                try pngData.write(to: out, options: .atomic)
                let newAttachment = AttachmentTextAttachment(fileURL: out, kind: .image)
                if attachment.bounds.width > 1, attachment.bounds.height > 1 {
                    newAttachment.bounds = attachment.bounds
                }
                return newAttachment
            } catch {
                DebugLog.editor("Failed exporting legacy image: \(error)", level: .warn)
            }
        }

        return nil
    }

    private func convertLegacyAudioAttachmentIfNeeded(_ attachment: NSTextAttachment) -> AudioBlockAttachment? {
        if let fileWrapper = attachment.fileWrapper,
           let data = fileWrapper.regularFileContents,
           let filename = fileWrapper.preferredFilename {
            let mimeType = mimeTypeForFilename(filename)
            if mimeType.hasPrefix("audio/") {
                let out = FileManager.default.temporaryDirectory
                    .appendingPathComponent("NotebookMigrated", isDirectory: true)
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                let destination = out.appendingPathComponent("\(UUID().uuidString)-\(filename)")
                do {
                    try data.write(to: destination, options: .atomic)
                    return AudioBlockAttachment(
                        fileURL: destination,
                        embeddedAudioData: data,
                        attachmentFilename: filename
                    )
                } catch {
                    DebugLog.editor("Failed writing legacy audio data: \(error)", level: .warn)
                }
            }
        }

        if let resolvedURL = resolveAudioURLFromAttachment(attachment) {
            return AudioBlockAttachment(
                fileURL: resolvedURL,
                attachmentFilename: resolvedURL.lastPathComponent
            )
        }

        return nil
    }

    private func mimeTypeForFilename(_ filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "bmp": return "image/bmp"
        case "tif", "tiff": return "image/tiff"
        case "m4a": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "aiff": return "audio/aiff"
        case "caf": return "audio/x-caf"
        default: return "application/octet-stream"
        }
    }

    private func imageMetadataLink(for fileURL: URL, size: CGSize) -> String {
        let w = max(1, Int(size.width.rounded()))
        let h = max(1, Int(size.height.rounded()))
        return "notebook-image://\(fileURL.absoluteString)#w=\(w)&h=\(h)"
    }

    private func parseImageMetadataLink(_ value: Any?) -> (url: URL, width: CGFloat, height: CGFloat)? {
        let raw: String
        if let str = value as? String {
            raw = str
        } else if let url = value as? URL {
            raw = url.absoluteString
        } else {
            return nil
        }

        guard raw.hasPrefix("notebook-image://") else { return nil }

        let payload = String(raw.dropFirst("notebook-image://".count))
        let parts = payload.split(separator: "#", maxSplits: 1).map(String.init)
        guard let filePart = parts.first, !filePart.isEmpty,
              let fileURL = URL(string: filePart) else {
            return nil
        }

        var width: CGFloat = 0
        var height: CGFloat = 0
        if parts.count == 2 {
            for item in parts[1].split(separator: "&") {
                let kv = item.split(separator: "=", maxSplits: 1).map(String.init)
                guard kv.count == 2 else { continue }
                if kv[0] == "w" { width = CGFloat(Double(kv[1]) ?? 0) }
                if kv[0] == "h" { height = CGFloat(Double(kv[1]) ?? 0) }
            }
        }

        guard width > 1, height > 1 else { return nil }
        return (fileURL, width, height)
    }

    private func resolveAudioURLFromAttachment(_ attachment: NSTextAttachment) -> URL? {
        let audioExts: Set<String> = ["m4a", "caf", "wav", "aiff", "mp3"]

        // 1) 优先 fileWrapper 文件名
        if let filename = attachment.fileWrapper?.preferredFilename,
           audioExts.contains(URL(fileURLWithPath: filename).pathExtension.lowercased()) {
            let location = StorageLocationManager.shared
            if let base = location.baseDirectoryURL {
                var found: URL?
                location.withSecurityScopedAccess(base) {
                    if let attachmentsDir = try? location.attachmentsDirectoryURL(),
                       let noteDirs = try? FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil) {
                        for noteDir in noteDirs {
                            let candidate = noteDir.appendingPathComponent(filename)
                            if FileManager.default.fileExists(atPath: candidate.path) {
                                found = candidate
                                break
                            }
                        }
                    }
                }
                if found != nil { return found }
            }
        }

        // 2) 再尝试 attachment.fileType
        if let fileType = attachment.fileType,
           audioExts.contains(fileType.lowercased()),
           let fileWrapper = attachment.fileWrapper,
           let filename = fileWrapper.preferredFilename {
            return URL(fileURLWithPath: filename)
        }

        return nil
    }

    /// 显示音频播放器弹窗
    private func showAudioPlayerPopover(for attachment: AudioBlockAttachment, at rect: CGRect) {
        guard FileManager.default.fileExists(atPath: attachment.fileURL.path) else {
            DebugLog.editor("音频文件不存在: \(attachment.fileURL.path)", level: .debug)
            return
        }

        // 关闭上一个播放器窗口，避免叠加/失焦
        audioPlayerPanel?.close()
        audioPlayerPanel = nil

        // 创建弹窗窗口
        let popoverWindow = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 300),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        popoverWindow.title = "录音"
        popoverWindow.isFloatingPanel = true
        popoverWindow.level = .floating

        // 创建播放器视图
        let playerView = AudioPlayerPopoverContent(fileURL: attachment.fileURL)
        let hostingView = NSHostingView(rootView: playerView)
        hostingView.frame = popoverWindow.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 320, height: 300)
        hostingView.autoresizingMask = [.width, .height]
        popoverWindow.contentView = hostingView

        // 定位窗口在附件附近
        if self.window?.screen != nil {
            let windowRect = self.convert(rect, to: nil)
            let screenPoint = self.window?.convertPoint(toScreen: windowRect.origin) ?? .zero
            let x = screenPoint.x + rect.width / 2 - 160
            let y = screenPoint.y - 320 - 10
            popoverWindow.setFrameOrigin(NSPoint(x: x, y: y))
        }

        // 强引用，防止窗口被释放导致“偶现点击无效”
        audioPlayerPanel = popoverWindow
        popoverWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 检查是否需要排序复选框
    private func sortCheckboxesIfNeeded() {
        // 检查是否有已完成和未完成的混合
        let checkboxes = self.findAllCheckboxes()
        guard checkboxes.count > 1 else { return }

        let hasChecked = checkboxes.contains { $0.attachment.isChecked }
        let hasUnchecked = checkboxes.contains { !$0.attachment.isChecked }

        // 只有同时有已完成和未完成时才排序
        if hasChecked && hasUnchecked {
            self.sortCheckboxes()
        }
    }

    // 处理键盘事件 - 用于回车自动继承复选框
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            if hasInputMarkedText() {
                clearInputMarkedText()
                return
            }

            super.keyDown(with: event)
            return
        }

        if event.keyCode == 48 {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock)
            let isShiftOnly = flags == .shift
            let hasNoModifiers = flags.isEmpty
            if (hasNoModifiers || isShiftOnly), shouldIndentSelectionWithTab() {
                adjustIndentForSelectedLines(increase: !isShiftOnly)
                return
            }
        }

        // 检查是否是回车键
        if event.keyCode == 36 || event.keyCode == 76 { // 36 = Return, 76 = Enter
            // 先检查是否有 marked text（输入法正在编辑中）
            if hasInputMarkedText() {
                _ = commitMarkedTextIfNeeded()
                return
            }
            // 没有 marked text，处理列表自动继承
            if handleReturnKey() {
                return
            }
        }

        super.keyDown(with: event)
    }

    private func selectedLineRangesForEditing() -> [NSRange] {
        let nsString = self.string as NSString
        let selectedRange = self.selectedRange()
        var effectiveRange = selectedRange

        if effectiveRange.length > 0,
           NSMaxRange(effectiveRange) <= nsString.length,
           NSMaxRange(effectiveRange) > effectiveRange.location,
           nsString.character(at: NSMaxRange(effectiveRange) - 1) == 10 {
            effectiveRange.length -= 1
        }

        let fullLineRange = nsString.lineRange(for: effectiveRange)
        guard fullLineRange.length > 0 else { return [fullLineRange] }

        var ranges: [NSRange] = []
        var location = fullLineRange.location
        let end = NSMaxRange(fullLineRange)

        while location < end {
            let lineRange = nsString.lineRange(for: NSRange(location: location, length: 0))
            ranges.append(lineRange)
            let nextLocation = NSMaxRange(lineRange)
            guard nextLocation > location else { break }
            location = nextLocation
        }

        return ranges
    }

    private func shouldIndentSelectionWithTab() -> Bool {
        let selectedRange = self.selectedRange()
        if selectedRange.length > 0 {
            return true
        }

        let lineRange = (self.string as NSString).lineRange(for: selectedRange)
        if findCheckboxAtLineStart(lineRange: lineRange) != nil {
            return true
        }
        if findPrefixAtLineStart(lineRange: lineRange, prefix: "• ") != nil {
            return true
        }
        if findPrefixAtLineStart(lineRange: lineRange, prefix: "- ") != nil {
            return true
        }
        if findNumberedListAtLineStart(lineRange: lineRange) != nil {
            return true
        }
        return false
    }

    private func adjustIndentForSelectedLines(increase: Bool) {
        let selectedRange = self.selectedRange()
        let ranges = selectedLineRangesForEditing()
        var deltaBeforeSelection = 0
        var totalDelta = 0

        self.textStorage?.beginEditing()
        for lineRange in ranges.reversed() {
            if increase {
                self.textStorage?.insert(NSAttributedString(string: "    "), at: lineRange.location)
                totalDelta += 4
                if lineRange.location < selectedRange.location {
                    deltaBeforeSelection += 4
                }
            } else {
                let nsString = self.string as NSString
                let maxDelete = min(4, NSMaxRange(lineRange) - lineRange.location)
                var deleteLength = 0
                while deleteLength < maxDelete {
                    let scalar = nsString.character(at: lineRange.location + deleteLength)
                    if scalar == 32 {
                        deleteLength += 1
                    } else if scalar == 9 {
                        deleteLength += 1
                        break
                    } else {
                        break
                    }
                }
                guard deleteLength > 0 else { continue }
                self.textStorage?.deleteCharacters(in: NSRange(location: lineRange.location, length: deleteLength))
                totalDelta -= deleteLength
                if lineRange.location < selectedRange.location {
                    deltaBeforeSelection -= deleteLength
                }
            }
        }
        self.textStorage?.endEditing()

        let newLocation = max(0, selectedRange.location + deltaBeforeSelection)
        let newLength = max(0, selectedRange.length + totalDelta - deltaBeforeSelection)
        self.setSelectedRange(NSRange(location: newLocation, length: newLength))
        self.didChangeText()
    }

    override func cancelOperation(_ sender: Any?) {
        if hasInputMarkedText() {
            clearInputMarkedText()
            return
        }

        super.cancelOperation(sender)
    }

    private func hasInputMarkedText() -> Bool {
        guard let inputContext = self.inputContext else { return false }
        return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
    }

    private func clearInputMarkedText() {
        let markedRange = self.markedRange()
        self.inputContext?.discardMarkedText()

        if markedRange.location != NSNotFound, markedRange.length > 0 {
            self.textStorage?.deleteCharacters(in: markedRange)
            self.setSelectedRange(NSRange(location: markedRange.location, length: 0))
        }

        if let coordinator = self.delegate as? RichTextEditor.Coordinator {
            coordinator.handleMarkedTextFinished(in: self)
        }
    }

    private func commitMarkedTextIfNeeded() -> Bool {
        let markedRange = self.markedRange()
        guard markedRange.location != NSNotFound, markedRange.length > 0 else { return false }
        
        let fullString = self.string as NSString
        let markedString = fullString.substring(with: markedRange)
        
        self.textStorage?.beginEditing()
        self.textStorage?.deleteCharacters(in: markedRange)
        self.textStorage?.endEditing()
        
        self.insertText(markedString, replacementRange: NSRange(location: markedRange.location, length: 0))
        
        return true
    }

    /// 处理回车键 - 自动继承列表符号和格式
    private func handleReturnKey() -> Bool {
        let nsString = self.string as NSString
        let selectedRange = self.selectedRange()
        guard selectedRange.length == 0 else { return false }
        let currentLineRange = nsString.lineRange(for: selectedRange)

        // 1. 检查复选框
        if let checkboxRange = findCheckboxAtLineStart(lineRange: currentLineRange) {
            return handleCheckboxReturn(checkboxRange: checkboxRange, currentLineRange: currentLineRange, nsString: nsString)
        }

        // 2. 检查项目符号列表 (• )
        if let bulletRange = findPrefixAtLineStart(lineRange: currentLineRange, prefix: "• ") {
            return handleListReturn(prefixRange: bulletRange, prefix: "• ", currentLineRange: currentLineRange, nsString: nsString)
        }

        // 3. 检查短划线列表 (- )
        if let dashRange = findPrefixAtLineStart(lineRange: currentLineRange, prefix: "- ") {
            return handleListReturn(prefixRange: dashRange, prefix: "- ", currentLineRange: currentLineRange, nsString: nsString)
        }

        // 4. 检查编号列表 (数字. )
        if let (numberRange, number) = findNumberedListAtLineStart(lineRange: currentLineRange) {
            return handleNumberedListReturn(numberRange: numberRange, currentNumber: number, currentLineRange: currentLineRange, nsString: nsString)
        }

        if handleHeadingReturn(currentLineRange: currentLineRange) {
            return true
        }

        // 5. 没有列表，继承上一行的格式（字号、字体、颜色）
        return handleFormatInheritance(currentLineRange: currentLineRange)
    }

    private func handleHeadingReturn(currentLineRange: NSRange) -> Bool {
        guard let textStorage = self.textStorage else { return false }
        let contentLocation = contentStartLocation(in: currentLineRange)
        let lookupLocation: Int
        if contentLocation < textStorage.length {
            lookupLocation = contentLocation
        } else if currentLineRange.location < textStorage.length {
            lookupLocation = currentLineRange.location
        } else {
            return false
        }

        guard textStorage.attribute(.notebookHeadingLevel, at: lookupLocation, effectiveRange: nil) != nil else {
            return false
        }

        self.insertNewline(nil)
        var attributes = self.typingAttributes
        attributes[.font] = AppSettings.shared.editorFont
        attributes[.foregroundColor] = attributes[.foregroundColor] as? NSColor ?? NSColor.textColor
        attributes.removeValue(forKey: .notebookHeadingLevel)
        attributes.removeValue(forKey: .notebookExplicitBold)
        self.typingAttributes = attributes
        self.didChangeText()
        return true
    }

    /// 处理格式继承 - 从当前行或上一行获取格式
    private func handleFormatInheritance(currentLineRange: NSRange) -> Bool {
        guard self.textStorage != nil else { return false }

        // 获取要继承的格式
        let (font, color) = getFormatToInherit(from: currentLineRange)

        // 如果有格式需要继承
        if font != nil || color != nil {
            // 插入换行
            self.insertNewline(nil)

            // 获取新行的位置
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())

            // 应用继承的格式到新行
            applyFormat(font: font, color: color, to: newLineRange)

            return true
        }

        return false
    }

    private func contentStartLocation(in lineRange: NSRange) -> Int {
        let nsString = self.string as NSString
        let prefixLocation = leadingWhitespaceBoundary(in: lineRange)
        let lineEnd = NSMaxRange(lineRange)
        guard prefixLocation < lineEnd else { return prefixLocation }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        if normalizedCheckboxAttachment(at: prefixLocation, effectiveRange: &effectiveRange) != nil {
            var contentLocation = NSMaxRange(effectiveRange)
            if contentLocation < lineEnd,
               contentLocation < nsString.length,
               nsString.substring(with: NSRange(location: contentLocation, length: 1)) == " " {
                contentLocation += 1
            }
            return contentLocation
        }

        let contentRange = NSRange(location: prefixLocation, length: lineEnd - prefixLocation)
        let lineContent = nsString.substring(with: contentRange)
        for prefix in ["• ", "- ", "* "] {
            if lineContent.hasPrefix(prefix) {
                return prefixLocation + prefix.utf16.count
            }
        }

        if let regex = try? NSRegularExpression(pattern: "^\\d+\\.\\s"),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {
            return prefixLocation + match.range.length
        }

        return prefixLocation
    }

    /// 获取要继承的格式（从当前行或上一行）
    private func getFormatToInherit(from lineRange: NSRange) -> (font: NSFont?, color: NSColor?) {
        guard let textStorage = self.textStorage else { return (nil, nil) }

        var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
        var font: NSFont?
        var color: NSColor?

        if lineRange.location < textStorage.length {
            let contentLocation = contentStartLocation(in: lineRange)
            if contentLocation < textStorage.length {
                font = textStorage.attribute(.font, at: contentLocation, effectiveRange: &effectiveRange) as? NSFont
                color = textStorage.attribute(.foregroundColor, at: contentLocation, effectiveRange: &effectiveRange) as? NSColor
            }
        }

        // 如果当前行没有自定义颜色（不是默认颜色），尝试从上一行获取
        // 检查是否是默认颜色（黑色或白色，根据主题）
        let isDefaultColor: Bool
        if let currentColor = color {
            // 检查是否是默认文字颜色（黑色或白色）
            let isDark = self.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let defaultColor = isDark ? NSColor.white : NSColor.black
            isDefaultColor = currentColor.isEqual(to: defaultColor) || 
                            currentColor.isEqual(to: NSColor.textColor)
        } else {
            isDefaultColor = true
        }

        // 如果没有自定义格式，尝试从上一行获取
        if (font == nil || isDefaultColor) && lineRange.location > 0 {
            // 获取上一行的范围
            let previousLocation = lineRange.location - 1
            if previousLocation < textStorage.length {
                let previousLineRange = (self.string as NSString).lineRange(for: NSRange(location: previousLocation, length: 0))

                let prevContentLocation = contentStartLocation(in: previousLineRange)
                if prevContentLocation < textStorage.length {
                    // 优先使用上一行的颜色（如果是自定义颜色）
                    if let prevColor = textStorage.attribute(.foregroundColor, at: prevContentLocation, effectiveRange: &effectiveRange) as? NSColor {
                        // 检查上一行是否是自定义颜色
                        let isPrevDefault: Bool
                        let isDark = self.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                        let defaultColor = isDark ? NSColor.white : NSColor.black
                        isPrevDefault = prevColor.isEqual(to: defaultColor) ||
                                        prevColor.isEqual(to: NSColor.textColor)

                        if !isPrevDefault {
                            color = prevColor
                        }
                    }

                    // 如果当前没有字体，使用上一行的字体
                    if font == nil {
                        font = textStorage.attribute(.font, at: prevContentLocation, effectiveRange: &effectiveRange) as? NSFont
                    }
                }
            }
        }

        return (font, color)
    }

    /// 应用格式到指定范围，同时设置 typingAttributes 以便新输入继承格式
    private func applyFormat(font: NSFont?, color: NSColor?, to range: NSRange) {
        guard let textStorage = self.textStorage else { return }

        // 根据当前外观模式确定默认颜色
        let effectiveColor = color ?? NSColor.textColor

        // 设置 typingAttributes ，让新输入的文字继承格式
        var newTypingAttributes = self.typingAttributes
        if let font = font {
            newTypingAttributes[.font] = font
        }
        newTypingAttributes[.foregroundColor] = effectiveColor
        self.typingAttributes = newTypingAttributes

        // 如果范围有效，也应用到现有文本
        if range.location < textStorage.length && range.length > 0 {
            textStorage.beginEditing()

            if let font = font {
                textStorage.addAttribute(.font, value: font, range: range)
            }
            textStorage.addAttribute(.foregroundColor, value: effectiveColor, range: range)

            textStorage.endEditing()
        }

        self.didChangeText()
    }

    private func inheritedAttributes(font: NSFont?, color: NSColor?) -> [NSAttributedString.Key: Any] {
        let effectiveFont = font ?? (self.typingAttributes[.font] as? NSFont) ?? AppSettings.shared.editorFont
        let effectiveColor = color ?? (self.typingAttributes[.foregroundColor] as? NSColor) ?? NSColor.textColor
        return [
            .font: effectiveFont,
            .foregroundColor: effectiveColor
        ]
    }

    private func inheritedAttributedString(_ string: String, font: NSFont?, color: NSColor?) -> NSAttributedString {
        NSAttributedString(string: string, attributes: inheritedAttributes(font: font, color: color))
    }

    private func leadingWhitespaceBoundary(in lineRange: NSRange) -> Int {
        let nsString = self.string as NSString
        let end = NSMaxRange(lineRange)
        var location = lineRange.location

        while location < end {
            let scalar = nsString.character(at: location)
            if scalar == 32 || scalar == 9 {
                location += 1
                continue
            }
            break
        }

        return location
    }

    private func moveInsertionPointAfterDeletingListPrefix(_ deleteRange: NSRange) {
        self.textStorage?.deleteCharacters(in: deleteRange)
        self.setSelectedRange(NSRange(location: deleteRange.location, length: 0))
        self.didChangeText()
    }

    private func indentationPrefix(for lineRange: NSRange) -> String {
        let nsString = self.string as NSString
        let indentationEnd = leadingWhitespaceBoundary(in: lineRange)
        guard indentationEnd > lineRange.location else { return "" }
        return nsString.substring(with: NSRange(location: lineRange.location, length: indentationEnd - lineRange.location))
    }

    /// 处理复选框回车
    private func handleCheckboxReturn(checkboxRange: NSRange, currentLineRange: NSRange, nsString: NSString) -> Bool {
        // 检查当前行是否只有复选框（空行）
        let contentAfterCheckbox = nsString.substring(with: NSRange(location: checkboxRange.upperBound, length: currentLineRange.upperBound - checkboxRange.upperBound))
        let trimmedContent = contentAfterCheckbox.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedContent.isEmpty {
            // 空行，删除复选框
            var deleteRange = checkboxRange
            if checkboxRange.upperBound < currentLineRange.upperBound {
                let nextCharRange = NSRange(location: checkboxRange.upperBound, length: 1)
                if nextCharRange.upperBound <= nsString.length,
                   nsString.substring(with: nextCharRange) == " " {
                    deleteRange.length += 1
                }
            }
            moveInsertionPointAfterDeletingListPrefix(deleteRange)
            return true
        } else {
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入复选框（未选中状态）
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let indentation = indentationPrefix(for: currentLineRange)
            let newAttachment = CheckboxTextAttachment(checked: false)
            let mutableAttr = NSMutableAttributedString()
            mutableAttr.append(inheritedAttributedString(indentation, font: font, color: color))
            mutableAttr.append(NSAttributedString(attachment: newAttachment))
            mutableAttr.append(inheritedAttributedString(" ", font: font, color: color))

            self.textStorage?.insert(mutableAttr, at: newLineRange.location)

            // 应用继承的格式到复选框之后的内容（跳过复选框和空格）
            let contentStartLocation = newLineRange.location + mutableAttr.length
            let contentRange = NSRange(location: contentStartLocation, length: 0)
            applyFormat(font: font, color: color, to: contentRange)
            
            // 设置光标位置在复选框之后
            self.setSelectedRange(NSRange(location: contentStartLocation, length: 0))

            return true
        }
    }

    /// 处理普通列表回车
    private func handleListReturn(prefixRange: NSRange, prefix: String, currentLineRange: NSRange, nsString: NSString) -> Bool {
        // 检查当前行是否只有前缀（空行）
        let contentAfterPrefix = nsString.substring(with: NSRange(location: prefixRange.upperBound, length: currentLineRange.upperBound - prefixRange.upperBound))
        let trimmedContent = contentAfterPrefix.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedContent.isEmpty {
            // 空行，删除前缀
            let deleteRange = NSRange(location: prefixRange.location, length: prefixRange.length)
            moveInsertionPointAfterDeletingListPrefix(deleteRange)
            return true
        } else {
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入相同的前缀
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let newPrefix = indentationPrefix(for: currentLineRange) + prefix
            self.textStorage?.insert(inheritedAttributedString(newPrefix, font: font, color: color), at: newLineRange.location)

            // 应用继承的格式到前缀之后的内容
            let contentStartLocation = newLineRange.location + newPrefix.utf16.count
            let contentRange = NSRange(location: contentStartLocation, length: 0)
            applyFormat(font: font, color: color, to: contentRange)
            
            // 设置光标位置在前缀之后
            self.setSelectedRange(NSRange(location: contentStartLocation, length: 0))

            return true
        }
    }

    /// 处理编号列表回车
    private func handleNumberedListReturn(numberRange: NSRange, currentNumber: Int, currentLineRange: NSRange, nsString: NSString) -> Bool {
        _ = "\(currentNumber). "

        // 检查当前行是否只有编号（空行）
        let contentAfterNumber = nsString.substring(with: NSRange(location: numberRange.upperBound, length: currentLineRange.upperBound - numberRange.upperBound))
        let trimmedContent = contentAfterNumber.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedContent.isEmpty {
            // 空行，删除编号
            let deleteRange = NSRange(location: numberRange.location, length: numberRange.length)
            moveInsertionPointAfterDeletingListPrefix(deleteRange)
            return true
        } else {
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入下一个编号
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let nextNumber = currentNumber + 1
            let newPrefix = indentationPrefix(for: currentLineRange) + "\(nextNumber). "
            self.textStorage?.insert(inheritedAttributedString(newPrefix, font: font, color: color), at: newLineRange.location)

            // 应用继承的格式到编号之后的内容
            let contentStartLocation = newLineRange.location + newPrefix.utf16.count
            let contentRange = NSRange(location: contentStartLocation, length: 0)
            applyFormat(font: font, color: color, to: contentRange)
            
            // 设置光标位置在编号之后
            self.setSelectedRange(NSRange(location: contentStartLocation, length: 0))

            renumberFollowingNumberedList(
                afterLineContaining: contentStartLocation,
                indentation: indentationPrefix(for: currentLineRange),
                nextNumber: nextNumber + 1
            )

            return true
        }
    }

    private func renumberFollowingNumberedList(
        afterLineContaining location: Int,
        indentation: String,
        nextNumber: Int
    ) {
        guard let textStorage = self.textStorage else { return }

        var number = nextNumber
        var scanLocation = NSMaxRange((self.string as NSString).lineRange(for: NSRange(location: min(location, self.string.utf16.count), length: 0)))
        var didRenumber = false

        textStorage.beginEditing()
        while scanLocation < textStorage.length {
            let nsString = self.string as NSString
            let lineRange = nsString.lineRange(for: NSRange(location: scanLocation, length: 0))
            guard lineRange.length > 0 else { break }

            let lineIndentation = indentationPrefix(for: lineRange)
            let trimmedLine = nsString.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines)

            if lineIndentation == indentation,
               let numbered = findNumberedListAtLineStart(lineRange: lineRange) {
                let replacement = "\(number). "
                textStorage.replaceCharacters(in: numbered.range, with: replacement)
                didRenumber = true
                number += 1
                let updatedLineRange = (self.string as NSString).lineRange(for: NSRange(location: lineRange.location, length: 0))
                scanLocation = NSMaxRange(updatedLineRange)
                continue
            }

            if trimmedLine.isEmpty || lineIndentation.hasPrefix(indentation + " ") || lineIndentation.hasPrefix(indentation + "\t") {
                scanLocation = NSMaxRange(lineRange)
                continue
            }

            break
        }
        textStorage.endEditing()
        if didRenumber {
            self.didChangeText()
        }
    }

    /// 查找行首的复选框
    private func findCheckboxAtLineStart(lineRange: NSRange) -> NSRange? {
        let attr = self.attributedString()
        let checkboxLocation = leadingWhitespaceBoundary(in: lineRange)

        // 检查行首字符
        if checkboxLocation >= attr.length { return nil }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        if normalizedCheckboxAttachment(at: checkboxLocation, effectiveRange: &effectiveRange) != nil {
            return effectiveRange
        }

        return nil
    }

    /// 查找行首的特定前缀
    private func findPrefixAtLineStart(lineRange: NSRange, prefix: String) -> NSRange? {
        let nsString = self.string as NSString
        let prefixLocation = leadingWhitespaceBoundary(in: lineRange)
        if prefixLocation >= nsString.length { return nil }

        let contentRange = NSRange(location: prefixLocation, length: NSMaxRange(lineRange) - prefixLocation)
        let lineContent = nsString.substring(with: contentRange)
        if lineContent.hasPrefix(prefix) {
            return NSRange(location: prefixLocation, length: prefix.utf16.count)
        }

        return nil
    }

    /// 查找行首的编号列表
    private func findNumberedListAtLineStart(lineRange: NSRange) -> (range: NSRange, number: Int)? {
        let nsString = self.string as NSString
        let prefixLocation = leadingWhitespaceBoundary(in: lineRange)
        if prefixLocation >= nsString.length { return nil }

        let contentRange = NSRange(location: prefixLocation, length: NSMaxRange(lineRange) - prefixLocation)
        let lineContent = nsString.substring(with: contentRange)
        let numberedPattern = "^(\\d+)\\. "

        if let regex = try? NSRegularExpression(pattern: numberedPattern),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {

            let fullRange = NSRange(location: prefixLocation, length: match.range.length)
            let numberRange = match.range(at: 1)
            let numberStr = (lineContent as NSString).substring(with: numberRange)

            if let number = Int(numberStr) {
                return (fullRange, number)
            }
        }

        return nil
    }
}
