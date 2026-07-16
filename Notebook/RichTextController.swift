import SwiftUI
import AppKit
import Foundation
import Combine
import AVFoundation
import UniformTypeIdentifiers

@MainActor
final class RichTextController: ObservableObject {
    private struct SavedNoteState {
        let titleHash: Int
        let contentHash: Int
    }

    weak var textView: NSTextView?
    @Published private(set) var noteSearchResultCount: Int = 0
    @Published private(set) var noteSearchCurrentMatchIndex: Int = 0

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
    private var noteSearchQuery: String = ""
    private var noteSearchRanges: [NSRange] = []
    private var highlightedSearchRange: NSRange?
    private let noteSearchHighlightColor = NSColor.systemYellow.withAlphaComponent(0.35)

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
                        DebugLog.editor("Auto-save triggered", level: .debug)
                    }
                }
            }
        }

        DebugLog.editor("Auto-save started with interval: \(interval)s", level: .debug)
    }

    /// 停止定期自动保存
    func stopAutoSave() {
        autoSaveTimer?.invalidate()
        autoSaveTimer = nil
        DebugLog.editor("Auto-save stopped", level: .debug)
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

    /// 不提交输入法、不改变焦点，只用于判断同步等待期间编辑器是否发生变化。
    func revisionFingerprint(title: String) -> String? {
        guard let textView, let boundNoteID else { return nil }
        let contentHash = textView.attributedString().hash
        let markedTextMarker = hasMarkedText ? "marked" : "committed"
        return "\(boundNoteID.uuidString)|\(title.hashValue)|\(contentHash)|\(markedTextMarker)"
    }

    func bind(textView: NSTextView, noteID: UUID) {
        if boundNoteID != nil && boundNoteID != noteID {
            clearNoteSearch()
        }
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
            DebugLog.editor("snapshot: textView is nil, returning nil to use memory content", level: .debug)
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
        DebugLog.editor("snapshot: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)", level: .debug)
        
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

    func updateNoteSearch(query: String) {
        noteSearchQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let textView else {
            noteSearchRanges = []
            noteSearchResultCount = 0
            noteSearchCurrentMatchIndex = 0
            highlightedSearchRange = nil
            return
        }

        guard !noteSearchQuery.isEmpty else {
            noteSearchRanges = []
            noteSearchResultCount = 0
            noteSearchCurrentMatchIndex = 0
            clearNoteSearchHighlight(in: textView)
            return
        }

        noteSearchRanges = noteSearchMatches(in: textView.string, query: noteSearchQuery)
        noteSearchResultCount = noteSearchRanges.count

        guard !noteSearchRanges.isEmpty else {
            noteSearchCurrentMatchIndex = 0
            clearNoteSearchHighlight(in: textView)
            return
        }

        let anchorLocation = highlightedSearchRange?.location ?? textView.selectedRange().location
        let targetIndex = preferredSearchMatchIndex(near: anchorLocation, in: noteSearchRanges)
        activateNoteSearchMatch(at: targetIndex, in: textView)
    }

    func selectNextNoteSearchMatch() {
        guard let textView, !noteSearchRanges.isEmpty else { return }
        let nextIndex = noteSearchCurrentMatchIndex <= 0
            ? 0
            : (noteSearchCurrentMatchIndex % noteSearchRanges.count)
        activateNoteSearchMatch(at: nextIndex, in: textView)
    }

    func selectPreviousNoteSearchMatch() {
        guard let textView, !noteSearchRanges.isEmpty else { return }
        let previousIndex = noteSearchCurrentMatchIndex <= 1
            ? max(noteSearchRanges.count - 1, 0)
            : noteSearchCurrentMatchIndex - 2
        activateNoteSearchMatch(at: previousIndex, in: textView)
    }

    func refreshNoteSearchResultsIfNeeded() {
        guard !noteSearchQuery.isEmpty else { return }
        updateNoteSearch(query: noteSearchQuery)
    }

    func clearNoteSearch() {
        noteSearchQuery = ""
        noteSearchRanges = []
        noteSearchResultCount = 0
        noteSearchCurrentMatchIndex = 0
        if let textView {
            clearNoteSearchHighlight(in: textView)
        } else {
            highlightedSearchRange = nil
        }
    }

    private func noteSearchMatches(in text: String, query: String) -> [NSRange] {
        let nsText = text as NSString
        var results: [NSRange] = []
        var searchRange = NSRange(location: 0, length: nsText.length)

        while searchRange.length > 0 {
            let foundRange = nsText.range(
                of: query,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: searchRange
            )
            guard foundRange.location != NSNotFound else { break }
            results.append(foundRange)

            let nextLocation = NSMaxRange(foundRange)
            guard nextLocation < nsText.length else { break }
            searchRange = NSRange(location: nextLocation, length: nsText.length - nextLocation)
        }

        return results
    }

    private func preferredSearchMatchIndex(near location: Int, in ranges: [NSRange]) -> Int {
        guard !ranges.isEmpty else { return 0 }
        if let index = ranges.firstIndex(where: { $0.location >= location }) {
            return index
        }
        return 0
    }

    private func activateNoteSearchMatch(at index: Int, in textView: NSTextView) {
        guard noteSearchRanges.indices.contains(index) else { return }
        let range = noteSearchRanges[index]

        clearNoteSearchHighlight(in: textView)
        if let layoutManager = textView.layoutManager {
            layoutManager.addTemporaryAttribute(
                .backgroundColor,
                value: noteSearchHighlightColor,
                forCharacterRange: range
            )
        }

        highlightedSearchRange = range
        noteSearchCurrentMatchIndex = index + 1
        textView.setSelectedRange(range)
        textView.scrollRangeToVisible(range)
        textView.showFindIndicator(for: range)
    }

    private func clearNoteSearchHighlight(in textView: NSTextView) {
        guard let previousRange = highlightedSearchRange else { return }
        textView.layoutManager?.removeTemporaryAttribute(.backgroundColor, forCharacterRange: previousRange)
        highlightedSearchRange = nil
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

    private func setExplicitPreviewMarker(
        _ key: NSAttributedString.Key,
        enabled: Bool,
        range: NSRange,
        in textStorage: NSTextStorage?
    ) {
        guard let textStorage else { return }
        if enabled {
            textStorage.addAttribute(key, value: true, range: range)
        } else {
            textStorage.removeAttribute(key, range: range)
        }
    }

    private func shouldMarkExplicitFontFamily(_ font: NSFont) -> Bool {
        font.familyName != AppSettings.shared.editorFont.familyName
    }

    private func shouldMarkExplicitFontSize(_ font: NSFont) -> Bool {
        abs(font.pointSize - AppSettings.shared.editorFont.pointSize) > 0.5
    }

    private func shouldMarkExplicitForegroundColor(_ color: NSColor) -> Bool {
        if color.isEqual(to: NSColor.textColor) {
            return false
        }
        if color.isEqual(to: NSColor.black) || color.isEqual(to: NSColor.white) {
            return false
        }
        return true
    }

    private func attributesForInsertionPoint(in textView: NSTextView, at location: Int) -> [NSAttributedString.Key: Any] {
        guard let textStorage = textView.textStorage, textStorage.length > 0 else {
            var attributes = textView.typingAttributes
            attributes[.font] = attributes[.font] as? NSFont ?? AppSettings.shared.editorFont
            attributes[.foregroundColor] = attributes[.foregroundColor] as? NSColor ?? NSColor.textColor
            return attributes
        }

        let lookupLocation: Int
        if location > 0 {
            lookupLocation = min(location - 1, textStorage.length - 1)
        } else {
            lookupLocation = min(location, textStorage.length - 1)
        }

        var attributes = textStorage.attributes(at: lookupLocation, effectiveRange: nil)
        for (key, value) in textView.typingAttributes {
            attributes[key] = value
        }
        attributes[.font] = attributes[.font] as? NSFont ?? AppSettings.shared.editorFont
        attributes[.foregroundColor] = attributes[.foregroundColor] as? NSColor ?? NSColor.textColor
        attributes.removeValue(forKey: .attachment)
        return attributes
    }

    private func applyTypingAttribute(_ value: Any?, for key: NSAttributedString.Key, in textView: NSTextView) {
        var attributes = attributesForInsertionPoint(in: textView, at: textView.selectedRange().location)
        if let value {
            attributes[key] = value
        } else {
            attributes.removeValue(forKey: key)
        }
        textView.typingAttributes = attributes
    }

    func toggleBold() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        // 获取当前字体
        let currentAttributes = attributesForInsertionPoint(in: tv, at: range.location)
        let currentFont = currentAttributes[.font] as? NSFont ?? AppSettings.shared.editorFont

        // 切换粗体
        let newFont: NSFont
        if currentFont.fontDescriptor.symbolicTraits.contains(.bold) {
            newFont = NSFontManager.shared.convert(currentFont, toNotHaveTrait: .boldFontMask)
        } else {
            newFont = NSFontManager.shared.convert(currentFont, toHaveTrait: .boldFontMask)
        }

        if range.length == 0 {
            applyTypingAttribute(newFont, for: .font, in: tv)
            return
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        setExplicitPreviewMarker(
            .notebookExplicitBold,
            enabled: !currentFont.fontDescriptor.symbolicTraits.contains(.bold),
            range: range,
            in: tv.textStorage
        )
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func toggleItalic() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        // 获取当前字体
        let currentAttributes = attributesForInsertionPoint(in: tv, at: range.location)
        let currentFont = currentAttributes[.font] as? NSFont ?? AppSettings.shared.editorFont

        // 切换斜体
        let fontManager = NSFontManager.shared
        let traits = fontManager.traits(of: currentFont)
        let newFont: NSFont
        if traits.contains(.italicFontMask) {
            newFont = fontManager.convert(currentFont, toNotHaveTrait: .italicFontMask)
        } else {
            newFont = NSFontManager.shared.font(withFamily: currentFont.familyName ?? ".AppleSystemUIFont",
                                                 traits: [.italicFontMask],
                                                 weight: fontManager.weight(of: currentFont),
                                                 size: currentFont.pointSize)
                ?? NSFontManager.shared.convert(currentFont, toHaveTrait: .italicFontMask)
        }

        if range.length == 0 {
            applyTypingAttribute(newFont, for: .font, in: tv)
            return
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        setExplicitPreviewMarker(
            .notebookExplicitItalic,
            enabled: !traits.contains(.italicFontMask),
            range: range,
            in: tv.textStorage
        )
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    func toggleUnderline() {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        // 检查是否已有下划线
        let attributes = attributesForInsertionPoint(in: tv, at: range.location)
        let hasUnderline = attributes[.underlineStyle] != nil

        if range.length == 0 {
            applyTypingAttribute(hasUnderline ? nil : NSUnderlineStyle.single.rawValue, for: .underlineStyle, in: tv)
            return
        }

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
        let targetRange = range.length == 0 ? (tv.string as NSString).lineRange(for: range) : range
        tv.textStorage?.addAttributes([
            .font: NSFont.systemFont(ofSize: size, weight: .semibold),
            .notebookHeadingLevel: level
        ], range: targetRange)
        if range.length == 0 {
            applyTypingAttribute(NSFont.systemFont(ofSize: size, weight: .semibold), for: .font, in: tv)
        }
        tv.didChangeText()
    }

    // MARK: - 字体设置

    /// 设置选中区域的字体
    func setFont(name: String) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        // 获取当前字体
        let currentAttributes = attributesForInsertionPoint(in: tv, at: range.location)
        let currentFont = currentAttributes[.font] as? NSFont ?? AppSettings.shared.editorFont
        let fontSize = currentFont.pointSize

        // 创建新字体
        let newFont: NSFont
        if name == "System" {
            newFont = NSFont.systemFont(ofSize: fontSize)
        } else {
            newFont = NSFont(name: name, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize)
        }

        if range.length == 0 {
            applyTypingAttribute(newFont, for: .font, in: tv)
            return
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        setExplicitPreviewMarker(
            .notebookExplicitFontFamily,
            enabled: shouldMarkExplicitFontFamily(newFont),
            range: range,
            in: tv.textStorage
        )
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    /// 设置选中区域的字号
    func setFontSize(_ size: CGFloat) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        // 获取当前字体
        let currentAttributes = attributesForInsertionPoint(in: tv, at: range.location)
        let currentFont = currentAttributes[.font] as? NSFont ?? AppSettings.shared.editorFont

        // 创建新字体，保持其他属性
        let fontManager = NSFontManager.shared
        let newFont = fontManager.convert(currentFont, toSize: size)

        if range.length == 0 {
            applyTypingAttribute(newFont, for: .font, in: tv)
            return
        }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.font, value: newFont, range: range)
        setExplicitPreviewMarker(
            .notebookExplicitFontSize,
            enabled: shouldMarkExplicitFontSize(newFont),
            range: range,
            in: tv.textStorage
        )
        tv.textStorage?.endEditing()
        tv.didChangeText()
    }

    /// 设置选中区域的字体颜色
    func setFontColor(_ color: NSColor) {
        guard let tv = textView else { return }
        let range = tv.selectedRange()

        applyTypingAttribute(color, for: .foregroundColor, in: tv)

        if range.length == 0 { return }

        tv.textStorage?.beginEditing()
        tv.textStorage?.addAttribute(.foregroundColor, value: color, range: range)
        setExplicitPreviewMarker(
            .notebookExplicitForegroundColor,
            enabled: shouldMarkExplicitForegroundColor(color),
            range: range,
            in: tv.textStorage
        )
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
        toggleCheckboxForSelectedLines(in: tv)
    }

    func toggleCheckbox(at location: Int) -> Bool {
        guard let tv = textView else { return false }
        return tv.toggleCheckbox(at: location)
    }

    // MARK: - 缩进功能

    func increaseIndent() {
        guard let tv = textView else { return }
        adjustIndent(in: tv, increase: true)
    }

    func decreaseIndent() {
        guard let tv = textView else { return }
        adjustIndent(in: tv, increase: false)
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
        toggleNumberedListForSelectedLines(in: tv)
    }

    /// 通用列表切换方法
    private func toggleListType(prefix: String) {
        guard let tv = textView else { return }
        toggleTextListForSelectedLines(in: tv, prefix: prefix)
    }

    private func selectedLineRanges(in textView: NSTextView) -> [NSRange] {
        let nsString = textView.string as NSString
        let selectedRange = textView.selectedRange()
        var effectiveRange = selectedRange

        if effectiveRange.length > 0,
           NSMaxRange(effectiveRange) <= nsString.length,
           NSMaxRange(effectiveRange) > effectiveRange.location,
           nsString.character(at: NSMaxRange(effectiveRange) - 1) == 10 {
            effectiveRange.length -= 1
        }

        let fullLineRange = nsString.lineRange(for: effectiveRange)
        guard fullLineRange.length > 0 else {
            return [fullLineRange]
        }

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

    private func leadingWhitespaceBoundary(in lineRange: NSRange, textView: NSTextView) -> Int {
        let nsString = textView.string as NSString
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

    private func checkboxRangeAtLineStart(in textView: NSTextView, lineRange: NSRange) -> NSRange? {
        let location = leadingWhitespaceBoundary(in: lineRange, textView: textView)
        guard location < textView.attributedString().length else { return nil }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        guard textView.normalizedCheckboxAttachment(at: location, effectiveRange: &effectiveRange) != nil else {
            return nil
        }
        return effectiveRange
    }

    private func textListPrefixRange(in textView: NSTextView, lineRange: NSRange, matching prefix: String? = nil) -> NSRange? {
        let nsString = textView.string as NSString
        let prefixLocation = leadingWhitespaceBoundary(in: lineRange, textView: textView)
        guard prefixLocation < NSMaxRange(lineRange), prefixLocation < nsString.length else { return nil }

        let lineContent = nsString.substring(with: NSRange(location: prefixLocation, length: NSMaxRange(lineRange) - prefixLocation))
        if let prefix {
            return lineContent.hasPrefix(prefix) ? NSRange(location: prefixLocation, length: prefix.utf16.count) : nil
        }

        for candidate in ["• ", "- ", "* "] {
            if lineContent.hasPrefix(candidate) {
                return NSRange(location: prefixLocation, length: candidate.utf16.count)
            }
        }

        if let regex = try? NSRegularExpression(pattern: "^\\d+\\.\\s"),
           let match = regex.firstMatch(in: lineContent, options: [], range: NSRange(location: 0, length: (lineContent as NSString).length)) {
            return NSRange(location: prefixLocation, length: match.range.length)
        }

        return nil
    }

    private func removeLinePrefix(in textView: NSTextView, lineRange: NSRange) -> Int {
        if let checkboxRange = checkboxRangeAtLineStart(in: textView, lineRange: lineRange) {
            let nsString = textView.string as NSString
            var deleteRange = checkboxRange
            if checkboxRange.upperBound < NSMaxRange(lineRange),
               checkboxRange.upperBound < nsString.length,
               nsString.substring(with: NSRange(location: checkboxRange.upperBound, length: 1)) == " " {
                deleteRange.length += 1
            }
            textView.textStorage?.deleteCharacters(in: deleteRange)
            return deleteRange.length
        }

        if let prefixRange = textListPrefixRange(in: textView, lineRange: lineRange) {
            textView.textStorage?.deleteCharacters(in: prefixRange)
            return prefixRange.length
        }

        return 0
    }

    private func toggleTextListForSelectedLines(in textView: NSTextView, prefix: String) {
        let selectedRange = textView.selectedRange()
        let ranges = selectedLineRanges(in: textView)
        let shouldRemove = ranges.allSatisfy { textListPrefixRange(in: textView, lineRange: $0, matching: prefix) != nil }
        var deltaBeforeSelection = 0
        var totalDelta = 0

        textView.textStorage?.beginEditing()
        for lineRange in ranges.reversed() {
            if shouldRemove {
                guard let prefixRange = textListPrefixRange(in: textView, lineRange: lineRange, matching: prefix) else { continue }
                textView.textStorage?.deleteCharacters(in: prefixRange)
                totalDelta -= prefixRange.length
                if prefixRange.location < selectedRange.location {
                    deltaBeforeSelection -= prefixRange.length
                }
            } else {
                let removed = removeLinePrefix(in: textView, lineRange: lineRange)
                let insertionLocation = leadingWhitespaceBoundary(in: lineRange, textView: textView)
                textView.textStorage?.insert(NSAttributedString(string: prefix), at: insertionLocation)
                let delta = prefix.utf16.count - removed
                totalDelta += delta
                if insertionLocation < selectedRange.location {
                    deltaBeforeSelection += delta
                }
            }
        }
        textView.textStorage?.endEditing()

        let newLocation = max(0, selectedRange.location + deltaBeforeSelection)
        let newLength = max(0, selectedRange.length + totalDelta - deltaBeforeSelection)
        textView.setSelectedRange(NSRange(location: newLocation, length: newLength))
        textView.didChangeText()
    }

    private func toggleNumberedListForSelectedLines(in textView: NSTextView) {
        let selectedRange = textView.selectedRange()
        let ranges = selectedLineRanges(in: textView)
        let shouldRemove = ranges.allSatisfy { lineRange in
            guard let prefixRange = textListPrefixRange(in: textView, lineRange: lineRange) else { return false }
            let prefix = (textView.string as NSString).substring(with: prefixRange)
            return prefix.range(of: "^\\d+\\.\\s$", options: .regularExpression) != nil
        }
        var deltaBeforeSelection = 0
        var totalDelta = 0
        var number = ranges.count

        textView.textStorage?.beginEditing()
        for lineRange in ranges.reversed() {
            if shouldRemove {
                guard let prefixRange = textListPrefixRange(in: textView, lineRange: lineRange) else { continue }
                textView.textStorage?.deleteCharacters(in: prefixRange)
                totalDelta -= prefixRange.length
                if prefixRange.location < selectedRange.location {
                    deltaBeforeSelection -= prefixRange.length
                }
            } else {
                let removed = removeLinePrefix(in: textView, lineRange: lineRange)
                let insertionLocation = leadingWhitespaceBoundary(in: lineRange, textView: textView)
                let prefix = "\(number). "
                textView.textStorage?.insert(NSAttributedString(string: prefix), at: insertionLocation)
                let delta = prefix.utf16.count - removed
                totalDelta += delta
                if insertionLocation < selectedRange.location {
                    deltaBeforeSelection += delta
                }
                number -= 1
            }
        }
        textView.textStorage?.endEditing()

        let newLocation = max(0, selectedRange.location + deltaBeforeSelection)
        let newLength = max(0, selectedRange.length + totalDelta - deltaBeforeSelection)
        textView.setSelectedRange(NSRange(location: newLocation, length: newLength))
        textView.didChangeText()
    }

    private func toggleCheckboxForSelectedLines(in textView: NSTextView) {
        let selectedRange = textView.selectedRange()
        let ranges = selectedLineRanges(in: textView)
        let shouldRemove = ranges.allSatisfy { checkboxRangeAtLineStart(in: textView, lineRange: $0) != nil }
        var deltaBeforeSelection = 0
        var totalDelta = 0

        textView.textStorage?.beginEditing()
        for lineRange in ranges.reversed() {
            if shouldRemove {
                let removed = removeLinePrefix(in: textView, lineRange: lineRange)
                totalDelta -= removed
                if lineRange.location < selectedRange.location {
                    deltaBeforeSelection -= removed
                }
            } else {
                let removed = removeLinePrefix(in: textView, lineRange: lineRange)
                let insertionLocation = leadingWhitespaceBoundary(in: lineRange, textView: textView)
                let checkbox = NSMutableAttributedString(attachment: CheckboxTextAttachment(checked: false))
                checkbox.append(NSAttributedString(string: " "))
                textView.textStorage?.insert(checkbox, at: insertionLocation)
                let delta = checkbox.length - removed
                totalDelta += delta
                if insertionLocation < selectedRange.location {
                    deltaBeforeSelection += delta
                }
            }
        }
        textView.textStorage?.endEditing()

        let newLocation = max(0, selectedRange.location + deltaBeforeSelection)
        let newLength = max(0, selectedRange.length + totalDelta - deltaBeforeSelection)
        textView.setSelectedRange(NSRange(location: newLocation, length: newLength))
        textView.didChangeText()
    }

    private func adjustIndent(in textView: NSTextView, increase: Bool) {
        let selectedRange = textView.selectedRange()
        let ranges = selectedLineRanges(in: textView)
        var deltaBeforeSelection = 0
        var totalDelta = 0

        textView.textStorage?.beginEditing()
        for lineRange in ranges.reversed() {
            if increase {
                textView.textStorage?.insert(NSAttributedString(string: "    "), at: lineRange.location)
                totalDelta += 4
                if lineRange.location < selectedRange.location {
                    deltaBeforeSelection += 4
                }
            } else {
                let nsString = textView.string as NSString
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
                textView.textStorage?.deleteCharacters(in: NSRange(location: lineRange.location, length: deleteLength))
                totalDelta -= deleteLength
                if lineRange.location < selectedRange.location {
                    deltaBeforeSelection -= deleteLength
                }
            }
        }
        textView.textStorage?.endEditing()

        let newLocation = max(0, selectedRange.location + deltaBeforeSelection)
        let newLength = max(0, selectedRange.length + totalDelta - deltaBeforeSelection)
        textView.setSelectedRange(NSRange(location: newLocation, length: newLength))
        textView.didChangeText()
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

        // 检查是否已经有删除线
        let attributes = attributesForInsertionPoint(in: tv, at: range.location)
        let hasStrikethrough = attributes[.strikethroughStyle] != nil

        if range.length == 0 {
            applyTypingAttribute(hasStrikethrough ? nil : NSUnderlineStyle.single.rawValue, for: .strikethroughStyle, in: tv)
            return
        }

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
            DebugLog.editor("clearFormatting: textView is nil", level: .debug)
            return
        }
        let range = tv.selectedRange()
        if range.length == 0 {
            DebugLog.editor("clearFormatting: no selection", level: .debug)
            return
        }

        // 检查范围是否有效
        let textLength = tv.string.utf16.count
        guard range.location >= 0, range.location + range.length <= textLength else {
            DebugLog.editor("clearFormatting: invalid range \(range), text length \(textLength)", level: .debug)
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
                DebugLog.editor("Failed to insert image: \(error)", level: .warn)
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
            DebugLog.editor("无法获取音频时长: \(error)", level: .warn)
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
                DebugLog.editor("Failed to insert audio: \(error)", level: .warn)
            }
        }
    }

    func insertTable(rows: Int, columns: Int) {
        guard let tv = textView else { return }
        
        let tableData = TableData(rows: rows, columns: columns)
        let attachment = TableTextAttachment()
        attachment.tableData = tableData
        attachment.updateImage()
        
        let attr = NSMutableAttributedString(attachment: attachment)
        if let data = try? JSONEncoder().encode(tableData) {
            attr.addAttribute(.notebookTableData, value: data, range: NSRange(location: 0, length: attr.length))
        }
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
