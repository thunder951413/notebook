import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers

@MainActor
final class RichTextController: ObservableObject {
    fileprivate weak var textView: NSTextView?

    /// 用于跟踪当前选中的笔记（可能在视图更新前就变更）
    var currentNoteID: UUID?

    /// 编辑器实际绑定的笔记ID（只有视图重新渲染时才更新）
    private(set) var boundNoteID: UUID?

    /// 获取编辑器实际绑定的笔记ID（用于保存时确定目标）
    var actualNoteID: UUID? { boundNoteID }

    /// 检查编辑器是否为空（无内容或已释放）
    var isEmpty: Bool {
        guard let tv = textView else { return true }
        return tv.string.isEmpty
    }

    /// 检查当前编辑器内容是否属于指定笔记
    func isBoundTo(noteID: UUID) -> Bool {
        return boundNoteID == noteID && textView != nil
    }

    // MARK: - 定期自动保存

    /// 自动保存定时器
    private var autoSaveTimer: Timer?

    /// 上次保存的内容哈希（用于检测变化）
    private var lastSavedContentHash: Int?

    /// 启动定期自动保存（每30秒）
    func startAutoSave(interval: TimeInterval = 30.0, onSave: @escaping @MainActor () -> Void) {
        stopAutoSave()

        autoSaveTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            Task { @MainActor [weak self] in
                guard let self = self else { return }

                // 检查内容是否有变化
                if let currentContent = self.snapshotAttributedStringPreservingMarkedText() {
                    let currentHash = currentContent.string.hashValue

                    if self.lastSavedContentHash != currentHash {
                        self.lastSavedContentHash = currentHash
                        onSave()
                        print("[RichTextController] Auto-save triggered")
                    }
                }
            }
        }

        print("[RichTextController] Auto-save started with interval: \(interval)s")
    }

    /// 停止定期自动保存
    func stopAutoSave() {
        autoSaveTimer?.invalidate()
        autoSaveTimer = nil
        print("[RichTextController] Auto-save stopped")
    }

    /// 更新保存状态（在手动保存后调用）
    func markAsSaved() {
        if let currentContent = snapshotAttributedStringPreservingMarkedText() {
            lastSavedContentHash = currentContent.string.hashValue
        }
    }

    func bind(textView: NSTextView, noteID: UUID) {
        self.textView = textView
        self.boundNoteID = noteID
        self.currentNoteID = noteID
    }

    /// 检查是否有输入法正在编辑的 marked text
    var hasMarkedText: Bool {
        guard let tv = textView else { return false }
        guard let inputContext = tv.inputContext else { return false }
        return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
    }

    /// 强制同步内容并获取当前编辑器内容的快照
    /// - Returns: 编辑器内容，如果 textView 不可用则返回 nil（调用者应使用内存中的内容）
    func snapshotAttributedString() -> NSAttributedString? {
        guard let tv = textView else {
            print("[RichTextController] snapshot: textView is nil, returning nil to use memory content")
            return nil
        }
        
        let content = tv.attributedString()
        print("[RichTextController] snapshot: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)")
        
        // 强制结束输入法会话（防止中文输入未提交时内容丢失）
        if let inputContext = tv.inputContext {
            let hasMarked = (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
            if hasMarked {
                // 使用 performSelector 调用 commitComposition 避免编译器检查
                _ = inputContext.perform(NSSelectorFromString("commitComposition"))
            }
        }
        
        // 结束当前的编辑状态
        tv.breakUndoCoalescing()
        
        // 强制第一响应者状态更新
        if tv.window?.firstResponder === tv {
            tv.window?.makeFirstResponder(nil)
            tv.window?.makeFirstResponder(tv)
        }
        
        // 获取当前 attributedString 的副本
        return tv.attributedString().copy() as? NSAttributedString
    }
    
    /// 获取当前编辑器内容的快照（不结束输入法会话）
    func snapshotAttributedStringPreservingMarkedText() -> NSAttributedString? {
        guard let tv = textView else {
            // textView 为 nil 时静默返回，避免日志刷屏
            return nil
        }
        
        // 如果有 marked text，返回 nil 表示不应该保存
        if hasMarkedText {
            return nil
        }
        
        // 获取当前 attributedString 的副本
        return tv.attributedString().copy() as? NSAttributedString
    }

    /// 强制同步内容
    func forceSync() {
        guard let tv = textView else { return }
        tv.didChangeText()
    }

    /// 在当前光标位置插入文本
    func insertTextAtCursor(_ text: String) {
        guard let tv = textView else { return }
        let selectedRange = tv.selectedRange()
        let attributedText = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.systemFontSize)
        ])
        tv.textStorage?.insert(attributedText, at: selectedRange.location)
        tv.didChangeText()
        // 更新光标位置到插入文本之后
        let newLocation = selectedRange.location + text.utf16.count
        tv.setSelectedRange(NSRange(location: newLocation, length: 0))
    }

    func toggleBold() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 获取当前字体
        let currentFont = tv.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)

        // 切换粗体
        let newFont: NSFont
        if currentFont.fontDescriptor.symbolicTraits.contains(.bold) {
            newFont = NSFontManager.shared.convert(currentFont, toNotHaveTrait: .boldFontMask)
        } else {
            newFont = NSFontManager.shared.convert(currentFont, toHaveTrait: .boldFontMask)
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func toggleItalic() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 获取当前字体
        let currentFont = tv.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let fontSize = currentFont.pointSize

        // 切换斜体
        let fontManager = NSFontManager.shared
        let traits = fontManager.traits(of: currentFont)
        let newFont: NSFont
        if traits.contains(.italicFontMask) {
            // 移除斜体 - 使用系统常规字体
            newFont = NSFont.systemFont(ofSize: fontSize)
        } else {
            // 添加斜体 - 使用系统斜体字体
            newFont = NSFontManager.shared.font(withFamily: currentFont.familyName ?? ".AppleSystemUIFont",
                                                 traits: [.italicFontMask],
                                                 weight: fontManager.weight(of: currentFont),
                                                 size: fontSize)
                ?? NSFontManager.shared.convert(NSFont.systemFont(ofSize: fontSize), toHaveTrait: .italicFontMask)
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func toggleUnderline() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 检查是否已有下划线
        let attributes = tv.textStorage?.attributes(at: range.location, effectiveRange: nil)
        let hasUnderline = attributes?[.underlineStyle] != nil

        tv.textStorage?.beginEditing()
        if hasUnderline {
            tv.textStorage?.removeAttribute(.underlineStyle, range: range)
        } else {
            tv.textStorage?.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
        }
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func setHeading(level: Int) {
        guard let tv = textView else { return }
        let size: CGFloat
        switch level {
        case 1: size = 22
        case 2: size = 18
        default: size = 16
        }
        let range = tv.selectedRange()
        tv.textStorage?.addAttributes([
            .font: NSFont.systemFont(ofSize: size, weight: .semibold)
        ], range: range.length == 0 ? NSRange(location: 0, length: tv.string.utf16.count) : range)
    }

    func toggleCheckbox() {
        guard let tv = textView else { return }
        tv.toggleCheckboxForCurrentLine()
    }

    func toggleCheckbox(at location: Int) -> Bool {
        guard let tv = textView else { return false }
        return tv.toggleCheckbox(at: location)
    }

    // MARK: - 缩进功能

    func increaseIndent() {
        guard let tv = textView else { return }
        let nsString = tv.string as NSString
        let selectedRange = tv.selectedRange()
        let lineRange = nsString.lineRange(for: selectedRange)

        // 在行首插入制表符或空格
        let indentString = "    " // 4个空格
        tv.textStorage?.insert(NSAttributedString(string: indentString), at: lineRange.location)
        tv.didChangeText()

        // 调整选中范围
        let newLocation = selectedRange.location + indentString.count
        tv.setSelectedRange(NSRange(location: newLocation, length: selectedRange.length))
    }

    func decreaseIndent() {
        guard let tv = textView else { return }
        let nsString = tv.string as NSString
        let selectedRange = tv.selectedRange()
        let lineRange = nsString.lineRange(for: selectedRange)

        // 检查行首是否有缩进
        let lineContent = nsString.substring(with: lineRange)
        let leadingWhitespace = lineContent.prefix { $0 == " " || $0 == "\t" }

        if !leadingWhitespace.isEmpty {
            // 删除最多4个空格或1个制表符
            let deleteCount = min(leadingWhitespace.count, 4)
            let deleteRange = NSRange(location: lineRange.location, length: deleteCount)

            tv.textStorage?.deleteCharacters(in: deleteRange)
            tv.didChangeText()

            // 调整选中范围
            let newLocation = max(lineRange.location, selectedRange.location - deleteCount)
            tv.setSelectedRange(NSRange(location: newLocation, length: selectedRange.length))
        }
    }

    // MARK: - 列表功能增强

    /// 切换短划线列表
    func toggleDashList() {
        toggleListType(prefix: "- ")
    }

    /// 切换项目符号列表
    func toggleBullets() {
        toggleListType(prefix: "• ")
    }

    /// 切换编号列表
    func toggleNumberedList() {
        guard let tv = textView else { return }
        let nsString = tv.string as NSString
        let selectedRange = tv.selectedRange()
        let lineRange = nsString.lineRange(for: selectedRange)

        // 检查是否已经有编号
        let lineContent = nsString.substring(with: lineRange)
        let numberedPattern = "^\\d+\\. "

        if let regex = try? NSRegularExpression(pattern: numberedPattern),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {
            // 移除编号
            let deleteRange = NSRange(location: lineRange.location, length: match.range.length)
            tv.textStorage?.deleteCharacters(in: deleteRange)
            tv.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location - match.range.length
            tv.setSelectedRange(NSRange(location: max(lineRange.location, newLocation), length: 0))
        } else {
            // 移除其他列表前缀
            removeOtherListPrefixes(tv: tv, lineRange: lineRange)

            // 添加编号 "1. "
            tv.textStorage?.insert(NSAttributedString(string: "1. "), at: lineRange.location)
            tv.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location + 3
            tv.setSelectedRange(NSRange(location: newLocation, length: 0))
        }
    }

    /// 通用列表切换方法
    private func toggleListType(prefix: String) {
        guard let tv = textView else { return }
        let nsString = tv.string as NSString
        let selectedRange = tv.selectedRange()
        let lineRange = nsString.lineRange(for: selectedRange)

        // 检查是否已经有该前缀
        let lineContent = nsString.substring(with: lineRange)

        if lineContent.hasPrefix(prefix) {
            // 移除前缀
            let deleteRange = NSRange(location: lineRange.location, length: prefix.count)
            tv.textStorage?.deleteCharacters(in: deleteRange)
            tv.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location - prefix.count
            tv.setSelectedRange(NSRange(location: max(lineRange.location, newLocation), length: 0))
        } else {
            // 移除其他列表前缀
            removeOtherListPrefixes(tv: tv, lineRange: lineRange)

            // 添加前缀
            tv.textStorage?.insert(NSAttributedString(string: prefix), at: lineRange.location)
            tv.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location + prefix.count
            tv.setSelectedRange(NSRange(location: newLocation, length: 0))
        }
    }

    /// 移除其他列表前缀（避免混合列表类型）
    private func removeOtherListPrefixes(tv: NSTextView, lineRange: NSRange) {
        let nsString = tv.string as NSString
        let lineContent = nsString.substring(with: lineRange)

        let prefixes = ["• ", "- ", "1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. ", "9. "]

        for prefix in prefixes {
            if lineContent.hasPrefix(prefix) {
                let deleteRange = NSRange(location: lineRange.location, length: prefix.count)
                tv.textStorage?.deleteCharacters(in: deleteRange)
                return
            }
        }

        // 检查编号模式 (数字+点+空格)
        let numberedPattern = "^\\d+\\. "
        if let regex = try? NSRegularExpression(pattern: numberedPattern),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {
            let deleteRange = NSRange(location: lineRange.location, length: match.range.length)
            tv.textStorage?.deleteCharacters(in: deleteRange)
        }
    }

    // MARK: - 文本样式

    func toggleStrikethrough() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        if range.length == 0 { return }

        // 检查是否已经有删除线
        let attributes = tv.textStorage?.attributes(at: range.location, effectiveRange: nil)
        let hasStrikethrough = attributes?[.strikethroughStyle] != nil

        tv.textStorage?.beginEditing()
        if hasStrikethrough {
            tv.textStorage?.removeAttribute(.strikethroughStyle, range: range)
        } else {
            tv.textStorage?.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
        }
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func clearFormatting() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 检查范围是否有效
        let textLength = tv.string.utf16.count
        guard range.location >= 0, range.location + range.length <= textLength else {
            print("[RichTextController] clearFormatting: invalid range \(range), text length \(textLength)")
            return
        }

        let defaultFont = NSFont.systemFont(ofSize: NSFont.systemFontSize)

        tv.textStorage?.beginEditing()

        // 遍历选中范围内的每个字符，保留段落样式，只清除字体格式
        var currentLocation = range.location
        let endLocation = range.location + range.length

        while currentLocation < endLocation {
            // 检查 textStorage 是否仍然有效
            guard let textStorage = tv.textStorage else { break }

            var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
            let attributes = textStorage.attributes(at: currentLocation, effectiveRange: &effectiveRange)

            // 限制在当前选中范围内
            var actualRange = effectiveRange
            if actualRange.location < range.location {
                let offset = range.location - actualRange.location
                actualRange.location = range.location
                actualRange.length -= offset
            }
            if actualRange.location + actualRange.length > endLocation {
                actualRange.length = endLocation - actualRange.location
            }

            // 确保范围有效
            guard actualRange.length > 0 else { break }

            // 保留段落样式，只更新字体
            var newAttributes: [NSAttributedString.Key: Any] = [:]
            if let paragraphStyle = attributes[.paragraphStyle] {
                newAttributes[.paragraphStyle] = paragraphStyle
            }
            newAttributes[.font] = defaultFont

            textStorage.setAttributes(newAttributes, range: actualRange)

            currentLocation = actualRange.location + actualRange.length
        }

        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func insertImage() {
        guard let tv = textView, let noteID = currentNoteID else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .tiff, .heic, .gif]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: url, noteID: noteID, kind: .image)
                let attachment = AttachmentTextAttachment(fileURL: destURL, kind: .image)
                let attr = NSAttributedString(attachment: attachment)
                tv.textStorage?.insert(attr, at: tv.selectedRange().location)
                tv.didChangeText()
            } catch {
                print("Failed to insert image: \(error)")
            }
        }
    }

    func insertAudio(from fileURL: URL) {
        guard let tv = textView else { return }
        let attachment = AudioBlockAttachment(fileURL: fileURL)
        let attr = NSAttributedString(attachment: attachment)
        tv.textStorage?.insert(attr, at: tv.selectedRange().location)
        tv.didChangeText()
    }

    func insertAudio() {
        guard let noteID = currentNoteID else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.mp3, UTType.wav, UTType.mpeg4Audio, UTType.aiff]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: url, noteID: noteID, kind: .audio)
                insertAudio(from: destURL)
            } catch {
                print("Failed to insert audio: \(error)")
            }
        }
    }

    private func insertText(_ text: String) {
        guard let tv = textView else { return }
        tv.insertText(text, replacementRange: tv.selectedRange())
        tv.didChangeText()
    }

    private func prefixSelectedLines(with prefix: String) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let sel = tv.selectedRange()
        let lineRange = ns.lineRange(for: sel)
        
        var result = ""
        ns.enumerateSubstrings(in: lineRange, options: [.byLines, .substringNotRequired]) { _, subRange, _, _ in
            result += prefix + ns.substring(with: subRange) + "\n"
        }
        if result.hasSuffix("\n") { result.removeLast() }

        tv.textStorage?.replaceCharacters(in: lineRange, with: result)
        tv.setSelectedRange(NSRange(location: lineRange.location, length: result.utf16.count))
        tv.didChangeText()
    }

    // MARK: - 快捷键支持方法

    /// 切换项目符号列表（供快捷键使用）
    func toggleBulletList() {
        toggleBullets()
    }

    /// 聚焦编辑器
    func focus() {
        textView?.becomeFirstResponder()
    }

    private func prefixSelectedLines(withNumbering: Bool) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let sel = tv.selectedRange()
        let lineRange = ns.lineRange(for: sel)

        var i = 1
        var result = ""
        ns.enumerateSubstrings(in: lineRange, options: [.byLines, .substringNotRequired]) { _, subRange, _, _ in
            result += "\(i). " + ns.substring(with: subRange) + "\n"
            i += 1
        }
        if result.hasSuffix("\n") { result.removeLast() }

        tv.textStorage?.replaceCharacters(in: lineRange, with: result)
        tv.setSelectedRange(NSRange(location: lineRange.location, length: result.utf16.count))
        tv.didChangeText()
    }
}

extension NSTextView {
    func richTextToolbarAction(_ selector: Selector) {
        NSApp.sendAction(selector, to: nil, from: self)
    }
}

// MARK: - 粘贴图片支持

/// 粘贴协调器协议
protocol PasteCoordinatorProtocol: AnyObject {
    func handlePaste(in textView: NSTextView) -> Bool
}

/// 自定义 NSTextView 以支持图片粘贴
class RichTextView: NSTextView {
    weak var pasteCoordinator: PasteCoordinatorProtocol?

    override func paste(_ sender: Any?) {
        print("[RichTextView] paste(_:) called, pasteCoordinator: \(pasteCoordinator != nil ? "set" : "nil")")
        // 首先尝试让 coordinator 处理图片粘贴
        if let coordinator = pasteCoordinator {
            if coordinator.handlePaste(in: self) {
                // 图片粘贴成功，不调用父类方法
                print("[RichTextView] Image paste handled by coordinator")
                return
            }
        }
        // 如果不是图片，调用标准粘贴
        print("[RichTextView] Falling back to super.paste")
        super.paste(sender)
    }

    // 处理拖放粘贴
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        print("[RichTextView] readSelection(from:type:) called, type: \(type)")
        return super.readSelection(from: pboard, type: type)
    }
    
    // 处理拖放操作
    override func performDragOperation(_ draggingInfo: NSDraggingInfo) -> Bool {
        print("[RichTextView] performDragOperation called")
        
        let pasteboard = draggingInfo.draggingPasteboard
        
        // 尝试读取文件URL
        if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           !fileURLs.isEmpty {
            let fileURL = fileURLs[0]
            let imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "heic", "webp"]
            let ext = fileURL.pathExtension.lowercased()
            
            if imageExtensions.contains(ext) {
                print("[RichTextView] Dropped image file: \(fileURL)")
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
            print("[RichTextView] validateMenuItem for paste")
            return true
        }
        return super.validateMenuItem(menuItem)
    }

    // 处理鼠标点击事件 - 用于切换复选框
    override func mouseDown(with event: NSEvent) {
        let point = self.convert(event.locationInWindow, from: nil)

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
            guard startIndex <= endIndex else { return }

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

        super.mouseDown(with: event)
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

        // 检查是否是 ESC 键
        if event.keyCode == 53 { // 53 = Escape
            if hasInputMarkedText() {
                clearInputMarkedText()
                return
            }
        }

        super.keyDown(with: event)
    }

    private func hasInputMarkedText() -> Bool {
        guard let inputContext = self.inputContext else { return false }
        return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
    }

    private func clearInputMarkedText() {
        let markedRange = self.markedRange()
        guard markedRange.location != NSNotFound, markedRange.length > 0 else { return }
        
        self.textStorage?.deleteCharacters(in: markedRange)
        self.setSelectedRange(NSRange(location: markedRange.location, length: 0))
    }

    private func commitMarkedTextIfNeeded() -> Bool {
        let markedRange = self.markedRange()
        guard markedRange.location != NSNotFound, markedRange.length > 0 else { return false }
        
        let fullString = self.string as NSString
        var markedString = fullString.substring(with: markedRange)
        
        markedString = markedString.replacingOccurrences(of: "'", with: "")
        
        self.textStorage?.beginEditing()
        self.textStorage?.deleteCharacters(in: markedRange)
        self.textStorage?.endEditing()
        
        self.insertText(markedString, replacementRange: NSRange(location: markedRange.location, length: 0))
        
        return true
    }

    /// 处理回车键 - 自动继承列表符号
    private func handleReturnKey() -> Bool {
        let nsString = self.string as NSString
        let selectedRange = self.selectedRange()
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

        return false
    }

    /// 处理复选框回车
    private func handleCheckboxReturn(checkboxRange: NSRange, currentLineRange: NSRange, nsString: NSString) -> Bool {
        // 检查当前行是否只有复选框（空行）
        let contentAfterCheckbox = nsString.substring(with: NSRange(location: checkboxRange.upperBound, length: currentLineRange.upperBound - checkboxRange.upperBound))
        let trimmedContent = contentAfterCheckbox.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedContent.isEmpty {
            // 空行，删除复选框
            let deleteRange = NSRange(location: checkboxRange.location, length: checkboxRange.length + 1) // +1 for space
            self.textStorage?.deleteCharacters(in: deleteRange)
            self.insertNewline(nil)
            self.didChangeText()
            return true
        } else {
            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入复选框（未选中状态）
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let newAttachment = CheckboxTextAttachment(checked: false)
            let attrString = NSAttributedString(attachment: newAttachment)
            let mutableAttr = NSMutableAttributedString(attributedString: attrString)
            mutableAttr.append(NSAttributedString(string: " "))

            self.textStorage?.insert(mutableAttr, at: newLineRange.location)
            self.didChangeText()
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
            self.textStorage?.deleteCharacters(in: deleteRange)
            self.insertNewline(nil)
            self.didChangeText()
            return true
        } else {
            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入相同的前缀
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            self.textStorage?.insert(NSAttributedString(string: prefix), at: newLineRange.location)
            self.didChangeText()
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
            self.textStorage?.deleteCharacters(in: deleteRange)
            self.insertNewline(nil)
            self.didChangeText()
            return true
        } else {
            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入下一个编号
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let nextNumber = currentNumber + 1
            let newPrefix = "\(nextNumber). "
            self.textStorage?.insert(NSAttributedString(string: newPrefix), at: newLineRange.location)
            self.didChangeText()
            return true
        }
    }

    /// 查找行首的复选框
    private func findCheckboxAtLineStart(lineRange: NSRange) -> NSRange? {
        let attr = self.attributedString()

        // 检查行首字符
        if lineRange.location >= attr.length { return nil }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        if attr.attribute(.attachment, at: lineRange.location, effectiveRange: &effectiveRange) is CheckboxTextAttachment {
            return effectiveRange
        }

        return nil
    }

    /// 查找行首的特定前缀
    private func findPrefixAtLineStart(lineRange: NSRange, prefix: String) -> NSRange? {
        let nsString = self.string as NSString
        if lineRange.location >= nsString.length { return nil }

        let lineContent = nsString.substring(with: lineRange)
        if lineContent.hasPrefix(prefix) {
            return NSRange(location: lineRange.location, length: prefix.utf16.count)
        }

        return nil
    }

    /// 查找行首的编号列表
    private func findNumberedListAtLineStart(lineRange: NSRange) -> (range: NSRange, number: Int)? {
        let nsString = self.string as NSString
        if lineRange.location >= nsString.length { return nil }

        let lineContent = nsString.substring(with: lineRange)
        let numberedPattern = "^(\\d+)\\. "

        if let regex = try? NSRegularExpression(pattern: numberedPattern),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {

            let fullRange = NSRange(location: lineRange.location, length: match.range.length)
            let numberRange = match.range(at: 1)
            let numberStr = (lineContent as NSString).substring(with: numberRange)

            if let number = Int(numberStr) {
                return (fullRange, number)
            }
        }

        return nil
    }
}

struct RichTextEditor: NSViewRepresentable {
    @Binding var attributedText: NSAttributedString
    let controller: RichTextController
    @Environment(\.colorScheme) var colorScheme

    /// 当前显示的笔记 ID，用来判断是否发生了“切换笔记”（从而强制刷新内容）
    let noteID: UUID

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.autoresizingMask = [.width, .height]
        
        let scheme = colorScheme
        scroll.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        let textView = RichTextView()
        textView.isRichText = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = true
        textView.textContainerInset = NSSize(width: 12, height: 12)

        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]

        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)

        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = (scheme == .dark) ? .white : .black
        textView.font = NSFont.systemFont(ofSize: 15)
        textView.delegate = context.coordinator
        textView.pasteCoordinator = context.coordinator
        
        textView.textStorage?.setAttributedString(attributedText)

        textView.isSelectable = true
        textView.isEditable = true

        // 注册拖放类型以支持图片拖放
        textView.registerForDraggedTypes([.fileURL, .png, .tiff, NSPasteboard.PasteboardType("NSFilenamesPboardType")])

        scroll.documentView = textView
        controller.bind(textView: textView, noteID: noteID)

        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? RichTextView else { return }

        // 确保 pasteCoordinator 始终是最新的
        textView.pasteCoordinator = context.coordinator

        let scheme = colorScheme
        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = (scheme == .dark) ? .white : .black
        nsView.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        // 关键：切换笔记时强制刷新内容；同一笔记编辑时避免 update 覆盖用户输入。
        if context.coordinator.lastAppliedNoteID != noteID {
            print("[RichTextEditor] Switching note: \(context.coordinator.lastAppliedNoteID?.uuidString.prefix(8) ?? "nil") -> \(noteID.uuidString.prefix(8))")
            print("[RichTextEditor] attributedText length: \(attributedText.length), content: '\(String(attributedText.string.prefix(20)))'")
            print("[RichTextEditor] textView current length: \(textView.string.count)")

            context.coordinator.isProgrammaticUpdate = true
            context.coordinator.lastAppliedNoteID = noteID

            // 清除撤销管理器，避免切换笔记后撤销操作导致崩溃
            textView.undoManager?.removeAllActions()

            textView.textStorage?.setAttributedString(attributedText)
            textView.setSelectedRange(NSRange(location: 0, length: 0))

            context.coordinator.isProgrammaticUpdate = false

            // 只有在内容实际更新后才绑定新的 noteID
            controller.bind(textView: textView, noteID: noteID)

            print("[RichTextEditor] After update - textView length: \(textView.string.count)")
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(attributedText: $attributedText, controller: controller)
    }

    final class Coordinator: NSObject, NSTextViewDelegate, PasteCoordinatorProtocol {
        @Binding var attributedText: NSAttributedString
        var isProgrammaticUpdate = false
        var lastAppliedNoteID: UUID?
        weak var controller: RichTextController?
        
        /// 标记是否有正在进行的输入法编辑会话
        private var hasMarkedText = false
        /// 延迟更新的内容
        private var pendingContent: NSAttributedString?

        init(attributedText: Binding<NSAttributedString>, controller: RichTextController) {
            _attributedText = attributedText
            self.controller = controller
        }
        
        /// 检查是否有 marked text（输入法正在编辑）
        private func checkHasMarkedText(_ textView: NSTextView) -> Bool {
            guard let inputContext = textView.inputContext else { return false }
            // 使用 KVC 获取 hasMarkedText 属性
            return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
        }
        
        /// 执行实际的绑定更新
        private func flushPendingContent() {
            guard let content = pendingContent else { return }
            self.attributedText = content
            pendingContent = nil
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if isProgrammaticUpdate {
                return
            }
            
            // 使用 copy() 确保这是一个全新的实例，避免多线程竞争和 SwiftUI 更新失效
            guard let content = tv.attributedString().copy() as? NSAttributedString else { return }
            
            // 检查是否有输入法正在编辑的 marked text
            if checkHasMarkedText(tv) {
                // 输入法正在编辑，延迟更新绑定
                hasMarkedText = true
                pendingContent = content
                return
            }
            
            // 没有 marked text，直接更新
            hasMarkedText = false
            pendingContent = nil
            self.attributedText = content
        }
        
        // NSTextViewDelegate 方法：处理输入法文本选择变化
        func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
            // 允许所有更改通过
            return true
        }
        
        // 监听输入法标记文本的变化
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            
            // 如果之前有 marked text，现在没有了，说明输入法已提交
            if hasMarkedText && !checkHasMarkedText(tv) {
                hasMarkedText = false
                flushPendingContent()
            }
        }
        
        // MARK: - 粘贴图片支持
        
        /// 处理粘贴操作，支持粘贴图片和文件
        func handlePaste(in textView: NSTextView) -> Bool {
            print("[Coordinator] handlePaste called")
            let pasteboard = NSPasteboard.general

            // 获取当前笔记ID
            guard let noteID = controller?.currentNoteID else {
                print("[Coordinator] No noteID available")
                return false
            }
            print("[Coordinator] noteID: \(noteID.uuidString.prefix(8))")

            // 打印剪贴板类型信息
            let types = pasteboard.types ?? []
            print("[Coordinator] Pasteboard types: \(types)")

            // 1. 首先尝试读取文件URL（从Finder复制的文件）- 优先处理原文件
            if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
               !fileURLs.isEmpty {
                print("[Coordinator] File URLs found: \(fileURLs)")
                // 只处理第一个文件
                let fileURL = fileURLs[0]

                // 检查是否是图片文件
                let imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "heic", "webp"]
                let ext = fileURL.pathExtension.lowercased()

                if imageExtensions.contains(ext) {
                    print("[Coordinator] Image file detected: \(ext)")
                    // 是图片文件，复制到附件目录
                    do {
                        let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: fileURL, noteID: noteID, kind: .image)
                        insertAttachment(at: destURL, kind: .image, in: textView)
                        return true
                    } catch {
                        print("[Coordinator] Failed to copy image file: \(error)")
                        return false
                    }
                }
                print("[Coordinator] Not an image file: \(ext)")
                // 其他类型文件不处理，返回false让系统处理
                return false
            }

            // 2. 尝试读取图片数据（截图或复制的图片数据）
            if let image = readImageFromPasteboard(pasteboard) {
                print("[Coordinator] Image data found in pasteboard")
                do {
                    let destURL = try savePastedImage(image: image, noteID: noteID)
                    insertAttachment(at: destURL, kind: .image, in: textView)
                    return true
                } catch {
                    print("[Coordinator] Failed to save pasted image: \(error)")
                    return false
                }
            }
            print("[Coordinator] No image found in pasteboard")

            // 如果不是图片或文件，返回false让系统处理其他粘贴类型
            print("[Coordinator] No file URLs found, falling back to default paste")
            return false
        }
        
        /// 从剪贴板读取图片数据（支持多种格式）
        private func readImageFromPasteboard(_ pasteboard: NSPasteboard) -> NSImage? {
            // 尝试直接读取NSImage
            if let image = NSImage(pasteboard: pasteboard) {
                return image
            }
            
            // 尝试读取TIFF数据
            if let tiffData = pasteboard.data(forType: .tiff),
               let image = NSImage(data: tiffData) {
                return image
            }
            
            // 尝试读取PNG数据
            if let pngData = pasteboard.data(forType: .png),
               let image = NSImage(data: pngData) {
                return image
            }
            
            // 尝试读取JPEG数据
            if let jpegData = pasteboard.data(forType: NSPasteboard.PasteboardType("public.jpeg")),
               let image = NSImage(data: jpegData) {
                return image
            }
            
            // 尝试从fileURL读取（某些截图工具会写入临时文件URL）
            if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
               let firstURL = fileURLs.first {
                let imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "heic", "webp"]
                if imageExtensions.contains(firstURL.pathExtension.lowercased()) {
                    return NSImage(contentsOf: firstURL)
                }
            }
            
            return nil
        }
        
        /// 处理拖放的图片文件
        func handleDroppedImage(fileURL: URL, in textView: NSTextView) -> Bool {
            print("[Coordinator] handleDroppedImage called: \(fileURL)")
            
            guard let noteID = controller?.currentNoteID else {
                print("[Coordinator] No noteID available for drop")
                return false
            }
            
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: fileURL, noteID: noteID, kind: .image)
                insertAttachment(at: destURL, kind: .image, in: textView)
                print("[Coordinator] Dropped image handled successfully")
                return true
            } catch {
                print("[Coordinator] Failed to handle dropped image: \(error)")
                return false
            }
        }
        
        /// 插入附件到文本视图
        private func insertAttachment(at fileURL: URL, kind: AttachmentKind, in textView: NSTextView) {
            let attachment = AttachmentTextAttachment(fileURL: fileURL, kind: kind)
            let attr = NSAttributedString(attachment: attachment)
            
            let selectedRange = textView.selectedRange()
            textView.textStorage?.insert(attr, at: selectedRange.location)
            textView.didChangeText()
            
            // 触发绑定更新
            if let content = textView.attributedString().copy() as? NSAttributedString {
                self.attributedText = content
            }
        }
        
        /// 保存粘贴的图片到附件目录
        private func savePastedImage(image: NSImage, noteID: UUID) throws -> URL {
            let location = StorageLocationManager.shared
            guard let base = location.baseDirectoryURL else {
                throw NSError(domain: "AttachmentManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
            }
            
            return try location.withSecurityScopedAccess(base) {
                try location.ensureDirectoryStructureExists()
                
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                
                let filename = UUID().uuidString + ".png"
                let dest = folder.appendingPathComponent(filename, isDirectory: false)
                
                // 将NSImage转换为PNG数据并保存
                guard let tiffData = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiffData),
                      let pngData = bitmap.representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "AttachmentManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法转换图片格式"])
                }
                
                try pngData.write(to: dest)
                return dest
            }
        }
    }
}
