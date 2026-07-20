import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {
    @MainActor
    func testMarkdownPreviewUsesBundledMermaidAndBlocksNetworkScripts() {
        let renderer = MarkdownHTMLRenderer(
            markdown: "```mermaid\ngraph TD; A-->B\n```",
            attributedContent: nil,
            colorScheme: .light,
            noteID: UUID(),
            renderAttributedContent: false
        )

        let html = renderer.generateHTML()
        XCTAssertTrue(html.contains("MarkdownPreviewAssets.bundle/Contents/Resources/mermaid.min.js"))
        XCTAssertTrue(html.contains("connect-src 'none'"))
        XCTAssertFalse(html.contains("cdn.jsdelivr.net"))
        XCTAssertFalse(html.contains("https://cdn"))
    }


    func testMarkdownPreviewKeepsMarkdownSyntaxWhenAttributedRenderingIsDisabled() {
        let markdown = "# 一级标题\n\n这是 **粗体** 和 [链接](https://example.com)。"
        let content = NSMutableAttributedString(string: markdown)
        content.addAttributes([
            .font: AppSettings.shared.editorFont,
            .foregroundColor: NSColor.textColor
        ], range: NSRange(location: 0, length: content.length))

        let html = MarkdownWebView(
            markdown: markdown,
            attributedContent: content,
            colorScheme: .light,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: markdown, attributed: content, colorScheme: .light, renderAttributedContent: false)

        XCTAssertTrue(html.contains("<h1"))
        XCTAssertTrue(html.contains("<strong>粗体</strong>"))
        XCTAssertTrue(html.contains("href=\"https://example.com\""))
        XCTAssertFalse(html.contains("# 一级标题"))
        XCTAssertTrue(html.contains("class=\"notebook-block\""))
        XCTAssertTrue(html.contains("content-visibility: auto"))
    }

    func testMarkdownPreviewAppliesReaderTypographyWithoutChangingEscaping() {
        let markdown = "第一段\n\n<script>alert('x')</script>\n\n第三段"
        let html = MarkdownWebView(
            markdown: markdown,
            attributedContent: nil,
            colorScheme: .light,
            height: .constant(0),
            noteID: UUID(),
            readerFontSize: 21,
            readerLineHeight: 1.75,
            readerMaxWidth: 720
        ).generateHTML(from: markdown, attributed: nil, colorScheme: .light)

        XCTAssertTrue(html.contains("font-size: 21.0px"))
        XCTAssertTrue(html.contains("line-height: 1.75"))
        XCTAssertTrue(html.contains("max-width: 720.0px"))
        XCTAssertTrue(html.contains("&lt;script&gt;alert('x')&lt;/script&gt;"))
        XCTAssertFalse(html.contains("<script>alert('x')</script>"))
        XCTAssertGreaterThanOrEqual(html.components(separatedBy: "class=\"notebook-block\"").count - 1, 3)
    }

    func testMarkdownPreviewRendersSixHundredKilobytesIntoLazyLayoutBlocks() {
        let paragraph = "长文窗口测试：中文换行、emoji 🧭、Markdown **粗体** 与稳定滚动条。"
        let markdown = (0..<6_000)
            .map { "## 第 \($0) 节\n\n\(paragraph) 编号 \($0)。" }
            .joined(separator: "\n\n")
        XCTAssertGreaterThan(markdown.lengthOfBytes(using: .utf8), 600 * 1_024)

        let html = MarkdownHTMLRenderer(
            markdown: markdown,
            attributedContent: nil,
            colorScheme: .light,
            noteID: UUID(),
            renderAttributedContent: false
        ).generateHTML()

        XCTAssertTrue(html.contains("第 5999 节"))
        XCTAssertGreaterThan(html.components(separatedBy: "class=\"notebook-block\"").count - 1, 5_000)
        XCTAssertTrue(html.contains("content-visibility: auto"))
    }

    func testMarkdownPreviewExplicitMarkdownModeIgnoresAutomaticLinkAttributes() {
        let markdown = """
        # 环境搭建

        [Roku Thompsons](https://confluence.example.com/display/SW/Roku)

        ## Android u公版环境搭建

        https://confluence.example.com/display/SW/Android+U
        """
        let content = NSMutableAttributedString(string: markdown)
        content.addAttributes([
            .font: AppSettings.shared.editorFont,
            .foregroundColor: NSColor.textColor
        ], range: NSRange(location: 0, length: content.length))

        let nsText = markdown as NSString
        let markdownURLRange = nsText.range(of: "https://confluence.example.com/display/SW/Roku")
        let rawURLRange = nsText.range(of: "https://confluence.example.com/display/SW/Android+U")
        content.addAttribute(.link, value: URL(string: "https://confluence.example.com/display/SW/Roku")!, range: markdownURLRange)
        content.addAttribute(.link, value: URL(string: "https://confluence.example.com/display/SW/Android+U")!, range: rawURLRange)

        let html = MarkdownWebView(
            markdown: markdown,
            attributedContent: content,
            colorScheme: .light,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: markdown, attributed: content, colorScheme: .light, renderAttributedContent: false)

        XCTAssertTrue(html.contains("<h1"))
        XCTAssertTrue(html.contains("<h2"))
        XCTAssertTrue(html.contains(">Roku Thompsons</a>"))
        XCTAssertFalse(html.contains("# 环境搭建"))
        XCTAssertFalse(html.contains("## Android u公版环境搭建"))
    }

    func testMarkdownPreviewUsesThemeTextColorForLegacyDefaultBlackInDarkMode() {
        let content = NSMutableAttributedString(string: "深色预览")
        content.addAttribute(.foregroundColor, value: NSColor.black, range: NSRange(location: 0, length: content.length))

        let html = MarkdownWebView(
            markdown: "",
            attributedContent: content,
            colorScheme: .dark,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: "", attributed: content, colorScheme: .dark)

        XCTAssertFalse(html.contains("color: #000000"))
        XCTAssertTrue(html.contains("color: #FFFFFF"))
    }

    @MainActor


    func testMarkdownPreviewRendersInlineRichTextStyles() {
        let content = NSMutableAttributedString(string: "预览样式")
        let fullRange = NSRange(location: 0, length: content.length)
        content.addAttributes([
            .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .foregroundColor: NSColor(calibratedRed: 1, green: 0, blue: 0, alpha: 1),
            .link: URL(string: "https://example.com")!
        ], range: fullRange)

        let html = MarkdownWebView(
            markdown: "",
            attributedContent: content,
            colorScheme: ColorScheme.light,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: "", attributed: content, colorScheme: ColorScheme.light)

        XCTAssertTrue(html.contains("href=\"https://example.com\""))
        XCTAssertTrue(html.contains("font-weight"))
        XCTAssertTrue(html.contains("text-decoration"))
        XCTAssertTrue(html.contains("color:"))
        XCTAssertTrue(html.contains("预览样式"))
    }
}
