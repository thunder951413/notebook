import SwiftUI
import AppKit

// MARK: - 笔记 Markdown 预览视图

struct NoteMarkdownPreviewView: View {
    @ObservedObject private var settings = AppSettings.shared
    let content: NSAttributedString
    let colorScheme: ColorScheme
    let noteID: UUID
    var readingPosition: NoteReadingPosition? = nil
    var onReadingPositionChange: ((UUID, Int, Double) -> Void)? = nil
    @State private var webViewHeight: CGFloat = 500
    @State private var scrollOffset: CGFloat = 0
    @State private var renderedContent: NSAttributedString = NSAttributedString(string: "")
    @State private var renderWorkItem: DispatchWorkItem?

    private var contentRevision: Int {
        // 不能只看 content.string：附件尺寸变化不会触发
        // 也不能只看 RTFD：自定义尺寸属性不会稳定进入 RTFD
        var hasher = Hasher()
        hasher.combine(content.string)
        hasher.combine(content.length)

        let fullRange = NSRange(location: 0, length: content.length)
        content.enumerateAttributes(in: fullRange, options: []) { attrs, range, _ in
            if let attachment = attrs[.attachment] as? NSTextAttachment {
                hasher.combine(range.location)
                hasher.combine(range.length)
                hasher.combine(Int(attachment.bounds.width.rounded()))
                hasher.combine(Int(attachment.bounds.height.rounded()))
            }

            if let w = attrs[.notebookImageWidth] as? CGFloat {
                hasher.combine(Int(w.rounded()))
            }
            if let h = attrs[.notebookImageHeight] as? CGFloat {
                hasher.combine(Int(h.rounded()))
            }
            if let link = attrs[.link] as? String, link.hasPrefix("notebook-image://") {
                hasher.combine(link)
            }
        }

        return hasher.finalize()
    }

    var body: some View {
        MarkdownWebView(
            markdown: renderedContent.string,
            attributedContent: renderedContent,
            colorScheme: colorScheme,
            height: $webViewHeight,
            noteID: noteID,
            renderAttributedContent: false,
            readingPosition: readingPosition,
            onReadingPositionChange: onReadingPositionChange,
            readerFontSize: settings.readerFontSize,
            readerLineHeight: settings.readerLineHeight,
            readerMaxWidth: settings.readerMaxWidth
        )
        .frame(maxHeight: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(AppColors.editorBackground(colorScheme))
        .onAppear {
            renderedContent = content.copy() as? NSAttributedString ?? content
        }
        .onDisappear {
            renderWorkItem?.cancel()
        }
        .onChange(of: contentRevision) { _, _ in
            renderWorkItem?.cancel()
            let snapshot = content.copy() as? NSAttributedString ?? content
            let workItem = DispatchWorkItem {
                renderedContent = snapshot
            }
            renderWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: workItem)
        }
    }
}
