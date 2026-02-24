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
    func snapshotAttributedString() -> NSAttributedString {
        guard let tv = textView else {
            print("[RichTextController] snapshot: textView is nil")
            return NSAttributedString(string: "")
        }
        
        let content = tv.attributedString()
        print("[RichTextController] snapshot: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)")
        
        // 强制结束输入法会话（防止中文输入未提交时内容丢失）
        if let inputContext = tv.inputContext {
            let hasMarked = (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
            if hasMarked {
                inputContext.discardMarkedText()
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
        return tv.attributedString().copy() as! NSAttributedString
    }
    
    /// 获取当前编辑器内容的快照（不结束输入法会话）
    func snapshotAttributedStringPreservingMarkedText() -> NSAttributedString? {
        guard let tv = textView else {
            print("[RichTextController] snapshotPreserving: textView is nil")
            return nil
        }
        
        // 如果有 marked text，返回 nil 表示不应该保存
        if hasMarkedText {
            print("[RichTextController] snapshotPreserving: has marked text, skipping")
            return nil
        }
        
        let content = tv.attributedString()
        print("[RichTextController] snapshotPreserving: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)")
        
        // 获取当前 attributedString 的副本
        return content.copy() as? NSAttributedString
    }

    /// 强制同步内容
    func forceSync() {
        guard let tv = textView else { return }
        tv.didChangeText()
    }

    func toggleBold() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("toggleBoldface:")))
    }

    func toggleItalic() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("toggleItalics:")))
    }

    func toggleUnderline() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("underline:")))
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

    func toggleBullets() {
        guard let tv = textView else { return }
        tv.toggleContinuousSpellChecking(nil)
        prefixSelectedLines(with: "• ")
    }

    func toggleNumberedList() {
        prefixSelectedLines(withNumbering: true)
    }

    func insertCheckbox() {
        insertText("[ ] ")
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
            let content = tv.attributedString().copy() as! NSAttributedString
            
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
            let content = textView.attributedString().copy() as! NSAttributedString
            self.attributedText = content
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
