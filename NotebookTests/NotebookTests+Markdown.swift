import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

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
