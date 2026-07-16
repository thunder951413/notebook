import SwiftUI
import AppKit
import Foundation
import Combine

struct RichTextEditor: NSViewRepresentable {
    static let longDocumentCharacterThreshold = 100_000

    @MainActor
    static func configureViewportLayout(in textView: RichTextView, contentLength: Int) {
        textView.layoutManager?.allowsNonContiguousLayout = true
        textView.isAutomaticLinkDetectionEnabled = contentLength < longDocumentCharacterThreshold
    }
    @Binding var attributedText: NSAttributedString
    let controller: RichTextController
    let isEditable: Bool
    @Environment(\.colorScheme) var colorScheme

    /// 当前显示的笔记 ID，用来判断是否发生了“切换笔记”（从而强制刷新内容）
    let noteID: UUID
    let readingPosition: NoteReadingPosition?
    let onReadingPositionChange: (UUID, Int, Double) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.autoresizingMask = [.width, .height]
        
        let scheme = colorScheme
        scroll.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        let textView = RichTextView()
        scroll.setAccessibilityIdentifier("notebook.noteBodyScroll")
        textView.setAccessibilityIdentifier("notebook.noteBody")
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
        // TextKit 只布局视口附近的字形；全文仍保留在 NSTextStorage 中，
        // 因而滚动条、全文选择和保存语义不变。
        Self.configureViewportLayout(in: textView, contentLength: attributedText.length)

        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = .textColor
        // 使用用户设置的字体
        textView.font = AppSettings.shared.editorFont
        textView.delegate = context.coordinator
        textView.pasteCoordinator = context.coordinator

        textView.typingAttributes = [
            .font: AppSettings.shared.editorFont,
            .foregroundColor: Self.adaptiveDefaultTextColor
        ]

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
        context.coordinator.bindAttachmentViewport(scrollView: scroll, textView: textView)
        context.coordinator.configureReadingPosition(
            noteID: noteID,
            position: readingPosition,
            onChange: onReadingPositionChange
        )
        context.coordinator.lastAppliedNoteID = noteID
        context.coordinator.lastAppliedColorScheme = scheme
        context.coordinator.restoreReadingPositionWhenReady()

        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? RichTextView else { return }
        let didSwitchNote = context.coordinator.lastAppliedNoteID != noteID
        let didChangeColorScheme = context.coordinator.lastAppliedColorScheme != colorScheme

        context.coordinator.updateReadingPositionHandler(onReadingPositionChange)

        // 确保 pasteCoordinator 始终是最新的
        textView.pasteCoordinator = context.coordinator

        let scheme = colorScheme
        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = .textColor
        nsView.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        textView.isEditable = isEditable

        // 关键：切换笔记时强制刷新内容；同一笔记编辑时避免 update 覆盖用户输入。
        if didSwitchNote {
            let interval = Logger.shared.beginInterval(
                .editor,
                "richTextNoteSwitch",
                metadata: "from=\(context.coordinator.lastAppliedNoteID?.uuidString.prefix(8) ?? "nil") to=\(noteID.uuidString.prefix(8)) incomingLength=\(attributedText.length) existingLength=\(textView.string.count)"
            )

            context.coordinator.flushReadingPosition()
            context.coordinator.configureReadingPosition(
                noteID: noteID,
                position: readingPosition,
                onChange: onReadingPositionChange
            )
            context.coordinator.isProgrammaticUpdate = true
            context.coordinator.lastAppliedNoteID = noteID
            Self.configureViewportLayout(in: textView, contentLength: attributedText.length)

            // 清除撤销管理器，避免切换笔记后撤销操作导致崩溃
            // 先禁用撤销注册并清除所有操作；在所有内容修改完成后再重新启用，
            // 防止 setAttributedString 等内部操作错误地注册指向已释放对象的 undo target。
            if let undoManager = textView.undoManager {
                undoManager.disableUndoRegistration()
                undoManager.removeAllActions()
            }

            if let textStorage = textView.textStorage {
                textStorage.beginEditing()
                textStorage.setAttributedString(attributedText)
                textStorage.endEditing()
            }
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
            context.coordinator.noteContentDidChange()
            context.coordinator.restoreReadingPositionWhenReady()

            // 内容更新完成后再恢复撤销注册
            if let undoManager = textView.undoManager {
                undoManager.enableUndoRegistration()
            }
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

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        coordinator.flushDeferredBindingUpdate()
        coordinator.flushReadingPosition()
        coordinator.unbindAttachmentViewport()
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
        private var bindingUpdateWorkItem: DispatchWorkItem?

        private var fontChangeCancellable: AnyCancellable?
        private weak var attachmentScrollView: NSScrollView?
        private weak var attachmentTextView: NSTextView?
        private var attachmentViewportObservers: [NSObjectProtocol] = []
        private var visibleImageAttachments: [ObjectIdentifier: (AttachmentTextAttachment, NSRange)] = [:]
        private var readingPositionNoteID: UUID?
        private var pendingReadingPosition: NoteReadingPosition?
        private var readingPositionChangeHandler: ((UUID, Int, Double) -> Void)?
        private var readingPositionWorkItem: DispatchWorkItem?
        private var restoreGeneration = 0
        private var isRestoringReadingPosition = false

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

        func bindAttachmentViewport(scrollView: NSScrollView, textView: NSTextView) {
            unbindAttachmentViewport()
            attachmentScrollView = scrollView
            attachmentTextView = textView

            let clipView = scrollView.contentView
            clipView.postsBoundsChangedNotifications = true
            clipView.postsFrameChangedNotifications = true
            let center = NotificationCenter.default
            attachmentViewportObservers = [
                center.addObserver(
                    forName: NSView.boundsDidChangeNotification,
                    object: clipView,
                    queue: .main
                ) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        self?.refreshVisibleImageAttachments()
                        self?.scheduleReadingPositionCapture()
                    }
                },
                center.addObserver(
                    forName: NSView.frameDidChangeNotification,
                    object: clipView,
                    queue: .main
                ) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        self?.refreshVisibleImageAttachments()
                    }
                }
            ]
            noteContentDidChange()
        }

        func unbindAttachmentViewport() {
            readingPositionWorkItem?.cancel()
            readingPositionWorkItem = nil
            for observer in attachmentViewportObservers {
                NotificationCenter.default.removeObserver(observer)
            }
            attachmentViewportObservers.removeAll()
            for (attachment, _) in visibleImageAttachments.values {
                attachment.unloadDeferredImagePresentation()
            }
            visibleImageAttachments.removeAll()
            attachmentScrollView = nil
            attachmentTextView = nil
        }

        func configureReadingPosition(
            noteID: UUID,
            position: NoteReadingPosition?,
            onChange: @escaping (UUID, Int, Double) -> Void
        ) {
            readingPositionNoteID = noteID
            pendingReadingPosition = position
            readingPositionChangeHandler = onChange
        }

        func updateReadingPositionHandler(_ handler: @escaping (UUID, Int, Double) -> Void) {
            readingPositionChangeHandler = handler
        }

        func restoreReadingPositionWhenReady() {
            restoreGeneration += 1
            let generation = restoreGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self, generation == self.restoreGeneration else { return }
                self.restoreReadingPosition()
            }
        }

        private func restoreReadingPosition() {
            guard let position = pendingReadingPosition,
                  position.noteID == readingPositionNoteID,
                  let scrollView = attachmentScrollView,
                  let textView = attachmentTextView,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }

            let textLength = textView.textStorage?.length ?? 0
            guard textLength > 0 else { return }
            let characterIndex = min(max(position.anchorUTF16Offset, 0), textLength - 1)
            layoutManager.ensureLayout(
                forCharacterRange: NSRange(location: characterIndex, length: 1)
            )
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: characterIndex, length: 1),
                actualCharacterRange: nil
            )
            var anchorRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            anchorRect.origin.y += textView.textContainerInset.height

            let clipView = scrollView.contentView
            let viewportHeight = max(clipView.bounds.height, 1)
            let documentHeight = max(textView.bounds.height, anchorRect.maxY)
            let desiredY = anchorRect.minY - position.viewportOffsetFraction * viewportHeight
            let maximumY = max(0, documentHeight - viewportHeight)
            isRestoringReadingPosition = true
            clipView.scroll(to: NSPoint(x: clipView.bounds.minX, y: min(max(desiredY, 0), maximumY)))
            scrollView.reflectScrolledClipView(clipView)
            isRestoringReadingPosition = false
            pendingReadingPosition = nil
        }

        private func scheduleReadingPositionCapture() {
            guard !isRestoringReadingPosition, !isProgrammaticUpdate else { return }
            readingPositionWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.captureReadingPosition()
            }
            readingPositionWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: workItem)
        }

        func flushReadingPosition() {
            readingPositionWorkItem?.cancel()
            readingPositionWorkItem = nil
            captureReadingPosition()
        }

        private func captureReadingPosition() {
            guard !isRestoringReadingPosition,
                  let noteID = readingPositionNoteID,
                  let handler = readingPositionChangeHandler,
                  let scrollView = attachmentScrollView,
                  let textView = attachmentTextView,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer,
                  (textView.textStorage?.length ?? 0) > 0 else { return }

            let clipBounds = scrollView.contentView.bounds
            let topInContainer = max(0, clipBounds.minY - textView.textContainerInset.height)
            let probeRect = NSRect(x: 0, y: topInContainer, width: max(textContainer.containerSize.width, 1), height: 1)
            let glyphRange = layoutManager.glyphRange(forBoundingRect: probeRect, in: textContainer)
            guard glyphRange.location != NSNotFound, glyphRange.length > 0 else { return }
            let characterRange = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
            guard characterRange.location != NSNotFound else { return }

            var anchorRect = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyphRange.location, length: 1), in: textContainer)
            anchorRect.origin.y += textView.textContainerInset.height
            let fraction = (anchorRect.minY - clipBounds.minY) / max(clipBounds.height, 1)
            let clampedFraction = min(max(fraction, -1), 1)
            DispatchQueue.main.async {
                handler(noteID, characterRange.location, clampedFraction)
            }
        }

        func noteContentDidChange() {
            for (attachment, _) in visibleImageAttachments.values {
                attachment.unloadDeferredImagePresentation()
            }
            visibleImageAttachments.removeAll()
            DispatchQueue.main.async { [weak self] in
                self?.refreshVisibleImageAttachments()
            }
        }

        private func refreshVisibleImageAttachments() {
            guard let scrollView = attachmentScrollView,
                  let textView = attachmentTextView,
                  let textStorage = textView.textStorage,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer,
                  textStorage.length > 0 else { return }

            let visibleRect = scrollView.contentView.bounds.offsetBy(
                dx: -textView.textContainerInset.width,
                dy: -textView.textContainerInset.height
            )
            let preloadHeight = max(visibleRect.height, 1)
            let preloadRect = visibleRect.insetBy(dx: 0, dy: -preloadHeight)
            let glyphRange = layoutManager.glyphRange(forBoundingRect: preloadRect, in: textContainer)
            let characterRange = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
            guard characterRange.location != NSNotFound, characterRange.length > 0 else { return }

            var nextVisible: [ObjectIdentifier: (AttachmentTextAttachment, NSRange)] = [:]
            textStorage.enumerateAttribute(.attachment, in: characterRange, options: []) { value, range, _ in
                guard let attachment = value as? AttachmentTextAttachment,
                      attachment.kind == .image else { return }
                if !attachment.isImagePresentationLoaded {
                    attachment.refreshPresentationIfNeeded()
                }
                nextVisible[ObjectIdentifier(attachment)] = (attachment, range)
            }

            for (identifier, (attachment, range)) in visibleImageAttachments where nextVisible[identifier] == nil {
                attachment.unloadDeferredImagePresentation()
                layoutManager.invalidateDisplay(forCharacterRange: range)
            }
            for (_, range) in nextVisible.values {
                layoutManager.invalidateDisplay(forCharacterRange: range)
            }
            visibleImageAttachments = nextVisible
            textView.needsDisplay = true
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
                newAttrs[NSAttributedString.Key.font] = font
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
            bindingUpdateWorkItem?.cancel()
            bindingUpdateWorkItem = nil
            if let content = textView.attributedString().copy() as? NSAttributedString {
                self.attributedText = content
            }
            pendingContent = nil
            controller?.setDeferredBindingUpdatePending(false)
        }

        func flushDeferredBindingUpdate() {
            guard let textView = controller?.textView else {
                bindingUpdateWorkItem?.cancel()
                bindingUpdateWorkItem = nil
                controller?.setDeferredBindingUpdatePending(false)
                return
            }
            guard bindingUpdateWorkItem != nil || controller?.requiresCommittedSnapshotOnSwitch == true else {
                return
            }
            flushPendingContent(from: textView)
        }

        private func scheduleDeferredBindingUpdate(from textView: NSTextView) {
            bindingUpdateWorkItem?.cancel()
            controller?.setDeferredBindingUpdatePending(true)
            let workItem = DispatchWorkItem { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.flushPendingContent(from: textView)
                self.controller?.refreshNoteSearchResultsIfNeeded()
            }
            bindingUpdateWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22, execute: workItem)
        }

        /// 在非文本编辑场景（如附件缩放）主动同步绑定
        func syncBindingFromTextView(_ textView: NSTextView) {
            guard !isProgrammaticUpdate else { return }
            flushPendingContent(from: textView)
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
            
            // 检查是否有输入法正在编辑的 marked text
            if checkHasMarkedText(tv) {
                // 输入法正在编辑，延迟更新绑定
                hasMarkedText = true
                pendingContent = nil
                bindingUpdateWorkItem?.cancel()
                bindingUpdateWorkItem = nil
                controller?.setDeferredBindingUpdatePending(true)
                return
            }

            if tv.textStorage?.length ?? 0 >= RichTextEditor.longDocumentCharacterThreshold {
                hasMarkedText = false
                pendingContent = nil
                scheduleDeferredBindingUpdate(from: tv)
                return
            }

            // 普通文档立即同步；长文档走上面的短延迟，避免每个按键复制全文。
            guard let content = tv.attributedString().copy() as? NSAttributedString else { return }
            
            // 没有 marked text，直接更新
            hasMarkedText = false
            pendingContent = nil
            self.attributedText = content
            controller?.setDeferredBindingUpdatePending(false)
            controller?.refreshNoteSearchResultsIfNeeded()
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
            DebugLog.editor("handlePaste called", level: .debug)
            let pasteboard = NSPasteboard.general

            // 获取当前笔记ID
            guard let noteID = controller?.attachmentTargetNoteID() else {
                DebugLog.editor("No noteID available", level: .debug)
                return false
            }
            DebugLog.editor("noteID: \(noteID.uuidString.prefix(8))", level: .debug)

            // 打印剪贴板类型信息
            let types = pasteboard.types ?? []
            DebugLog.editor("Pasteboard types: \(types)", level: .debug)

            // 1. 首先尝试读取文件URL（从Finder复制的文件）- 优先处理原文件
            if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
               !fileURLs.isEmpty {
                DebugLog.editor("File URLs found: \(fileURLs)", level: .debug)
                // 只处理第一个文件
                let fileURL = fileURLs[0]

                // 检查是否是图片文件
                let imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "heic", "webp"]
                let ext = fileURL.pathExtension.lowercased()

                if imageExtensions.contains(ext) {
                    DebugLog.editor("Image file detected: \(ext)", level: .debug)
                    // 是图片文件，复制到附件目录
                    do {
                        let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: fileURL, noteID: noteID, kind: .image)
                        insertAttachment(at: destURL, kind: .image, in: textView)
                        return true
                    } catch {
                        DebugLog.editor("Failed to copy image file: \(error)", level: .warn)
                        return false
                    }
                }
                DebugLog.editor("Not an image file: \(ext)", level: .debug)
                // 其他类型文件不处理，返回false让系统处理
                return false
            }

            // 2. 尝试读取图片数据（截图或复制的图片数据）
            if let image = readImageFromPasteboard(pasteboard) {
                DebugLog.editor("Image data found in pasteboard", level: .debug)
                do {
                    let destURL = try savePastedImage(image: image, noteID: noteID)
                    insertAttachment(at: destURL, kind: .image, in: textView)
                    return true
                } catch {
                    DebugLog.editor("Failed to save pasted image: \(error)", level: .warn)
                    return false
                }
            }
            DebugLog.editor("No image found in pasteboard", level: .debug)

            // 3. 尝试读取HTML表格并转换为TableTextAttachment
            if let htmlString = pasteboard.string(forType: .html) ?? pasteboard.string(forType: NSPasteboard.PasteboardType("public.html")) {
                DebugLog.editor("HTML content found, checking for table", level: .debug)
                if let tableData = parseHTMLTable(htmlString) {
                    DebugLog.editor("Table detected in HTML, converting to TableTextAttachment", level: .debug)
                    insertTableAttachment(tableData: tableData, in: textView)
                    return true
                }
            }

            // 如果不是图片或文件，返回false让系统处理其他粘贴类型
            DebugLog.editor("No file URLs found, falling back to default paste", level: .debug)
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

            let attributedString = NSMutableAttributedString(attachment: attachment)
            if let data = try? JSONEncoder().encode(tableData) {
                attributedString.addAttribute(.notebookTableData, value: data, range: NSRange(location: 0, length: attributedString.length))
            }
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
            DebugLog.editor("handleDroppedImage called: \(fileURL)", level: .debug)
            
            guard let noteID = controller?.attachmentTargetNoteID() else {
                DebugLog.editor("No noteID available for drop", level: .debug)
                return false
            }
            
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: fileURL, noteID: noteID, kind: .image)
                insertAttachment(at: destURL, kind: .image, in: textView)
                DebugLog.editor("Dropped image handled successfully", level: .debug)
                return true
            } catch {
                DebugLog.editor("Failed to handle dropped image: \(error)", level: .warn)
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
