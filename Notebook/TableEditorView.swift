import SwiftUI

/// 表格编辑视图 - 用于编辑表格内容
struct TableEditorView: View {
    @Binding var tableData: TableData
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    
    @State private var editingCell: (row: Int, col: Int)? = nil
    @State private var editText: String = ""
    
    var body: some View {
        VStack(spacing: 0) {
            // 工具栏
            toolbarView
            
            Divider()
            
            // 表格内容
            ScrollView([.horizontal, .vertical]) {
                tableGridView
                    .padding(16)
            }
            
            Divider()
            
            // 底部按钮
            HStack {
                Spacer()
                Button("完成") {
                    dismiss()
                }
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(12)
        }
        .frame(minWidth: 400, minHeight: 300)
        .background(backgroundColor)
    }
    
    // MARK: - 子视图
    
    private var toolbarView: some View {
        HStack(spacing: 12) {
            // 行操作
            Menu {
                Button {
                    addRow(at: 0)
                } label: {
                    Label("在顶部添加行", systemImage: "arrow.up")
                }
                
                Button {
                    addRow(at: tableData.rowCount)
                } label: {
                    Label("在底部添加行", systemImage: "arrow.down")
                }
                
                Divider()
                
                Button {
                    if tableData.rowCount > 1 {
                        removeRow(at: tableData.rowCount - 1)
                    }
                } label: {
                    Label("删除最后一行", systemImage: "minus")
                }
                .disabled(tableData.rowCount <= 1)
            } label: {
                Label("行", systemImage: "rectangle.split.3x1")
            }
            .menuStyle(.borderedButton)
            
            // 列操作
            Menu {
                Button {
                    addColumn(at: 0)
                } label: {
                    Label("在左侧添加列", systemImage: "arrow.left")
                }
                
                Button {
                    addColumn(at: tableData.columnCount)
                } label: {
                    Label("在右侧添加列", systemImage: "arrow.right")
                }
                
                Divider()
                
                Button {
                    if tableData.columnCount > 1 {
                        removeColumn(at: tableData.columnCount - 1)
                    }
                } label: {
                    Label("删除最后一列", systemImage: "minus")
                }
                .disabled(tableData.columnCount <= 1)
            } label: {
                Label("列", systemImage: "rectangle.split.1x2")
            }
            .menuStyle(.borderedButton)
            
            Spacer()
            
            Text("\(tableData.rowCount) 行 × \(tableData.columnCount) 列")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(12)
    }
    
    private var tableGridView: some View {
        VStack(spacing: 1) {
            // 列标题行
            HStack(spacing: 1) {
                ForEach(0..<tableData.columnCount, id: \.self) { col in
                    columnHeaderView(column: col)
                }
            }
            
            // 数据行
            ForEach(0..<tableData.rowCount, id: \.self) { row in
                HStack(spacing: 1) {
                    ForEach(0..<tableData.columnCount, id: \.self) { col in
                        cellView(row: row, column: col)
                    }
                }
            }
        }
        .background(borderColor)
        .cornerRadius(4)
    }
    
    private func columnHeaderView(column: Int) -> some View {
        HStack(spacing: 4) {
            Text(letterForColumn(column))
                .font(.caption)
                .fontWeight(.medium)
            
            Spacer()
            
            // 列操作菜单
            Menu {
                Button {
                    addColumn(at: column)
                } label: {
                    Label("在左侧插入列", systemImage: "arrow.left")
                }
                
                Button {
                    addColumn(at: column + 1)
                } label: {
                    Label("在右侧插入列", systemImage: "arrow.right")
                }
                
                Divider()
                
                Button {
                    removeColumn(at: column)
                } label: {
                    Label("删除此列", systemImage: "trash")
                        .foregroundColor(.red)
                }
                .disabled(tableData.columnCount <= 1)
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .menuStyle(.borderlessButton)
        }
        .padding(.horizontal, 8)
        .frame(width: tableData.columnWidths[column], height: 28)
        .background(headerColor)
    }
    
    private func cellView(row: Int, column: Int) -> some View {
        let isEditing = editingCell?.row == row && editingCell?.col == column
        
        return ZStack {
            // 背景
            cellBackgroundColor
                .frame(width: tableData.columnWidths[column], height: tableData.rowHeights[row])
            
            if isEditing {
                // 编辑模式
                TextField("", text: $editText, onCommit: {
                    commitEdit(row: row, column: column)
                })
                .textFieldStyle(.plain)
                .frame(width: tableData.columnWidths[column] - 8, height: tableData.rowHeights[row] - 4)
                .background(Color.white)
                .onAppear {
                    editText = tableData.rows[row][column]
                }
            } else {
                // 显示模式
                Text(tableData.rows[row][column])
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .frame(width: tableData.columnWidths[column] - 8, alignment: .leading)
                    .foregroundColor(textColor)
            }
        }
        .frame(width: tableData.columnWidths[column], height: tableData.rowHeights[row])
        .contentShape(Rectangle())
        .onTapGesture {
            startEditing(row: row, column: column)
        }
        .contextMenu {
            cellContextMenu(row: row, column: column)
        }
        .overlay(
            Rectangle()
                .stroke(isEditing ? Color.accentColor : Color.clear, lineWidth: 2)
        )
    }
    
    private func cellContextMenu(row: Int, column: Int) -> some View {
        Group {
            Section("行操作") {
                Button {
                    addRow(at: row)
                } label: {
                    Label("在上方插入行", systemImage: "arrow.up")
                }
                
                Button {
                    addRow(at: row + 1)
                } label: {
                    Label("在下方插入行", systemImage: "arrow.down")
                }
                
                Button {
                    removeRow(at: row)
                } label: {
                    Label("删除此行", systemImage: "trash")
                        .foregroundColor(.red)
                }
                .disabled(tableData.rowCount <= 1)
            }
            
            Section("列操作") {
                Button {
                    addColumn(at: column)
                } label: {
                    Label("在左侧插入列", systemImage: "arrow.left")
                }
                
                Button {
                    addColumn(at: column + 1)
                } label: {
                    Label("在右侧插入列", systemImage: "arrow.right")
                }
                
                Button {
                    removeColumn(at: column)
                } label: {
                    Label("删除此列", systemImage: "trash")
                        .foregroundColor(.red)
                }
                .disabled(tableData.columnCount <= 1)
            }
        }
    }
    
    // MARK: - 操作方法
    
    private func startEditing(row: Int, column: Int) {
        // 先提交之前的编辑
        if let editing = editingCell {
            commitEdit(row: editing.row, column: editing.col)
        }
        editingCell = (row: row, col: column)
        editText = tableData.rows[row][column]
    }
    
    private func commitEdit(row: Int, column: Int) {
        tableData.updateCell(row: row, column: column, value: editText)
        editingCell = nil
        editText = ""
    }
    
    private func addRow(at index: Int) {
        tableData.addRow(at: index)
    }
    
    private func removeRow(at index: Int) {
        tableData.removeRow(at: index)
        // 如果删除的是正在编辑的行，取消编辑
        if let editing = editingCell, editing.row == index {
            editingCell = nil
        }
    }
    
    private func addColumn(at index: Int) {
        tableData.addColumn(at: index)
    }
    
    private func removeColumn(at index: Int) {
        tableData.removeColumn(at: index)
        // 如果删除的是正在编辑的列，取消编辑
        if let editing = editingCell, editing.col == index {
            editingCell = nil
        }
    }
    
    // MARK: - 辅助方法
    
    private func letterForColumn(_ index: Int) -> String {
        var result = ""
        var num = index
        repeat {
            result = String(UnicodeScalar(65 + (num % 26))!) + result
            num /= 26
        } while num > 0
        return result
    }
    
    // MARK: - 颜色
    
    private var backgroundColor: Color {
        colorScheme == .dark ? Color(red: 0.18, green: 0.18, blue: 0.18) : Color(red: 0.95, green: 0.95, blue: 0.95)
    }
    
    private var headerColor: Color {
        colorScheme == .dark ? Color(red: 0.28, green: 0.28, blue: 0.28) : Color(red: 0.9, green: 0.9, blue: 0.9)
    }
    
    private var cellBackgroundColor: Color {
        colorScheme == .dark ? Color(red: 0.22, green: 0.22, blue: 0.22) : .white
    }
    
    private var borderColor: Color {
        colorScheme == .dark ? Color(red: 0.35, green: 0.35, blue: 0.35) : Color(red: 0.85, green: 0.85, blue: 0.85)
    }
    
    private var textColor: Color {
        colorScheme == .dark ? .white : .black
    }
}

/// 插入表格对话框
struct InsertTableDialog: View {
    @Binding var isPresented: Bool
    var onInsert: (Int, Int) -> Void
    
    @State private var rows: Int = 3
    @State private var columns: Int = 3
    
    var body: some View {
        VStack(spacing: 20) {
            Text("插入表格")
                .font(.headline)
            
            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("行数")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    HStack {
                        Button {
                            if rows > 1 { rows -= 1 }
                        } label: {
                            Image(systemName: "minus")
                        }
                        .disabled(rows <= 1)
                        
                        Text("\(rows)")
                            .frame(minWidth: 40)
                        
                        Button {
                            if rows < 20 { rows += 1 }
                        } label: {
                            Image(systemName: "plus")
                        }
                        .disabled(rows >= 20)
                    }
                }
                
                VStack(alignment: .leading, spacing: 8) {
                    Text("列数")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    HStack {
                        Button {
                            if columns > 1 { columns -= 1 }
                        } label: {
                            Image(systemName: "minus")
                        }
                        .disabled(columns <= 1)
                        
                        Text("\(columns)")
                            .frame(minWidth: 40)
                        
                        Button {
                            if columns < 10 { columns += 1 }
                        } label: {
                            Image(systemName: "plus")
                        }
                        .disabled(columns >= 10)
                    }
                }
            }
            
            // 预览网格
            previewGrid
                .frame(height: 100)
                .padding(.vertical, 8)
            
            HStack(spacing: 12) {
                Button("取消") {
                    isPresented = false
                }
                .keyboardShortcut(.escape, modifiers: [])
                
                Button("插入") {
                    onInsert(rows, columns)
                    isPresented = false
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(width: 280)
    }
    
    private var previewGrid: some View {
        let maxPreviewRows = min(rows, 5)
        let maxPreviewCols = min(columns, 6)
        
        return VStack(spacing: 2) {
            ForEach(0..<maxPreviewRows, id: \.self) { _ in
                HStack(spacing: 2) {
                    ForEach(0..<maxPreviewCols, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.accentColor.opacity(0.6))
                            .frame(width: 20, height: 14)
                    }
                    if columns > maxPreviewCols {
                        Text("...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            if rows > maxPreviewRows {
                Text("...")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}
