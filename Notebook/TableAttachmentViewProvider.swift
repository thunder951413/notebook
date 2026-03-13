import AppKit
import SwiftUI

/// 表格单元格位置
struct TableCellPosition: Hashable {
    let row: Int
    let col: Int
}

/// 表格附件视图提供器 - TextKit 2 方式嵌入交互视图
@available(macOS 12.0, *)
class TableAttachmentViewProvider: NSTextAttachmentViewProvider {
    private var hostingView: NSHostingView<TableInlineEditView>?
    
    override func loadView() {
        super.loadView()
        
        guard let textAttachment = textAttachment as? TableTextAttachment else {
            return
        }
        
        let attachment = textAttachment
        
        let editView = TableInlineEditView(
            tableData: attachment.tableData,
            onCellEdited: { [weak attachment] row, col, value in
                attachment?.updateCell(row: row, column: col, value: value)
            },
            onStructureChanged: { [weak attachment] newData in
                attachment?.tableData = newData
                attachment?.updateImage()
            }
        )
        
        let hosting = NSHostingView(rootView: editView)
        hosting.frame = NSRect(x: 0, y: 0, width: attachment.bounds.width, height: attachment.bounds.height)
        
        view = hosting
        hostingView = hosting
    }
    
    override func attachmentBounds(for attributes: [NSAttributedString.Key : Any], location: NSTextLocation, textContainer: NSTextContainer?, proposedLineFragment: CGRect, position: CGPoint) -> CGRect {
        guard let textAttachment = textAttachment as? TableTextAttachment else {
            return super.attachmentBounds(for: attributes, location: location, textContainer: textContainer, proposedLineFragment: proposedLineFragment, position: position)
        }
        
        return textAttachment.bounds
    }
}

/// 内联表格编辑视图 - SwiftUI
struct TableInlineEditView: View {
    @State var tableData: TableData
    var onCellEdited: (Int, Int, String) -> Void
    var onStructureChanged: (TableData) -> Void
    
    @State private var selectedCell: TableCellPosition? = nil
    @State private var editingCell: TableCellPosition? = nil
    @State private var editingText: String = ""
    @FocusState private var focusedCell: TableCellPosition?
    
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<tableData.rowCount, id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(0..<tableData.columnCount, id: \.self) { col in
                        cellView(row: row, col: col)
                    }
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .overlay(
            RoundedRectangle(cornerRadius: 2)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
        .contextMenu {
            Button("在上方插入行") {
                insertRow(above: selectedCell?.row)
            }
            Button("在下方插入行") {
                insertRow(below: selectedCell?.row)
            }
            Divider()
            Button("在左侧插入列") {
                insertColumn(leftOf: selectedCell?.col)
            }
            Button("在右侧插入列") {
                insertColumn(rightOf: selectedCell?.col)
            }
            Divider()
            Button("删除行") {
                if let row = selectedCell?.row {
                    deleteRow(row)
                }
            }
            Button("删除列") {
                if let col = selectedCell?.col {
                    deleteColumn(col)
                }
            }
        }
    }
    
    @ViewBuilder
    private func cellView(row: Int, col: Int) -> some View {
        let cellPosition = TableCellPosition(row: row, col: col)
        let isSelected = selectedCell?.row == row && selectedCell?.col == col
        let isEditing = editingCell?.row == row && editingCell?.col == col
        
        Group {
            if isEditing {
                TextField("", text: $editingText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .padding(4)
                    .focused($focusedCell, equals: cellPosition)
                    .onSubmit {
                        commitEdit()
                    }
                    .onExitCommand {
                        cancelEdit()
                    }
            } else {
                Text(tableData.rows[row][col])
                    .font(.system(size: 12))
                    .foregroundColor(.primary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(4)
            }
        }
        .frame(width: tableData.columnWidths[col], height: tableData.rowHeights[row])
        .background(isSelected ? Color.accentColor.opacity(0.2) : Color.clear)
        .overlay(
            Rectangle()
                .stroke(isSelected ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: isSelected ? 2 : 0.5)
        )
        .onTapGesture {
            handleTap(row: row, col: col)
        }
        .onTapGesture(count: 2) {
            startEditing(row: row, col: col)
        }
    }
    
    private func handleTap(row: Int, col: Int) {
        if editingCell != nil {
            commitEdit()
        }
        selectedCell = TableCellPosition(row: row, col: col)
    }
    
    private func startEditing(row: Int, col: Int) {
        if editingCell != nil {
            commitEdit()
        }
        editingCell = TableCellPosition(row: row, col: col)
        editingText = tableData.rows[row][col]
        focusedCell = TableCellPosition(row: row, col: col)
    }
    
    private func commitEdit() {
        guard let editing = editingCell else { return }
        var newData = tableData
        newData.rows[editing.row][editing.col] = editingText
        tableData = newData
        onCellEdited(editing.row, editing.col, editingText)
        editingCell = nil
        editingText = ""
    }
    
    private func cancelEdit() {
        editingCell = nil
        editingText = ""
    }
    
    private func insertRow(above index: Int?) {
        var newData = tableData
        newData.addRow(at: index)
        tableData = newData
        onStructureChanged(newData)
    }
    
    private func insertRow(below index: Int?) {
        var newData = tableData
        newData.addRow(at: (index ?? -1) + 1)
        tableData = newData
        onStructureChanged(newData)
    }
    
    private func insertColumn(leftOf index: Int?) {
        var newData = tableData
        newData.addColumn(at: index)
        tableData = newData
        onStructureChanged(newData)
    }
    
    private func insertColumn(rightOf index: Int?) {
        var newData = tableData
        newData.addColumn(at: (index ?? -1) + 1)
        tableData = newData
        onStructureChanged(newData)
    }
    
    private func deleteRow(_ row: Int) {
        guard tableData.rowCount > 1 else { return }
        var newData = tableData
        newData.removeRow(at: row)
        tableData = newData
        onStructureChanged(newData)
        selectedCell = nil
    }
    
    private func deleteColumn(_ col: Int) {
        guard tableData.columnCount > 1 else { return }
        var newData = tableData
        newData.removeColumn(at: col)
        tableData = newData
        onStructureChanged(newData)
        selectedCell = nil
    }
}
