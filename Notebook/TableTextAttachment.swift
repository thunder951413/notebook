import AppKit
import SwiftUI

/// 表格数据模型
struct TableData: Codable {
    var rows: [[String]]
    var columnWidths: [CGFloat]
    var rowHeights: [CGFloat]
    var defaultColumnWidth: CGFloat
    var defaultRowHeight: CGFloat
    
    init(rows: Int = 3, columns: Int = 3) {
        self.rows = Array(repeating: Array(repeating: "", count: columns), count: rows)
        self.defaultColumnWidth = 100
        self.defaultRowHeight = 32
        self.columnWidths = Array(repeating: defaultColumnWidth, count: columns)
        self.rowHeights = Array(repeating: defaultRowHeight, count: rows)
    }
    
    var rowCount: Int { rows.count }
    var columnCount: Int { rows.first?.count ?? 0 }
    
    mutating func addRow(at index: Int? = nil) {
        let newRow = Array(repeating: "", count: columnCount)
        let insertIndex = index ?? rows.count
        rows.insert(newRow, at: insertIndex)
        rowHeights.insert(defaultRowHeight, at: insertIndex)
    }
    
    mutating func removeRow(at index: Int) {
        guard rows.count > 1, index >= 0, index < rows.count else { return }
        rows.remove(at: index)
        rowHeights.remove(at: index)
    }
    
    mutating func addColumn(at index: Int? = nil) {
        let insertIndex = index ?? columnCount
        for i in 0..<rows.count {
            rows[i].insert("", at: insertIndex)
        }
        columnWidths.insert(defaultColumnWidth, at: insertIndex)
    }
    
    mutating func removeColumn(at index: Int) {
        guard columnCount > 1, index >= 0, index < columnCount else { return }
        for i in 0..<rows.count {
            rows[i].remove(at: index)
        }
        columnWidths.remove(at: index)
    }
    
    mutating func updateCell(row: Int, column: Int, value: String) {
        guard row >= 0, row < rows.count,
              column >= 0, column < rows[row].count else { return }
        rows[row][column] = value
    }
}

/// 表格附件 - 用于在富文本中嵌入可编辑表格
final class TableTextAttachment: NSTextAttachment {
    private static let dataKey = "table_data"
    
    var tableData: TableData
    var onDataChanged: (() -> Void)?
    
    static func registerViewProvider() {
        if #available(macOS 12.0, *) {
            NSTextAttachment.registerViewProviderClass(TableAttachmentViewProvider.self, forFileType: "com.notebook.table")
        }
    }
    
    override init(data contentData: Data?, ofType uti: String?) {
        self.tableData = TableData()
        super.init(data: contentData, ofType: uti)
        setup()
    }
    
    required init?(coder: NSCoder) {
        if let data = coder.decodeObject(forKey: Self.dataKey) as? Data,
           let decoded = try? JSONDecoder().decode(TableData.self, from: data) {
            self.tableData = decoded
        } else {
            self.tableData = TableData()
        }
        super.init(coder: coder)
        setup()
    }
    
    convenience init(rows: Int = 3, columns: Int = 3) {
        self.init(data: nil, ofType: nil)
        self.tableData = TableData(rows: rows, columns: columns)
        updateImage()
    }
    
    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        if let data = try? JSONEncoder().encode(tableData) {
            coder.encode(data, forKey: Self.dataKey)
        }
    }
    
    private func setup() {
        updateImage()
    }
    
    func updateImage() {
        self.image = createTableImage()
        let totalWidth = max(tableData.columnWidths.reduce(0, +) + CGFloat(tableData.columnCount + 1), 50)
        let totalHeight = max(tableData.rowHeights.reduce(0, +) + CGFloat(tableData.rowCount + 1), 50)
        self.bounds = NSRect(x: 0, y: 0, width: totalWidth, height: totalHeight)
    }
    
    private func createTableImage() -> NSImage {
        let totalWidth = max(tableData.columnWidths.reduce(0, +) + CGFloat(tableData.columnCount + 1), 50)
        let totalHeight = max(tableData.rowHeights.reduce(0, +) + CGFloat(tableData.rowCount + 1), 50)
        
        let size = NSSize(width: totalWidth, height: totalHeight)
        let image = NSImage(size: size)
        
        guard size.width > 0 && size.height > 0 else {
            return NSImage(size: NSSize(width: 50, height: 50))
        }
        
        image.lockFocus()
        
        let isDarkMode = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let backgroundColor: NSColor = isDarkMode ? NSColor(red: 0.22, green: 0.22, blue: 0.22, alpha: 1) : .white
        let borderColor: NSColor = isDarkMode ? NSColor(red: 0.35, green: 0.35, blue: 0.35, alpha: 1) : NSColor(red: 0.85, green: 0.85, blue: 0.85, alpha: 1)
        let textColor: NSColor = isDarkMode ? .white : .black
        
        // 绘制背景
        backgroundColor.setFill()
        NSRect(origin: .zero, size: size).fill()
        
        // 绘制边框和单元格
        var y: CGFloat = 1
        for row in 0..<tableData.rowCount {
            var x: CGFloat = 1
            for col in 0..<tableData.columnCount {
                let cellRect = NSRect(x: x, y: y, width: tableData.columnWidths[col], height: tableData.rowHeights[row])
                
                // 绘制单元格边框
                borderColor.setStroke()
                let borderPath = NSBezierPath(rect: cellRect)
                borderPath.lineWidth = 0.5
                borderPath.stroke()
                
                // 绘制文本
                let text = tableData.rows[row][col]
                if !text.isEmpty {
                    let attributes: [NSAttributedString.Key: Any] = [
                        .font: NSFont.systemFont(ofSize: 12),
                        .foregroundColor: textColor
                    ]
                    let attributedText = NSAttributedString(string: text, attributes: attributes)
                    let textSize = attributedText.size()
                    let textRect = NSRect(
                        x: cellRect.minX + 4,
                        y: cellRect.midY - textSize.height / 2,
                        width: cellRect.width - 8,
                        height: textSize.height
                    )
                    attributedText.draw(in: textRect)
                }
                
                x += tableData.columnWidths[col] + 1
            }
            y += tableData.rowHeights[row] + 1
        }
        
        // 绘制外边框
        borderColor.setStroke()
        let outerPath = NSBezierPath(rect: NSRect(x: 0.5, y: 0.5, width: totalWidth - 1, height: totalHeight - 1))
        outerPath.lineWidth = 1
        outerPath.stroke()
        
        image.unlockFocus()
        return image
    }
    
    // MARK: - 数据操作
    
    func addRow(at index: Int? = nil) {
        tableData.addRow(at: index)
        updateImage()
        onDataChanged?()
    }
    
    func removeRow(at index: Int) {
        tableData.removeRow(at: index)
        updateImage()
        onDataChanged?()
    }
    
    func addColumn(at index: Int? = nil) {
        tableData.addColumn(at: index)
        updateImage()
        onDataChanged?()
    }
    
    func removeColumn(at index: Int) {
        tableData.removeColumn(at: index)
        updateImage()
        onDataChanged?()
    }
    
    func updateCell(row: Int, column: Int, value: String) {
        tableData.updateCell(row: row, column: column, value: value)
        updateImage()
        onDataChanged?()
    }
    
    /// 保存时确保图像数据被正确序列化
    func prepareForSaving() {
        print("[TableDebug] prepareForSaving called, tableData rows: \(tableData.rowCount), cols: \(tableData.columnCount)")
        
        // 确保图像已生成
        if self.image == nil {
            print("[TableDebug] Image is nil, calling updateImage()")
            updateImage()
        }
        
        // 将图像转换为 PNG 数据并设置到 contents
        // 这样 RTFD 保存时就能包含图像数据
        guard let image = self.image else {
            print("[TableDebug] prepareForSaving: image is still nil after updateImage()")
            return
        }
        
        print("[TableDebug] Image size: \(image.size.width) x \(image.size.height)")
        
        // 尝试从 NSImage 的 representations 获取 bitmap
        var pngData: Data?
        if let bitmapRep = image.representations.first as? NSBitmapImageRep {
            print("[TableDebug] Found bitmapRep, attempting PNG conversion...")
            pngData = bitmapRep.representation(using: .png, properties: [:])
        }
        
        // 如果方法1失败，尝试通过 CGImage 转换
        if pngData == nil {
            print("[TableDebug] Trying CGImage conversion...")
            if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                let rep = NSBitmapImageRep(cgImage: cgImage)
                rep.size = image.size
                pngData = rep.representation(using: .png, properties: [:])
            }
        }
        
        // 如果方法2也失败，创建新的 bitmap representation
        if pngData == nil {
            print("[TableDebug] Trying new bitmap method...")
            let size = image.size
            guard size.width > 0, size.height > 0 else {
                print("[TableDebug] prepareForSaving: invalid image size")
                return
            }
            
            let newImage = NSImage(size: size)
            newImage.lockFocus()
            image.draw(in: NSRect(origin: .zero, size: size))
            newImage.unlockFocus()
            
            if let bitmapRep = newImage.representations.first as? NSBitmapImageRep {
                pngData = bitmapRep.representation(using: .png, properties: [:])
            }
        }
        
        guard let finalPngData = pngData else {
            print("[TableDebug] prepareForSaving: FAILED - all methods exhausted")
            return
        }
        
        // 将 tableData 编码为 JSON 并添加到 PNG 数据的末尾
        // 格式: [PNG数据][4字节JSON长度][JSON数据]
        do {
            let tableDataJSON = try JSONEncoder().encode(tableData)
            var combinedData = finalPngData
            
            // 添加4字节的长度前缀（大端序）
            var jsonLength = UInt32(tableDataJSON.count).bigEndian
            let lengthData = Data(bytes: &jsonLength, count: 4)
            combinedData.append(lengthData)
            
            // 添加JSON数据
            combinedData.append(tableDataJSON)
            
            self.contents = combinedData
            self.fileType = "public.png"
            print("[TableDebug] prepareForSaving: SUCCESS, PNG=\(finalPngData.count) bytes, JSON=\(tableDataJSON.count) bytes, total=\(combinedData.count) bytes")
        } catch {
            print("[TableDebug] prepareForSaving: FAILED to encode tableData: \(error)")
            // 回退到只保存PNG
            self.contents = finalPngData
            self.fileType = "public.png"
            print("[TableDebug] prepareForSaving: Fallback to PNG only, size=\(finalPngData.count) bytes")
        }
    }
    
    // MARK: - 从普通附件恢复
    
    /// 判断普通附件是否"像"一个表格（用于重启后反序列化恢复交互）
    static func looksLikeTable(_ attachment: NSTextAttachment) -> Bool {
        let bounds = attachment.bounds
        
        // 表格通常宽度>100, 高度>50
        let hasTableSizedBounds = bounds.width > 100 && bounds.height > 50
        
        // 检查是否有图像数据
        var hasImageData = false
        if attachment.image != nil {
            hasImageData = true
        } else if let contents = attachment.contents, !contents.isEmpty {
            hasImageData = true
        }
        
        print("[TableDebug] looksLikeTable: bounds=\(bounds.width)x\(bounds.height), hasImageData=\(hasImageData)")
        
        return hasTableSizedBounds && hasImageData
    }
    
    /// 从普通 NSTextAttachment 恢复 TableTextAttachment
    static func recover(from attachment: NSTextAttachment) -> TableTextAttachment? {
        print("[TableDebug] recover: attempting to recover from attachment")
        
        // 创建新的表格附件
        let newAttachment = TableTextAttachment()
        
        // 保留原始边界
        newAttachment.bounds = attachment.bounds
        
        // 尝试从 contents 恢复 tableData
        // 格式: [PNG数据][4字节JSON长度][JSON数据]
        if let contents = attachment.contents, contents.count > 4 {
            print("[TableDebug] recover: contents size = \(contents.count) bytes")
            
            // 读取最后4字节作为JSON长度
            let lengthData = contents.suffix(4)
            let jsonLength = lengthData.withUnsafeBytes { $0.load(as: UInt32.self ).bigEndian }
            print("[TableDebug] recover: jsonLength = \(jsonLength)")
            
            // 检查长度是否合理
            if jsonLength > 0 && jsonLength < 100000 && Int(jsonLength) + 4 <= contents.count {
                // 提取JSON数据
                let jsonStart = contents.count - Int(jsonLength) - 4
                let jsonData = contents.subdata(in: jsonStart..<(contents.count - 4))
                
                // 尝试解码 tableData
                if let tableData = try? JSONDecoder().decode(TableData.self, from: jsonData) {
                    print("[TableDebug] recover: restored tableData with \(tableData.rowCount) rows, \(tableData.columnCount) cols")
                    newAttachment.tableData = tableData
                    
                    // 提取PNG数据（用于显示）
                    let pngData = contents.subdata(in: 0..<jsonStart)
                    newAttachment.contents = pngData
                    newAttachment.fileType = "public.png"
                    newAttachment.updateImage()
                    
                    print("[TableDebug] recover: success")
                    return newAttachment
                } else {
                    print("[TableDebug] recover: failed to decode tableData from JSON")
                }
            } else {
                print("[TableDebug] recover: invalid jsonLength or data size")
            }
            
            // 如果无法解析嵌入的JSON，尝试将整个内容作为PNG
            print("[TableDebug] recover: fallback to treating entire contents as PNG")
            newAttachment.contents = contents
            newAttachment.fileType = attachment.fileType ?? "public.png"
        } else {
            print("[TableDebug] recover: no contents or contents too small")
        }
        
        // 无法恢复原始数据，创建默认表格
        print("[TableDebug] recover: creating default 3x3 table")
        newAttachment.tableData = TableData(rows: 3, columns: 3)
        newAttachment.updateImage()
        
        return newAttachment
    }
}
