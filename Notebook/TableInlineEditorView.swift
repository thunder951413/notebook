import AppKit
import SwiftUI

/// 内联表格编辑器 - 直接在文本中显示可编辑的表格
class TableInlineEditorView: NSView {
    private var tableData: TableData
    private var onDataChanged: ((TableData) -> Void)?
    private var onCellEdited: ((Int, Int, String) -> Void)?
    
    private var selectedCell: (row: Int, col: Int)?
    private var editingCell: (row: Int, col: Int)?
    private var textField: NSTextField?
    
    private let cellPadding: CGFloat = 4
    private let borderWidth: CGFloat = 0.5
    
    init(tableData: TableData, onDataChanged: ((TableData) -> Void)? = nil, onCellEdited: ((Int, Int, String) -> Void)? = nil) {
        self.tableData = tableData
        self.onDataChanged = onDataChanged
        self.onCellEdited = onCellEdited
        super.init(frame: .zero)
        setupView()
    }
    
    required init?(coder: NSCoder) {
        self.tableData = TableData()
        super.init(coder: coder)
        setupView()
    }
    
    private func setupView() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        updateFrame()
    }
    
    private func updateFrame() {
        let totalWidth = tableData.columnWidths.reduce(0, +) + CGFloat(tableData.columnCount + 1) * borderWidth
        let totalHeight = tableData.rowHeights.reduce(0, +) + CGFloat(tableData.rowCount + 1) * borderWidth
        frame = NSRect(x: 0, y: 0, width: totalWidth, height: totalHeight)
    }
    
    func updateTableData(_ data: TableData) {
        self.tableData = data
        updateFrame()
        needsDisplay = true
    }
    
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        
        let bgColor = AttachmentAppearance.backgroundColor
        let borderColor = AttachmentAppearance.borderColor
        let textColor = AttachmentAppearance.primaryTextColor
        let selectionColor = AttachmentAppearance.selectionColor
        
        bgColor.setFill()
        bounds.fill()
        
        var y: CGFloat = borderWidth
        for row in 0..<tableData.rowCount {
            var x: CGFloat = borderWidth
            for col in 0..<tableData.columnCount {
                let cellRect = NSRect(
                    x: x,
                    y: y,
                    width: tableData.columnWidths[col],
                    height: tableData.rowHeights[row]
                )
                
                // 绘制选中背景
                if selectedCell?.row == row && selectedCell?.col == col {
                    selectionColor.setFill()
                    cellRect.fill()
                }
                
                // 绘制单元格边框
                borderColor.setStroke()
                let path = NSBezierPath(rect: cellRect)
                path.lineWidth = borderWidth
                path.stroke()
                
                // 如果不是正在编辑的单元格，绘制文本
                if !(editingCell?.row == row && editingCell?.col == col) {
                    let text = tableData.rows[row][col]
                    if !text.isEmpty {
                        let attrs: [NSAttributedString.Key: Any] = [
                            .font: NSFont.systemFont(ofSize: 12),
                            .foregroundColor: textColor
                        ]
                        let attrStr = NSAttributedString(string: text, attributes: attrs)
                        let textSize = attrStr.size()
                        let textRect = NSRect(
                            x: cellRect.minX + cellPadding,
                            y: cellRect.midY - textSize.height / 2,
                            width: cellRect.width - cellPadding * 2,
                            height: textSize.height
                        )
                        attrStr.draw(in: textRect)
                    }
                }
                
                x += tableData.columnWidths[col] + borderWidth
            }
            y += tableData.rowHeights[row] + borderWidth
        }
        
        // 绘制外边框
        borderColor.setStroke()
        let outerPath = NSBezierPath(rect: bounds.insetBy(dx: borderWidth/2, dy: borderWidth/2))
        outerPath.lineWidth = borderWidth
        outerPath.stroke()
    }
    
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        
        if event.clickCount == 2 {
            if let cell = getCellAt(point: point) {
                startEditingCell(row: cell.row, col: cell.col)
                return
            }
        }
        
        if let cell = getCellAt(point: point) {
            selectedCell = cell
            needsDisplay = true
        }
    }
    
    override func rightMouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let cell = getCellAt(point: point) {
            selectedCell = cell
            needsDisplay = true
            showContextMenu(at: event.locationInWindow)
        }
    }
    
    private func getCellAt(point: NSPoint) -> (row: Int, col: Int)? {
        var y: CGFloat = borderWidth
        for row in 0..<tableData.rowCount {
            var x: CGFloat = borderWidth
            for col in 0..<tableData.columnCount {
                let cellRect = NSRect(
                    x: x,
                    y: y,
                    width: tableData.columnWidths[col],
                    height: tableData.rowHeights[row]
                )
                if cellRect.contains(point) {
                    return (row, col)
                }
                x += tableData.columnWidths[col] + borderWidth
            }
            y += tableData.rowHeights[row] + borderWidth
        }
        return nil
    }
    
    private func startEditingCell(row: Int, col: Int) {
        endEditing()
        
        editingCell = (row, col)
        selectedCell = (row, col)
        
        let cellRect = getCellRect(row: row, col: col)
        
        let tf = NSTextField(frame: cellRect.insetBy(dx: cellPadding, dy: 2))
        tf.bezelStyle = .squareBezel
        tf.isBezeled = false
        tf.drawsBackground = true
        tf.backgroundColor = .textBackgroundColor
        tf.focusRingType = .none
        tf.font = NSFont.systemFont(ofSize: 12)
        tf.stringValue = tableData.rows[row][col]
        tf.delegate = self
        tf.target = self
        tf.action = #selector(textFieldDidEndEditing(_:))
        
        addSubview(tf)
        window?.makeFirstResponder(tf)
        self.textField = tf
        
        needsDisplay = true
    }
    
    private func getCellRect(row: Int, col: Int) -> NSRect {
        var y: CGFloat = borderWidth
        for r in 0..<row {
            y += tableData.rowHeights[r] + borderWidth
        }
        
        var x: CGFloat = borderWidth
        for c in 0..<col {
            x += tableData.columnWidths[c] + borderWidth
        }
        
        return NSRect(
            x: x,
            y: y,
            width: tableData.columnWidths[col],
            height: tableData.rowHeights[row]
        )
    }
    
    @objc private func textFieldDidEndEditing(_ sender: NSTextField) {
        commitEditing()
    }
    
    private func commitEditing() {
        guard let editing = editingCell, let textField = textField else { return }
        
        let value = textField.stringValue
        tableData.rows[editing.row][editing.col] = value
        onCellEdited?(editing.row, editing.col, value)
        onDataChanged?(tableData)
        
        endEditing()
    }
    
    private func endEditing() {
        textField?.removeFromSuperview()
        textField = nil
        editingCell = nil
        needsDisplay = true
    }

    func finalizeEditing() {
        commitEditing()
    }

    func currentTableData() -> TableData {
        return tableData
    }
    
    private func showContextMenu(at location: NSPoint) {
        let menu = NSMenu()
        
        menu.addItem(withTitle: "在上方插入行", action: #selector(insertRowAbove(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "在下方插入行", action: #selector(insertRowBelow(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "在左侧插入列", action: #selector(insertColumnLeft(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "在右侧插入列", action: #selector(insertColumnRight(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "删除行", action: #selector(deleteCurrentRow(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "删除列", action: #selector(deleteCurrentColumn(_:)), keyEquivalent: "")
        
        NSMenu.popUpContextMenu(menu, with: NSEvent.mouseEvent(with: .rightMouseDown, location: location, modifierFlags: [], timestamp: 0, windowNumber: window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!, for: self)
    }
    
    @objc private func insertRowAbove(_ sender: Any?) {
        guard let selected = selectedCell else { return }
        tableData.addRow(at: selected.row)
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
    
    @objc private func insertRowBelow(_ sender: Any?) {
        guard let selected = selectedCell else { return }
        tableData.addRow(at: selected.row + 1)
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
    
    @objc private func insertColumnLeft(_ sender: Any?) {
        guard let selected = selectedCell else { return }
        tableData.addColumn(at: selected.col)
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
    
    @objc private func insertColumnRight(_ sender: Any?) {
        guard let selected = selectedCell else { return }
        tableData.addColumn(at: selected.col + 1)
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
    
    @objc private func deleteCurrentRow(_ sender: Any?) {
        guard let selected = selectedCell, tableData.rowCount > 1 else { return }
        tableData.removeRow(at: selected.row)
        selectedCell = nil
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
    
    @objc private func deleteCurrentColumn(_ sender: Any?) {
        guard let selected = selectedCell, tableData.columnCount > 1 else { return }
        tableData.removeColumn(at: selected.col)
        selectedCell = nil
        onDataChanged?(tableData)
        updateFrame()
        needsDisplay = true
    }
}

extension TableInlineEditorView: NSTextFieldDelegate {
    func controlTextDidEndEditing(_ obj: Notification) {
        commitEditing()
    }
}
