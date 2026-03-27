import AppKit
import SwiftUI

/// 表格附件单元格 - 处理表格的点击和编辑
class TableAttachmentCell: NSTextAttachmentCell {
    private var tableData: TableData?
    private weak var textView: NSTextView?
    private var tableAttachment: TableTextAttachment?
    
    func configure(with attachment: TableTextAttachment, in textView: NSTextView?) {
        self.tableData = attachment.tableData
        self.tableAttachment = attachment
        self.textView = textView
    }
    
    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        guard let data = tableData else {
            super.draw(withFrame: cellFrame, in: controlView)
            return
        }
        
        let bgColor = AttachmentAppearance.backgroundColor
        let borderColor = AttachmentAppearance.borderColor
        let textColor = AttachmentAppearance.primaryTextColor
        
        bgColor.setFill()
        cellFrame.fill()
        
        let borderWidth: CGFloat = 1
        var y: CGFloat = borderWidth
        for row in 0..<data.rowCount {
            var x: CGFloat = borderWidth
            for col in 0..<data.columnCount {
                let cellRect = NSRect(
                    x: cellFrame.origin.x + x,
                    y: cellFrame.origin.y + y,
                    width: data.columnWidths[col],
                    height: data.rowHeights[row]
                )
                
                borderColor.setStroke()
                let path = NSBezierPath(rect: cellRect)
                path.lineWidth = 0.5
                path.stroke()
                
                let text = data.rows[row][col]
                if !text.isEmpty {
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: NSFont.systemFont(ofSize: 12),
                        .foregroundColor: textColor
                    ]
                    let attrStr = NSAttributedString(string: text, attributes: attrs)
                    let textSize = attrStr.size()
                    let textRect = NSRect(
                        x: cellRect.minX + 4,
                        y: cellRect.midY - textSize.height / 2,
                        width: cellRect.width - 8,
                        height: textSize.height
                    )
                    attrStr.draw(in: textRect)
                }
                
                x += data.columnWidths[col] + borderWidth
            }
            y += data.rowHeights[row] + borderWidth
        }
        
        borderColor.setStroke()
        let outerPath = NSBezierPath(rect: cellFrame.insetBy(dx: 0.5, dy: 0.5))
        outerPath.lineWidth = 1
        outerPath.stroke()
    }
    
    override func trackMouse(with theEvent: NSEvent, in cellFrame: NSRect, of controlView: NSView?, untilMouseUp flag: Bool) -> Bool {
        if theEvent.type == .leftMouseDown && theEvent.clickCount == 2 {
            showTableEditor(in: cellFrame, of: controlView)
            return true
        }
        
        if theEvent.type == .rightMouseDown {
            showContextMenu(in: cellFrame, of: controlView, with: theEvent)
            return true
        }
        
        return super.trackMouse(with: theEvent, in: cellFrame, of: controlView, untilMouseUp: flag)
    }
    
    override func wantsToTrackMouse() -> Bool {
        return true
    }
    
    private func showTableEditor(in cellFrame: NSRect, of controlView: NSView?) {
        guard let attachment = tableAttachment else { return }
        
        let data = attachment.tableData
        
        let editorView = InlineTableEditorView(
            tableData: data,
            onCellEdited: { [weak attachment] row, col, value in
                attachment?.updateCell(row: row, column: col, value: value)
            },
            onStructureChanged: { [weak attachment] newData in
                attachment?.tableData = newData
                attachment?.updateImage()
            }
        )
        
        let hostingController = NSHostingController(rootView: editorView)
        hostingController.sizingOptions = .preferredContentSize
        
        let popover = NSPopover()
        popover.contentViewController = hostingController
        popover.behavior = .transient
        if let view = controlView {
            popover.show(relativeTo: cellFrame, of: view, preferredEdge: .maxY)
        }
        
        hostingController.view.window?.makeKey()
    }
    
    private func showContextMenu(in cellFrame: NSRect, of controlView: NSView?, with event: NSEvent) {
        guard tableAttachment != nil else { return }
        
        let menu = NSMenu()
        
        menu.addItem(withTitle: "编辑表格", action: #selector(editTable(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "添加行", action: #selector(addRow(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "添加列", action: #selector(addColumn(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "删除表格", action: #selector(deleteTable(_:)), keyEquivalent: "")
        
        if let view = controlView {
            NSMenu.popUpContextMenu(menu, with: event, for: view)
        }
    }
    
    @objc private func editTable(_ sender: Any?) {
        guard let attachment = tableAttachment else { return }
        
        let editorView = InlineTableEditorView(
            tableData: attachment.tableData,
            onCellEdited: { [weak attachment] row, col, value in
                attachment?.updateCell(row: row, column: col, value: value)
            },
            onStructureChanged: { [weak attachment] newData in
                attachment?.tableData = newData
                attachment?.updateImage()
            }
        )
        
        let hostingController = NSHostingController(rootView: editorView)
        
        let panel = NSPanel(contentViewController: hostingController)
        panel.title = "编辑表格"
        panel.styleMask = [.titled, .closable, .resizable]
        panel.setContentSize(NSSize(width: 500, height: 400))
        
        NSApp.runModal(for: panel)
    }
    
    @objc private func addRow(_ sender: Any?) {
        tableAttachment?.addRow()
    }
    
    @objc private func addColumn(_ sender: Any?) {
        tableAttachment?.addColumn()
    }
    
    @objc private func deleteTable(_ sender: Any?) {
        guard let textView = textView, let attachment = tableAttachment else { return }
        
        let textStorage = textView.textStorage
        let fullRange = NSRange(location: 0, length: textStorage?.length ?? 0)
        
        textStorage?.enumerateAttribute(.attachment, in: fullRange, options: []) { value, range, _ in
            if let att = value as? TableTextAttachment, att === attachment {
                textStorage?.deleteCharacters(in: range)
            }
        }
    }
}

/// 内联表格编辑视图
struct InlineTableEditorView: NSViewRepresentable {
    var tableData: TableData
    var onCellEdited: (Int, Int, String) -> Void
    var onStructureChanged: (TableData) -> Void
    
    func makeNSView(context: Context) -> TableAttachmentNSView {
        let view = TableAttachmentNSView()
        view.configure(
            tableData: tableData,
            onCellEdited: onCellEdited,
            onStructureChanged: { [onStructureChanged, weak view] in
                if let data = view?.tableData {
                    onStructureChanged(data)
                }
            }
        )
        return view
    }
    
    func updateNSView(_ nsView: TableAttachmentNSView, context: Context) {
        nsView.updateTableData(tableData)
    }
}
