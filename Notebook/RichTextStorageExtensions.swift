import Foundation
import AppKit

extension NSAttributedString.Key {
    static let notebookImageWidth = NSAttributedString.Key("NotebookImageWidth")
    static let notebookImageHeight = NSAttributedString.Key("NotebookImageHeight")
    static let notebookTableData = NSAttributedString.Key("NotebookTableData")
    static let notebookHeadingLevel = NSAttributedString.Key("NotebookHeadingLevel")
    static let notebookExplicitBold = NSAttributedString.Key("NotebookExplicitBold")
    static let notebookExplicitItalic = NSAttributedString.Key("NotebookExplicitItalic")
    static let notebookExplicitFontFamily = NSAttributedString.Key("NotebookExplicitFontFamily")
    static let notebookExplicitFontSize = NSAttributedString.Key("NotebookExplicitFontSize")
    static let notebookExplicitForegroundColor = NSAttributedString.Key("NotebookExplicitForegroundColor")
}

extension NSAttributedString {
    func cleanedForStorage() -> NSAttributedString {
        let range = NSRange(location: 0, length: self.length)
        let mutable = NSMutableAttributedString(attributedString: self)

        let allowedKeys: [NSAttributedString.Key] = [
            .font,
            .foregroundColor,
            .backgroundColor,
            .underlineStyle,
            .underlineColor,
            .strikethroughStyle,
            .paragraphStyle,
            .attachment,
            .link,
            .kern,
            .baselineOffset,
            .notebookImageWidth,
            .notebookImageHeight,
            .notebookTableData,
            .notebookHeadingLevel,
            .notebookExplicitBold,
            .notebookExplicitItalic,
            .notebookExplicitFontFamily,
            .notebookExplicitFontSize,
            .notebookExplicitForegroundColor
        ]

        // 先确保所有复选框附件和表格附件的图像已生成
        DebugLog.editor("cleanedForStorage: checking attachments...", level: .debug)
        mutable.enumerateAttribute(.attachment, in: range, options: []) { value, attrRange, _ in
            if let checkbox = value as? CheckboxTextAttachment {
                DebugLog.editor("Found CheckboxTextAttachment, calling prepareForSaving", level: .debug)
                checkbox.prepareForSaving()
            }
            if let tableAttachment = value as? TableTextAttachment {
                DebugLog.editor("Found TableTextAttachment, calling prepareForSaving", level: .debug)
                tableAttachment.prepareForSaving()
                if let data = try? JSONEncoder().encode(tableAttachment.tableData) {
                    DebugLog.editor("cleanedForStorage write notebookTableData bytes=\(data.count) rows=\(tableAttachment.tableData.rowCount)", level: .debug)
                    mutable.addAttribute(.notebookTableData, value: data, range: attrRange)
                } else {
                    DebugLog.editor("cleanedForStorage failed to encode tableData", level: .warn)
                }
            }
        }

        mutable.enumerateAttributes(in: range, options: []) { attributes, subRange, _ in
            for key in attributes.keys {
                if !allowedKeys.contains(key) {
                    mutable.removeAttribute(key, range: subRange)
                }
            }
        }

        return NSAttributedString(attributedString: mutable)
    }
}
