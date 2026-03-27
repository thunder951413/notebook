import AppKit
import SwiftUI

/// AppKit 表格附件视图 - 处理所有交互逻辑
class TableAttachmentNSView: NSView {
    private(set) var tableData: TableData?
    private var onCellEdited: ((Int, Int, String) -> Void)?
    private var onStructureChanged: (() -> Void)?
    var contextMenuPresenter: ((NSMenu, NSEvent, NSView) -> Void)?
    
    private var selectedCell: (row: Int, col: Int)? = nil
    private var editingCell: (row: Int, col: Int)? = nil
    private var textField: NSTextField?
    private var suppressTextDidEndEditing = false
    
    private let cellPadding: CGFloat = 4
    private let borderWidth: CGFloat = 1
    
    override var isFlipped: Bool { true }
    
    func configure(tableData: TableData, onCellEdited: @escaping (Int, Int, String) -> Void, onStructureChanged: @escaping () -> Void) {
        self.tableData = tableData
        self.onCellEdited = onCellEdited
        self.onStructureChanged = onStructureChanged
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }
    
    func updateTableData(_ data: TableData) {
        self.tableData = data
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }
    
    override var intrinsicContentSize: NSSize {
        guard let data = tableData else { return .zero }
        let width = data.columnWidths.reduce(0, +) + CGFloat(data.columnCount + 1) * borderWidth
        let height = data.rowHeights.reduce(0, +) + CGFloat(data.rowCount + 1) * borderWidth
        return NSSize(width: width, height: height)
    }
    
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        
        guard let data = tableData else { return }
        
        let bgColor = AttachmentAppearance.backgroundColor
        let borderColor = AttachmentAppearance.borderColor
        let selectionColor = AttachmentAppearance.selectionColor
        let textColor = AttachmentAppearance.primaryTextColor
        
        bgColor.setFill()
        bounds.fill()
        
        var y: CGFloat = borderWidth
        for row in 0..<data.rowCount {
            var x: CGFloat = borderWidth
            for col in 0..<data.columnCount {
                let cellRect = NSRect(
                    x: x,
                    y: y,
                    width: data.columnWidths[col],
                    height: data.rowHeights[row]
                )
                
                if selectedCell?.row == row && selectedCell?.col == col {
                    selectionColor.setFill()
                    cellRect.fill()
                }
                
                borderColor.setStroke()
                let path = NSBezierPath(rect: cellRect)
                path.lineWidth = borderWidth
                path.stroke()
                
                if editingCell?.row != row || editingCell?.col != col {
                    let text = data.rows[row][col]
                    if !text.isEmpty {
                        let paragraphStyle = NSMutableParagraphStyle()
                        paragraphStyle.alignment = .left
                        
                        let attrs: [NSAttributedString.Key: Any] = [
                            .font: NSFont.systemFont(ofSize: 12),
                            .foregroundColor: textColor,
                            .paragraphStyle: paragraphStyle
                        ]
                        
                        let attrStr = NSAttributedString(string: text, attributes: attrs)
                        let textRect = NSRect(
                            x: cellRect.minX + cellPadding,
                            y: cellRect.minY,
                            width: cellRect.width - cellPadding * 2,
                            height: cellRect.height
                        )
                        attrStr.draw(in: textRect)
                    }
                }
                
                x += data.columnWidths[col] + borderWidth
            }
            y += data.rowHeights[row] + borderWidth
        }
        
        borderColor.setStroke()
        let outerPath = NSBezierPath(rect: bounds.insetBy(dx: 0.5, dy: 0.5))
        outerPath.lineWidth = 1
        outerPath.stroke()
    }
    
    override func mouseDown(with event: NSEvent) {
        guard let data = tableData else { return }
        
        let clickPoint = convert(event.locationInWindow, from: nil)
        
        if let cell = getCellAt(point: clickPoint, in: data) {
            if event.clickCount == 2 {
                startEditingCell(row: cell.row, col: cell.col)
            } else {
                selectCell(row: cell.row, col: cell.col)
            }
        }
        
        super.mouseDown(with: event)
    }
    
    override func rightMouseDown(with event: NSEvent) {
        let clickPoint = convert(event.locationInWindow, from: nil)
        
        if let data = tableData, let cell = getCellAt(point: clickPoint, in: data) {
            selectCell(row: cell.row, col: cell.col)
            showContextMenu(with: event, for: cell)
        }
        
        super.rightMouseDown(with: event)
    }
    
    override func keyDown(with event: NSEvent) {
        guard let data = tableData else {
            super.keyDown(with: event)
            return
        }
        
        let keyCode = event.keyCode
        let modifiers = event.modifierFlags
        
        switch keyCode {
        case 48:
            if let current = selectedCell {
                if modifiers.contains(.shift) {
                    moveToPreviousCell(from: current, in: data)
                } else {
                    moveToNextCell(from: current, in: data)
                }
            }
            
        case 125:
            if let current = selectedCell {
                moveDown(from: current, in: data)
            }
            
        case 126:
            if let current = selectedCell {
                moveUp(from: current, in: data)
            }
            
        case 123:
            if let current = selectedCell {
                moveLeft(from: current, in: data)
            }
            
        case 124:
            if let current = selectedCell {
                moveRight(from: current, in: data)
            }
            
        case 36:
            if let current = selectedCell {
                startEditingCell(row: current.row, col: current.col)
            }
            
        case 53:
            if editingCell != nil {
                endEditing(commit: false)
            }
            
        default:
            if let current = selectedCell, editingCell == nil, isPrintable(event: event) {
                startEditingCell(row: current.row, col: current.col, withInitialText: event.characters ?? "")
                return
            }
            super.keyDown(with: event)
        }
    }
    
    override var acceptsFirstResponder: Bool { true }
    
    private func isPrintable(event: NSEvent) -> Bool {
        guard let chars = event.characters else { return false }
        return !chars.isEmpty && chars.unicodeScalars.first.map { CharacterSet.alphanumerics.contains($0) } ?? false
    }
    
    private func getCellAt(point: NSPoint, in data: TableData) -> (row: Int, col: Int)? {
        var y: CGFloat = borderWidth
        for row in 0..<data.rowCount {
            var x: CGFloat = borderWidth
            for col in 0..<data.columnCount {
                let cellRect = NSRect(
                    x: x,
                    y: y,
                    width: data.columnWidths[col],
                    height: data.rowHeights[row]
                )
                if cellRect.contains(point) {
                    return (row: row, col: col)
                }
                x += data.columnWidths[col] + borderWidth
            }
            y += data.rowHeights[row] + borderWidth
        }
        return nil
    }
    
    private func selectCell(row: Int, col: Int) {
        if editingCell != nil {
            endEditing(commit: true)
        }
        selectedCell = (row: row, col: col)
        needsDisplay = true
    }
    
    private func startEditingCell(row: Int, col: Int, withInitialText initialText: String? = nil) {
        guard let data = tableData else { return }
        
        if editingCell != nil {
            endEditing(commit: true)
        }
        
        selectedCell = (row: row, col: col)
        editingCell = (row: row, col: col)
        
        let cellRect = getCellRect(row: row, col: col, in: data)
        
        let tf = NSTextField(frame: cellRect.insetBy(dx: cellPadding, dy: 2))
        tf.bezelStyle = .squareBezel
        tf.isBezeled = false
        tf.drawsBackground = true
        tf.backgroundColor = .textBackgroundColor
        tf.focusRingType = .none
        tf.font = NSFont.systemFont(ofSize: 12)
        tf.stringValue = initialText ?? data.rows[row][col]
        tf.delegate = self
        tf.target = self
        tf.action = #selector(textFieldAction(_:))
        
        addSubview(tf)
        window?.makeFirstResponder(tf)
        self.textField = tf
        
        needsDisplay = true
    }
    
    private func endEditing(commit: Bool) {
        guard let editing = editingCell, let tf = textField else {
            editingCell = nil
            textField?.removeFromSuperview()
            textField = nil
            return
        }

        suppressTextDidEndEditing = true
        if commit {
            onCellEdited?(editing.row, editing.col, tf.stringValue)
        }
        
        tf.removeFromSuperview()
        self.textField = nil
        editingCell = nil
        needsDisplay = true
    }
    
    @objc private func textFieldAction(_ sender: NSTextField) {
        endEditing(commit: true)
    }
    
    private func getCellRect(row: Int, col: Int, in data: TableData) -> NSRect {
        var y: CGFloat = borderWidth
        for r in 0..<row {
            y += data.rowHeights[r] + borderWidth
        }
        
        var x: CGFloat = borderWidth
        for c in 0..<col {
            x += data.columnWidths[c] + borderWidth
        }
        
        return NSRect(x: x, y: y, width: data.columnWidths[col], height: data.rowHeights[row])
    }
    
    private func moveToNextCell(from current: (row: Int, col: Int), in data: TableData) {
        var nextRow = current.row
        var nextCol = current.col + 1
        
        if nextCol >= data.columnCount {
            nextCol = 0
            nextRow += 1
            if nextRow >= data.rowCount {
                nextRow = 0
            }
        }
        
        selectCell(row: nextRow, col: nextCol)
    }
    
    private func moveToPreviousCell(from current: (row: Int, col: Int), in data: TableData) {
        var prevRow = current.row
        var prevCol = current.col - 1
        
        if prevCol < 0 {
            prevCol = data.columnCount - 1
            prevRow -= 1
            if prevRow < 0 {
                prevRow = data.rowCount - 1
            }
        }
        
        selectCell(row: prevRow, col: prevCol)
    }
    
    private func moveUp(from current: (row: Int, col: Int), in data: TableData) {
        let newRow = current.row > 0 ? current.row - 1 : data.rowCount - 1
        selectCell(row: newRow, col: current.col)
    }
    
    private func moveDown(from current: (row: Int, col: Int), in data: TableData) {
        let newRow = current.row < data.rowCount - 1 ? current.row + 1 : 0
        selectCell(row: newRow, col: current.col)
    }
    
    private func moveLeft(from current: (row: Int, col: Int), in data: TableData) {
        let newCol = current.col > 0 ? current.col - 1 : data.columnCount - 1
        selectCell(row: current.row, col: newCol)
    }
    
    private func moveRight(from current: (row: Int, col: Int), in data: TableData) {
        let newCol = current.col < data.columnCount - 1 ? current.col + 1 : 0
        selectCell(row: current.row, col: newCol)
    }
    
    private func showContextMenu(with event: NSEvent, for cell: (row: Int, col: Int)) {
        let menu = NSMenu()
        
        let rowMenu = NSMenu()
        rowMenu.addItem(withTitle: "在上方插入行", action: #selector(insertRowAbove(_:)), keyEquivalent: "")
        rowMenu.addItem(withTitle: "在下方插入行", action: #selector(insertRowBelow(_:)), keyEquivalent: "")
        rowMenu.addItem(NSMenuItem.separator())
        rowMenu.addItem(withTitle: "删除此行", action: #selector(deleteRow(_:)), keyEquivalent: "")
        
        let rowItem = NSMenuItem(title: "行操作", action: nil, keyEquivalent: "")
        rowItem.submenu = rowMenu
        menu.addItem(rowItem)
        
        let colMenu = NSMenu()
        colMenu.addItem(withTitle: "在左侧插入列", action: #selector(insertColumnLeft(_:)), keyEquivalent: "")
        colMenu.addItem(withTitle: "在右侧插入列", action: #selector(insertColumnRight(_:)), keyEquivalent: "")
        colMenu.addItem(NSMenuItem.separator())
        colMenu.addItem(withTitle: "删除此列", action: #selector(deleteColumn(_:)), keyEquivalent: "")
        
        let colItem = NSMenuItem(title: "列操作", action: nil, keyEquivalent: "")
        colItem.submenu = colMenu
        menu.addItem(colItem)
        
        contextMenuRow = cell.row
        contextMenuCol = cell.col

        if let contextMenuPresenter {
            contextMenuPresenter(menu, event, self)
            return
        }

        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
    
    private var contextMenuRow: Int = 0
    private var contextMenuCol: Int = 0

    private func structureActionCell(in data: TableData) -> (row: Int, col: Int)? {
        if let selectedCell,
           selectedCell.row >= 0, selectedCell.row < data.rowCount,
           selectedCell.col >= 0, selectedCell.col < data.columnCount {
            return selectedCell
        }

        guard contextMenuRow >= 0, contextMenuRow < data.rowCount,
              contextMenuCol >= 0, contextMenuCol < data.columnCount else {
            return nil
        }
        return (row: contextMenuRow, col: contextMenuCol)
    }
    
    @objc private func insertRowAbove(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              let actionCell = structureActionCell(in: data) else { return }
        data.addRow(at: actionCell.row)
        tableData = data
        if let selected = selectedCell, selected.row >= actionCell.row {
            selectedCell = (row: selected.row + 1, col: selected.col)
        }
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
    
    @objc private func insertRowBelow(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              let actionCell = structureActionCell(in: data) else { return }
        data.addRow(at: actionCell.row + 1)
        tableData = data
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
    
    @objc private func deleteRow(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              data.rowCount > 1,
              let actionCell = structureActionCell(in: data) else { return }
        data.removeRow(at: actionCell.row)
        tableData = data
        if let selected = selectedCell {
            if selected.row > actionCell.row {
                selectedCell = (row: selected.row - 1, col: selected.col)
            } else if selected.row == actionCell.row {
                selectedCell = (row: min(actionCell.row, data.rowCount - 1), col: selected.col)
            }
        }
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
    
    @objc private func insertColumnLeft(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              let actionCell = structureActionCell(in: data) else { return }
        data.addColumn(at: actionCell.col)
        tableData = data
        if let selected = selectedCell, selected.col >= actionCell.col {
            selectedCell = (row: selected.row, col: selected.col + 1)
        }
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
    
    @objc private func insertColumnRight(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              let actionCell = structureActionCell(in: data) else { return }
        data.addColumn(at: actionCell.col + 1)
        tableData = data
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
    
    @objc private func deleteColumn(_ sender: Any?) {
        endEditing(commit: true)
        guard var data = tableData,
              data.columnCount > 1,
              let actionCell = structureActionCell(in: data) else { return }
        data.removeColumn(at: actionCell.col)
        tableData = data
        if let selected = selectedCell {
            if selected.col > actionCell.col {
                selectedCell = (row: selected.row, col: selected.col - 1)
            } else if selected.col == actionCell.col {
                selectedCell = (row: selected.row, col: min(actionCell.col, data.columnCount - 1))
            }
        }
        invalidateIntrinsicContentSize()
        onStructureChanged?()
        needsDisplay = true
    }
}

extension TableAttachmentNSView: NSTextFieldDelegate {
    func controlTextDidEndEditing(_ obj: Notification) {
        if suppressTextDidEndEditing {
            suppressTextDidEndEditing = false
            return
        }
        endEditing(commit: true)
    }
    
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(cancelOperation(_:)) {
            endEditing(commit: false)
            return true
        }

        if commandSelector == #selector(insertTab(_:)) {
            endEditing(commit: true)
            if let current = selectedCell, let data = tableData {
                moveToNextCell(from: current, in: data)
            }
            return true
        }
        
        if commandSelector == #selector(insertBacktab(_:)) {
            endEditing(commit: true)
            if let current = selectedCell, let data = tableData {
                moveToPreviousCell(from: current, in: data)
            }
            return true
        }
        
        if commandSelector == #selector(moveUp(_:)) {
            endEditing(commit: true)
            if let current = selectedCell, let data = tableData {
                moveUp(from: current, in: data)
            }
            return true
        }
        
        if commandSelector == #selector(moveDown(_:)) {
            endEditing(commit: true)
            if let current = selectedCell, let data = tableData {
                moveDown(from: current, in: data)
            }
            return true
        }
        
        return false
    }
}
