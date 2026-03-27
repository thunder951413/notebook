import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers
import AVFoundation

@MainActor
final class RichTextController: ObservableObject {
    private struct SavedNoteState {
        let titleHash: Int
        let contentHash: Int
    }

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
    private var savedStates: [UUID: SavedNoteState] = [:]

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

    func recordSavedState(noteID: UUID, title: String, content: NSAttributedString) {
        savedStates[noteID] = SavedNoteState(
            titleHash: title.hashValue,
            contentHash: content.hashValue
        )
        if currentNoteID == noteID || boundNoteID == noteID {
            lastSavedContentHash = content.string.hashValue
        }
    }

    func hasUnsavedChanges(noteID: UUID, title: String, content: NSAttributedString) -> Bool {
        guard let savedState = savedStates[noteID] else { return true }
        return savedState.titleHash != title.hashValue || savedState.contentHash != content.hashValue
    }

    func bind(textView: NSTextView, noteID: UUID) {
        self.textView = textView
        self.boundNoteID = noteID
        self.currentNoteID = noteID
    }

    func attachmentTargetNoteID() -> UUID? {
        AttachmentTargetNoteResolver.resolve(
            boundNoteID: boundNoteID,
            currentNoteID: currentNoteID,
            hasActiveTextView: textView != nil
        )
    }

    /// 检查是否有输入法正在编辑的 marked text
    var hasMarkedText: Bool {
        guard let tv = textView else { return false }
        guard let inputContext = tv.inputContext else { return false }
        return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
    }

    var requiresCommittedSnapshotOnSwitch: Bool {
        guard let tv = textView else { return false }
        if hasMarkedText {
            return true
        }
        guard let richTextView = tv as? RichTextView else { return false }
        return richTextView.hasActiveTableEditor
    }

    /// 强制同步内容并获取当前编辑器内容的快照
    /// - Returns: 编辑器内容，如果 textView 不可用则返回 nil（调用者应使用内存中的内容）
    func snapshotAttributedString() -> NSAttributedString? {
        guard let tv = textView else {
            print("[RichTextController] snapshot: textView is nil, returning nil to use memory content")
            return nil
        }

        // 确保表格内联编辑器已写回附件
        if let richTextView = tv as? RichTextView {
            richTextView.finalizeActiveTableEditorIfNeeded()
        }

        // 保存前强制修正表格附件的 fileType，避免 appBlur 变成文件图标
        if let textStorage = tv.textStorage {
            let range = NSRange(location: 0, length: textStorage.length)
            textStorage.enumerateAttribute(.attachment, in: range, options: []) { value, _, _ in
                if let tableAttachment = value as? TableTextAttachment {
                    if tableAttachment.fileType == nil || tableAttachment.fileType?.hasPrefix("dyn.") == true {
                        tableAttachment.fileType = "com.notebook.table"
                    }
                    tableAttachment.updateImage()
                }
            }
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

        // 注意：不要在这里切换 firstResponder，避免 appBlur 阶段触发临时空快照
        // 直接返回当前内容副本
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

    func snapshotAttributedStringForSwitch() -> NSAttributedString? {
        guard let tv = textView else { return nil }

        if let richTextView = tv as? RichTextView, richTextView.hasActiveTableEditor {
            richTextView.finalizeActiveTableEditorIfNeeded()
        }

        if let inputContext = tv.inputContext {
            let hasMarked = (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
            if hasMarked {
                _ = inputContext.perform(NSSelectorFromString("commitComposition"))
            }
        }

        tv.breakUndoCoalescing()
        return tv.attributedString().copy() as? NSAttributedString
    }

    /// 强制同步内容
    func forceSync() {
        guard let tv = textView else { return }
        tv.didChangeText()
    }

    /// 获取当前选中区域的字体信息
    func getSelectedFontInfo() -> (name: String, size: CGFloat)? {
        guard let tv = textView else { return nil }
        let range = tv.selectedRange()
        if range.length == 0 { return nil }

        guard let font = tv.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont else {
            return nil
        }

        return (font.fontName, font.pointSize)
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
        let targetRange = range.length == 0 ? NSRange(location: 0, length: tv.string.utf16.count) : range
        tv.textStorage?.addAttributes([
            .font: NSFont.systemFont(ofSize: size, weight: .semibold),
            .notebookHeadingLevel: level
        ], range: targetRange)
    }

    // MARK: - 字体设置

    /// 设置选中区域的字体
    func setFont(name: String) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 获取当前字体
        let currentFont = tv.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let fontSize = currentFont.pointSize

        // 创建新字体
        let newFont: NSFont
        if name == "System" {
            newFont = NSFont.systemFont(ofSize: fontSize)
        } else {
            newFont = NSFont(name: name, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize)
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    /// 设置选中区域的字号
    func setFontSize(_ size: CGFloat) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()
        if range.length == 0 { return }

        // 获取当前字体
        let currentFont = tv.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)

        // 创建新字体，保持其他属性
        let fontManager = NSFontManager.shared
        let newFont = fontManager.convert(currentFont, toSize: size)

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    /// 设置选中区域的字体颜色
    func setFontColor(_ color: NSColor) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        var typingAttributes = tv.typingAttributes
        typingAttributes[.foregroundColor] = color
        tv.typingAttributes = typingAttributes

        if range.length == 0 { return }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.foregroundColor, value: color, range: range)
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    /// 获取选中区域的字体颜色
    func getSelectedFontColor() -> NSColor? {
        guard let tv = textView,
              let textStorage = tv.textStorage else { return nil }
        let range = tv.selectedRange()
        if range.length == 0 { return nil }

        var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
        let color = textStorage.attribute(.foregroundColor, at: range.location, effectiveRange: &effectiveRange) as? NSColor
        return color
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
        guard let tv = textView else {
            print("[RichTextController] clearFormatting: textView is nil")
            return
        }
        let range = tv.selectedRange()
        if range.length == 0 {
            print("[RichTextController] clearFormatting: no selection")
            return
        }

        // 检查范围是否有效
        let textLength = tv.string.utf16.count
        guard range.location >= 0, range.location + range.length <= textLength else {
            print("[RichTextController] clearFormatting: invalid range \(range), text length \(textLength)")
            return
        }

        // 从临近文字获取格式（优先从选中范围前的文字获取，如果没有则从后的文字获取）
        let (inheritedFont, inheritedColor) = getFormatFromNearbyText(for: range, in: tv)
        
        // 如果没有继承到格式，使用默认字体
        let targetFont = inheritedFont ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)

        tv.textStorage?.beginEditing()

        // 遍历选中范围内的每个字符，保留段落样式，应用继承的格式
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

            // 保留段落样式，应用继承的格式
            var newAttributes: [NSAttributedString.Key: Any] = [:]
            if let paragraphStyle = attributes[.paragraphStyle] {
                newAttributes[.paragraphStyle] = paragraphStyle
            }
            newAttributes[.font] = targetFont
            
            // 应用继承的颜色（如果有）
            if let color = inheritedColor {
                newAttributes[.foregroundColor] = color
            }

            textStorage.setAttributes(newAttributes, range: actualRange)

            currentLocation = actualRange.location + actualRange.length
        }

        tv.textStorage?.endEditing()
        tv.didChangeText()
    }
    
    /// 从临近文字获取格式（用于清除格式时继承）
    private func getFormatFromNearbyText(for range: NSRange, in textView: NSTextView) -> (font: NSFont?, color: NSColor?) {
        guard let textStorage = textView.textStorage else { return (nil, nil) }
        
        var font: NSFont?
        var color: NSColor?
        
        // 优先从选中范围前的文字获取格式
        if range.location > 0 {
            let previousLocation = range.location - 1
            if previousLocation < textStorage.length {
                var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
                
                // 获取字体
                font = textStorage.attribute(.font, at: previousLocation, effectiveRange: &effectiveRange) as? NSFont
                
                // 获取颜色
                color = textStorage.attribute(.foregroundColor, at: previousLocation, effectiveRange: &effectiveRange) as? NSColor
            }
        }
        
        // 如果前面没有文字，尝试从选中范围后的文字获取
        if font == nil && color == nil {
            let nextLocation = range.location + range.length
            if nextLocation < textStorage.length {
                var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
                
                // 获取字体
                font = textStorage.attribute(.font, at: nextLocation, effectiveRange: &effectiveRange) as? NSFont
                
                // 获取颜色
                color = textStorage.attribute(.foregroundColor, at: nextLocation, effectiveRange: &effectiveRange) as? NSColor
            }
        }
        
        return (font, color)
    }

    func insertImage() {
        guard let tv = textView, let noteID = attachmentTargetNoteID() else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .tiff, .heic, .gif]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: url, noteID: noteID, kind: .image)
                let attachment = AttachmentTextAttachment(fileURL: destURL, kind: .image)
                let mutableAttr = NSMutableAttributedString(attachment: attachment)
                let imageLink = imageMetadataLink(for: destURL, size: attachment.bounds.size)
                mutableAttr.addAttribute(.link, value: imageLink, range: NSRange(location: 0, length: mutableAttr.length))
                tv.textStorage?.insert(mutableAttr, at: tv.selectedRange().location)
                tv.didChangeText()
            } catch {
                print("Failed to insert image: \(error)")
            }
        }
    }

    private func imageMetadataLink(for fileURL: URL, size: CGSize) -> String {
        let w = max(1, Int(size.width.rounded()))
        let h = max(1, Int(size.height.rounded()))
        return "notebook-image://\(fileURL.absoluteString)#w=\(w)&h=\(h)"
    }

    func insertAudio(from fileURL: URL) {
        guard let tv = textView else { return }
        
        // 获取音频时长
        var duration: TimeInterval = 0
        do {
            let player = try AVAudioPlayer(contentsOf: fileURL)
            duration = player.duration
        } catch {
            print("[RichTextEditor] 无法获取音频时长: \(error)")
        }
        
        let attachment = AudioBlockAttachment(fileURL: fileURL, duration: duration, createDate: Date())
        let attr = NSMutableAttributedString(attachment: attachment)
        // 给附件字符挂一个可持久化 link，重启后可直接按 URL 识别并播放
        attr.addAttribute(.link, value: fileURL, range: NSRange(location: 0, length: attr.length))
        // 在音频后添加换行
        attr.append(NSAttributedString(string: "\n"))
        tv.textStorage?.insert(attr, at: tv.selectedRange().location)
        tv.didChangeText()
    }

    func insertAudio() {
        guard let noteID = attachmentTargetNoteID() else { return }
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

    func insertTable(rows: Int, columns: Int) {
        guard let tv = textView else { return }
        
        let tableData = TableData(rows: rows, columns: columns)
        let attachment = TableTextAttachment()
        attachment.tableData = tableData
        attachment.updateImage()
        
        let attr = NSAttributedString(attachment: attachment)
        let selectedRange = tv.selectedRange()
        tv.textStorage?.insert(attr, at: selectedRange.location)
        tv.didChangeText()
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
                    print("[RichTextEditor] 通过 link 打开音频播放器: \(url.lastPathComponent)")
                    showAudioPlayerPopover(for: fallbackAttachment, at: rect)
                    return
                }
                if let str = value as? String,
                   let url = URL(string: str),
                   isAudioURL(url) {
                    let fallbackAttachment = AudioBlockAttachment(fileURL: url)
                    let rect = CGRect(x: point.x - 150, y: point.y - 35, width: 300, height: 70)
                    print("[RichTextEditor] 通过 link(字符串) 打开音频播放器: \(url.lastPathComponent)")
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
            print("[RichTextEditor] 图片文件不存在")
            return false
        }

        print("[RichTextEditor] 双击打开图片: \(url.lastPathComponent)")

        // 使用系统预览打开图片
        NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Preview.app"), configuration: NSWorkspace.OpenConfiguration()) { app, error in
            if let error = error {
                print("[RichTextEditor] 打开预览失败: \(error)")
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
            print("[Image Resize] new bounds=\(attachment.bounds.size), attrs=\(currentW)x\(currentH), link=\(currentLink), freeResize=\(state.freeResize)")
        } else {
            print("[Image Resize] new bounds=\(attachment.bounds.size), attrs=<missing>, freeResize=\(state.freeResize)")
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
            var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            attachmentRect.origin.x += self.textContainerInset.width
            attachmentRect.origin.y += self.textContainerInset.height

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
        var attachmentRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        attachmentRect.origin.x += textContainerInset.width
        attachmentRect.origin.y += textContainerInset.height

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
                print("[TableTrace] hideActiveTableEditor write notebookTableData bytes=\(data.count) rows=\(attachment.tableData.rowCount)")
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

            print("[RichTextEditor] 打开音频播放器: \(audioAttachment.fileURL.lastPathComponent)")
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

            print("[RichTextEditor] 打开音频播放器(兼容模式): \(fallbackURL.lastPathComponent)")
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
        
        print("[LoadDebug] normalizeAttachmentsAfterLoad: textStorage length = \(textStorage.length)")

        textStorage.beginEditing()
        defer { textStorage.endEditing() }

        textStorage.enumerateAttribute(.attachment, in: fullRange, options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            
            print("[LoadDebug] Found attachment at range \(range.location)-\(range.location + range.length), type: \(type(of: attachment))")

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
                        print("[Attachment Load] Restored image bounds from attrs: \(savedWidth)x\(savedHeight)")
                        restored = true
                    }

                    if !restored,
                       let parsed = parseImageMetadataLink(textStorage.attribute(.link, at: range.location, effectiveRange: nil)) {
                        textAttachment.bounds = NSRect(x: 0, y: 0, width: parsed.width, height: parsed.height)
                        textStorage.addAttribute(.notebookImageWidth, value: parsed.width, range: range)
                        textStorage.addAttribute(.notebookImageHeight, value: parsed.height, range: range)
                        print("[Attachment Load] Restored image bounds from link: \(parsed.width)x\(parsed.height)")
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
                print("[LoadDebug] Found TableTextAttachment, rows: \(tableAttachment.tableData.rowCount), cols: \(tableAttachment.tableData.columnCount)")
                if let rawData = textStorage.attribute(.notebookTableData, at: range.location, effectiveRange: nil) as? Data,
                   let decoded = try? JSONDecoder().decode(TableData.self, from: rawData) {
                    print("[TableTrace] load notebookTableData bytes=\(rawData.count) rows=\(decoded.rowCount)")
                    tableAttachment.tableData = decoded
                } else if let (tableData, _) = TableTextAttachment.extractTableData(from: tableAttachment.contents) {
                    print("[TableTrace] load from contents rows=\(tableData.rowCount)")
                    tableAttachment.tableData = tableData
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        print("[TableTrace] backfill notebookTableData bytes=\(encoded.count)")
                    }
                } else if let wrapper = tableAttachment.fileWrapper,
                          wrapper.isDirectory,
                          let jsonData = wrapper.fileWrappers?["table.json"]?.regularFileContents,
                          let tableData = try? JSONDecoder().decode(TableData.self, from: jsonData) {
                    print("[TableTrace] load from fileWrapper json bytes=\(jsonData.count) rows=\(tableData.rowCount)")
                    tableAttachment.tableData = tableData
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        print("[TableTrace] backfill notebookTableData bytes=\(encoded.count)")
                    }
                    if let pngData = wrapper.fileWrappers?["table.png"]?.regularFileContents, !pngData.isEmpty {
                        tableAttachment.contents = pngData
                    }
                } else if let wrapper = tableAttachment.fileWrapper,
                          wrapper.isRegularFile,
                          let data = wrapper.regularFileContents,
                          let (tableData, _) = TableTextAttachment.extractTableData(from: data) {
                    print("[TableTrace] load from fileWrapper bytes=\(data.count) rows=\(tableData.rowCount)")
                    tableAttachment.tableData = tableData
                    tableAttachment.contents = data
                    if let encoded = try? JSONEncoder().encode(tableData) {
                        textStorage.addAttribute(.notebookTableData, value: encoded, range: range)
                        print("[TableTrace] backfill notebookTableData bytes=\(encoded.count)")
                    }
                } else {
                    print("[TableTrace] load failed: no table data")
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
                print("[LoadDebug] TableAttachment contents: \(tableAttachment.contents?.count ?? 0) bytes, fileType: \(tableAttachment.fileType ?? "nil")")
                tableAttachment.updateImage()
                print("[LoadDebug] TableAttachment image after update: \(tableAttachment.image != nil ? "exists" : "nil")")
                return
            }
            
            // 3.5) 尝试从普通 NSTextAttachment 恢复表格附件
            // RTFD 保存时可能丢失了自定义类信息，需要根据特征识别表格附件
            let attachmentClassName = String(describing: type(of: attachment))
            let isKnownCustomType = attachment is AttachmentTextAttachment ||
                                   attachment is AudioBlockAttachment ||
                                   attachment is TableTextAttachment ||
                                   attachment is CheckboxTextAttachment
            print("[LoadDebug] Attachment class: \(attachmentClassName), isKnownCustom: \(isKnownCustomType)")
            
            if !isKnownCustomType {
                print("[LoadDebug] Unknown attachment type, checking if looks like table...")
                print("[LoadDebug] Attachment bounds: \(attachment.bounds.width) x \(attachment.bounds.height)")
                print("[LoadDebug] Attachment contents: \(attachment.contents?.count ?? 0) bytes")
                print("[LoadDebug] Attachment image: \(attachment.image != nil ? "exists" : "nil")")
                
                if TableTextAttachment.looksLikeTable(attachment) {
                    print("[LoadDebug] Found potential table attachment, attempting recovery...")
                    
                    // 尝试恢复表格附件
                    if let recovered = TableTextAttachment.recover(from: attachment) {
                        let tableDataAttr = textStorage.attribute(.notebookTableData, at: range.location, effectiveRange: nil)
                        textStorage.addAttribute(.attachment, value: recovered, range: range)
                        if let tableDataAttr {
                            textStorage.addAttribute(.notebookTableData, value: tableDataAttr, range: range)
                        }
                        print("[LoadDebug] Successfully recovered TableTextAttachment with \(recovered.tableData.rowCount) rows")
                        return
                    }
                } else {
                    print("[LoadDebug] Does not look like table")
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
                    print("[Attachment Migrate] Failed writing legacy image data: \(error)")
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
                print("[Attachment Migrate] Failed exporting legacy image: \(error)")
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
                    print("[Attachment Migrate] Failed writing legacy audio data: \(error)")
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
            print("[RichTextEditor] 音频文件不存在: \(attachment.fileURL.path)")
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
        var markedString = fullString.substring(with: markedRange)
        
        markedString = markedString.replacingOccurrences(of: "'", with: "")
        
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

        // 5. 没有列表，继承上一行的格式（字号、字体、颜色）
        return handleFormatInheritance(currentLineRange: currentLineRange)
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

    /// 获取要继承的格式（从当前行或上一行）
    private func getFormatToInherit(from lineRange: NSRange) -> (font: NSFont?, color: NSColor?) {
        guard let textStorage = self.textStorage else { return (nil, nil) }

        var effectiveRange: NSRange = NSRange(location: NSNotFound, length: 0)
        var font: NSFont?
        var color: NSColor?

        // 尝试从当前行获取格式（跳过列表符号部分）
        if lineRange.location < textStorage.length {
            // 查找行中第一个非列表符号的字符位置
            let lineContent = (self.string as NSString).substring(with: lineRange)
            var contentStartOffset = 0

            // 跳过常见的列表前缀
            let prefixes = ["☐ ", "☑ ", "• ", "- ", "* "]
            for prefix in prefixes {
                if lineContent.hasPrefix(prefix) {
                    contentStartOffset = prefix.count
                    break
                }
            }
            // 检查数字编号 (如 "1. ", "2. ")
            if let regex = try? NSRegularExpression(pattern: "^\\d+\\.\\s"),
               let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: lineContent.count)) {
                contentStartOffset = match.range.length
            }

            let contentLocation = lineRange.location + contentStartOffset
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

                // 从上一行获取格式（跳过列表符号）
                let prevLineContent = (self.string as NSString).substring(with: previousLineRange)
                var prevContentOffset = 0
                let prefixes = ["☐ ", "☑ ", "• ", "- ", "* "]
                for prefix in prefixes {
                    if prevLineContent.hasPrefix(prefix) {
                        prevContentOffset = prefix.count
                        break
                    }
                }
                if let regex = try? NSRegularExpression(pattern: "^\\d+\\.\\s"),
                   let match = regex.firstMatch(in: prevLineContent, options: [], range: NSRange(location: 0, length: prevLineContent.count)) {
                    prevContentOffset = match.range.length
                }

                let prevContentLocation = previousLineRange.location + prevContentOffset
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
        let isDark = self.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let defaultColor = isDark ? NSColor.white : NSColor.black
        let effectiveColor = color ?? defaultColor

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
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入复选框（未选中状态）
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let newAttachment = CheckboxTextAttachment(checked: false)
            let attrString = NSAttributedString(attachment: newAttachment)
            let mutableAttr = NSMutableAttributedString(attributedString: attrString)
            mutableAttr.append(NSAttributedString(string: " "))

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
            self.textStorage?.deleteCharacters(in: deleteRange)
            self.insertNewline(nil)
            self.didChangeText()
            return true
        } else {
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入相同的前缀
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            self.textStorage?.insert(NSAttributedString(string: prefix), at: newLineRange.location)

            // 应用继承的格式到前缀之后的内容
            let contentStartLocation = newLineRange.location + prefix.count
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
            self.textStorage?.deleteCharacters(in: deleteRange)
            self.insertNewline(nil)
            self.didChangeText()
            return true
        } else {
            // 获取要继承的格式
            let (font, color) = getFormatToInherit(from: currentLineRange)

            // 有内容，先插入换行
            self.insertNewline(nil)

            // 在新行插入下一个编号
            let newLineRange = (self.string as NSString).lineRange(for: self.selectedRange())
            let nextNumber = currentNumber + 1
            let newPrefix = "\(nextNumber). "
            self.textStorage?.insert(NSAttributedString(string: newPrefix), at: newLineRange.location)

            // 应用继承的格式到编号之后的内容
            let contentStartLocation = newLineRange.location + newPrefix.count
            let contentRange = NSRange(location: contentStartLocation, length: 0)
            applyFormat(font: font, color: color, to: contentRange)
            
            // 设置光标位置在编号之后
            self.setSelectedRange(NSRange(location: contentStartLocation, length: 0))

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
    let isEditable: Bool
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
        textView.textColor = .textColor
        // 使用用户设置的字体
        textView.font = AppSettings.shared.editorFont
        textView.delegate = context.coordinator
        textView.pasteCoordinator = context.coordinator

        textView.typingAttributes[.foregroundColor] = Self.adaptiveDefaultTextColor

        textView.textStorage?.setAttributedString(attributedText)
        textView.normalizeAttachmentsAfterLoad()
        if updateDefaultTextColors(in: textView, for: scheme) {
            context.coordinator.attributedText = NSAttributedString(attributedString: textView.attributedString())
        }
        Self.refreshAppearanceSensitiveAttachments(in: textView)

        textView.isSelectable = true
        textView.isEditable = isEditable

        // 注册拖放类型以支持图片拖放
        textView.registerForDraggedTypes([.fileURL, .png, .tiff, NSPasteboard.PasteboardType("NSFilenamesPboardType")])

        scroll.documentView = textView
        controller.bind(textView: textView, noteID: noteID)

        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? RichTextView else { return }
        let didSwitchNote = context.coordinator.lastAppliedNoteID != noteID
        let didChangeColorScheme = context.coordinator.lastAppliedColorScheme != colorScheme

        // 确保 pasteCoordinator 始终是最新的
        textView.pasteCoordinator = context.coordinator

        let scheme = colorScheme
        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = .textColor
        nsView.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        textView.typingAttributes[.foregroundColor] = Self.adaptiveDefaultTextColor
        textView.isEditable = isEditable

        // 关键：切换笔记时强制刷新内容；同一笔记编辑时避免 update 覆盖用户输入。
        if didSwitchNote {
            let interval = Logger.shared.beginInterval(
                .editor,
                "richTextNoteSwitch",
                metadata: "from=\(context.coordinator.lastAppliedNoteID?.uuidString.prefix(8) ?? "nil") to=\(noteID.uuidString.prefix(8)) incomingLength=\(attributedText.length) existingLength=\(textView.string.count)"
            )

            context.coordinator.isProgrammaticUpdate = true
            context.coordinator.lastAppliedNoteID = noteID

            // 清除撤销管理器，避免切换笔记后撤销操作导致崩溃
            // 先禁用撤销注册，再清除所有操作，最后重新启用
            if let undoManager = textView.undoManager {
                undoManager.disableUndoRegistration()
                undoManager.removeAllActions()
                undoManager.enableUndoRegistration()
            }

            textView.textStorage?.setAttributedString(attributedText)
            textView.normalizeAttachmentsAfterLoad()
            if updateDefaultTextColors(in: textView, for: scheme) {
                context.coordinator.attributedText = NSAttributedString(attributedString: textView.attributedString())
            }
            Self.refreshAppearanceSensitiveAttachments(in: textView)
            textView.setSelectedRange(NSRange(location: 0, length: 0))

            context.coordinator.isProgrammaticUpdate = false
            context.coordinator.lastAppliedColorScheme = scheme

            // 只有在内容实际更新后才绑定新的 noteID
            controller.bind(textView: textView, noteID: noteID)
            interval.end(.info, "renderedLength=\(textView.string.count)")
        } else if didChangeColorScheme {
            let interval = Logger.shared.beginInterval(
                .editor,
                "richTextAppearanceRefresh",
                metadata: "noteID=\(noteID.uuidString.prefix(8)) scheme=\(scheme == .dark ? "dark" : "light")"
            )
            if updateDefaultTextColors(in: textView, for: scheme) {
                context.coordinator.attributedText = NSAttributedString(attributedString: textView.attributedString())
            }
            Self.refreshAppearanceSensitiveAttachments(in: textView)
            context.coordinator.lastAppliedColorScheme = scheme
            interval.end(.info, "contentLength=\(textView.string.count)")
        }
    }

    /// 更新已有文字中的系统默认颜色（纯黑或纯白）以适应新的外观模式
    /// 这样不会破坏用户显式设置的其他颜色
    static var adaptiveDefaultTextColor: NSColor {
        .textColor
    }

    static func normalizedDefaultForegroundColor(_ color: NSColor, for scheme: ColorScheme) -> NSColor? {
        guard isLegacyDefaultTextColor(color, for: scheme) else {
            return nil
        }
        return adaptiveDefaultTextColor
    }

    static func refreshAppearanceSensitiveAttachments(in textView: RichTextView) {
        guard let textStorage = textView.textStorage else { return }
        let fullRange = NSRange(location: 0, length: textStorage.length)

        textStorage.enumerateAttribute(.attachment, in: fullRange, options: []) { value, _, _ in
            switch value {
            case let attachment as AudioBlockAttachment:
                attachment.refreshPresentationIfNeeded()
            case let attachment as TableTextAttachment:
                attachment.updateImage()
            case let attachment as CheckboxTextAttachment:
                attachment.refreshPresentationIfNeeded()
            default:
                break
            }
        }

        textView.layoutManager?.invalidateDisplay(forCharacterRange: fullRange)
        textView.needsDisplay = true
    }

    static func isLegacyDefaultTextColor(_ color: NSColor, for scheme: ColorScheme) -> Bool {
        let oldDefaultColors: [NSColor] = (scheme == .dark)
            ? [.black, NSColor(calibratedWhite: 0, alpha: 1)]
            : [.white, NSColor(calibratedWhite: 1, alpha: 1)]
        return oldDefaultColors.contains { oldColor in
            color.isEqual(to: oldColor)
        }
    }

    @discardableResult
    private func updateDefaultTextColors(in textView: RichTextView, for scheme: ColorScheme) -> Bool {
        guard let textStorage = textView.textStorage else { return false }
        let fullRange = NSRange(location: 0, length: textStorage.length)
        guard fullRange.length > 0 else { return false }

        var didUpdate = false

        textStorage.beginEditing()

        textStorage.enumerateAttributes(in: fullRange, options: []) { attributes, range, _ in
            if attributes[.attachment] != nil {
                return
            }

            if let color = attributes[.foregroundColor] as? NSColor {
                if let normalizedColor = Self.normalizedDefaultForegroundColor(color, for: scheme) {
                    didUpdate = true
                    textStorage.addAttribute(.foregroundColor, value: normalizedColor, range: range)
                }
                return
            }

            didUpdate = true
            textStorage.addAttribute(.foregroundColor, value: Self.adaptiveDefaultTextColor, range: range)
        }

        textStorage.endEditing()
        return didUpdate
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(attributedText: $attributedText, controller: controller)
    }

    final class Coordinator: NSObject, NSTextViewDelegate, PasteCoordinatorProtocol {
        @Binding var attributedText: NSAttributedString
        var isProgrammaticUpdate = false
        var lastAppliedNoteID: UUID?
        var lastAppliedColorScheme: ColorScheme?
        weak var controller: RichTextController?
        
        /// 标记是否有正在进行的输入法编辑会话
        private var hasMarkedText = false
        /// 延迟更新的内容
        private var pendingContent: NSAttributedString?

        private var fontChangeCancellable: AnyCancellable?

        init(attributedText: Binding<NSAttributedString>, controller: RichTextController) {
            _attributedText = attributedText
            self.controller = controller
            super.init()

            // 监听字体变化通知
            fontChangeCancellable = NotificationCenter.default.publisher(for: .editorFontDidChange)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.applyFontSetting()
                }
        }

        /// 应用字体设置到当前文本视图
        private func applyFontSetting() {
            guard let textView = controller?.textView else { return }
            let font = AppSettings.shared.editorFont
            textView.font = font

            // 更新整个文本存储的字体
            textView.textStorage?.enumerateAttributes(in: NSRange(location: 0, length: textView.textStorage?.length ?? 0), options: []) { attrs, range, stop in
                // 只更新没有特定字体属性的文本（保留用户手动设置的字体）
                var newAttrs = attrs
                newAttrs[.font] = font
                textView.textStorage?.setAttributes(newAttrs, range: range)
            }
        }
        
        /// 检查是否有 marked text（输入法正在编辑）
        private func checkHasMarkedText(_ textView: NSTextView) -> Bool {
            guard let inputContext = textView.inputContext else { return false }
            // 使用 KVC 获取 hasMarkedText 属性
            return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
        }
        
        private func flushPendingContent(from textView: NSTextView) {
            if let content = textView.attributedString().copy() as? NSAttributedString {
                self.attributedText = content
            }
            pendingContent = nil
        }

        /// 在非文本编辑场景（如附件缩放）主动同步绑定
        func syncBindingFromTextView(_ textView: NSTextView) {
            guard !isProgrammaticUpdate,
                  let content = textView.attributedString().copy() as? NSAttributedString else { return }
            self.attributedText = content
        }

        func handleMarkedTextFinished(in textView: NSTextView) {
            hasMarkedText = false
            flushPendingContent(from: textView)
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
                handleMarkedTextFinished(in: tv)
            }
        }
        
        // MARK: - 粘贴图片支持
        
        /// 处理粘贴操作，支持粘贴图片和文件
        func handlePaste(in textView: NSTextView) -> Bool {
            print("[Coordinator] handlePaste called")
            let pasteboard = NSPasteboard.general

            // 获取当前笔记ID
            guard let noteID = controller?.attachmentTargetNoteID() else {
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

            // 3. 尝试读取HTML表格并转换为TableTextAttachment
            if let htmlString = pasteboard.string(forType: .html) ?? pasteboard.string(forType: NSPasteboard.PasteboardType("public.html")) {
                print("[Coordinator] HTML content found, checking for table")
                if let tableData = parseHTMLTable(htmlString) {
                    print("[Coordinator] Table detected in HTML, converting to TableTextAttachment")
                    insertTableAttachment(tableData: tableData, in: textView)
                    return true
                }
            }

            // 如果不是图片或文件，返回false让系统处理其他粘贴类型
            print("[Coordinator] No file URLs found, falling back to default paste")
            return false
        }

        /// 解析HTML表格并转换为TableData
        private func parseHTMLTable(_ html: String) -> TableData? {
            // 简单解析HTML表格
            let rowPattern = "<tr[^>]*>(.*?)</tr>"
            let cellPattern = "<t[dh][^>]*>(.*?)</t[dh]>"

            guard let rowRegex = try? NSRegularExpression(pattern: rowPattern, options: [.dotMatchesLineSeparators, .caseInsensitive]),
                  let cellRegex = try? NSRegularExpression(pattern: cellPattern, options: [.dotMatchesLineSeparators, .caseInsensitive]) else {
                return nil
            }

            let htmlRange = NSRange(html.startIndex..., in: html)
            let rowMatches = rowRegex.matches(in: html, options: [], range: htmlRange)

            var rows: [[String]] = []
            var maxColumns = 0

            for rowMatch in rowMatches {
                let rowContent = (html as NSString).substring(with: rowMatch.range(at: 1))
                let cellMatches = cellRegex.matches(in: rowContent, options: [], range: NSRange(rowContent.startIndex..., in: rowContent))

                var cells: [String] = []
                for cellMatch in cellMatches {
                    let cellContent = (rowContent as NSString).substring(with: cellMatch.range(at: 1))
                    // 移除HTML标签
                    let cleanText = cellContent.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                        .replacingOccurrences(of: "&nbsp;", with: " ")
                        .replacingOccurrences(of: "&lt;", with: "<")
                        .replacingOccurrences(of: "&gt;", with: ">")
                        .replacingOccurrences(of: "&amp;", with: "&")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    cells.append(cleanText)
                }

                if !cells.isEmpty {
                    rows.append(cells)
                    maxColumns = max(maxColumns, cells.count)
                }
            }

            guard !rows.isEmpty else { return nil }

            // 确保所有行有相同数量的列
            for i in 0..<rows.count {
                while rows[i].count < maxColumns {
                    rows[i].append("")
                }
            }

            var tableData = TableData(rows: rows.count, columns: maxColumns)
            tableData.rows = rows
            return tableData
        }

        /// 插入表格附件到文本视图
        private func insertTableAttachment(tableData: TableData, in textView: NSTextView) {
            let attachment = TableTextAttachment()
            attachment.tableData = tableData
            attachment.updateImage()

            let attributedString = NSAttributedString(attachment: attachment)
            let selectedRange = textView.selectedRange()
            textView.textStorage?.insert(attributedString, at: selectedRange.location)
            textView.didChangeText()
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
            
            guard let noteID = controller?.attachmentTargetNoteID() else {
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
            let inserted: NSAttributedString

            if kind == .image {
                let mutable = NSMutableAttributedString(attachment: attachment)
                let size = attachment.bounds.size
                if size.width > 1, size.height > 1 {
                    mutable.addAttribute(.notebookImageWidth, value: size.width, range: NSRange(location: 0, length: mutable.length))
                    mutable.addAttribute(.notebookImageHeight, value: size.height, range: NSRange(location: 0, length: mutable.length))
                    let imageLink = "notebook-image://\(fileURL.absoluteString)#w=\(Int(size.width.rounded()))&h=\(Int(size.height.rounded()))"
                    mutable.addAttribute(.link, value: imageLink, range: NSRange(location: 0, length: mutable.length))
                }
                inserted = mutable
            } else {
                inserted = NSAttributedString(attachment: attachment)
            }

            let selectedRange = textView.selectedRange()
            textView.textStorage?.insert(inserted, at: selectedRange.location)
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

struct AttachmentTargetNoteResolver {
    static func resolve(boundNoteID: UUID?, currentNoteID: UUID?, hasActiveTextView: Bool) -> UUID? {
        if hasActiveTextView, let boundNoteID {
            return boundNoteID
        }
        return currentNoteID ?? boundNoteID
    }
}
