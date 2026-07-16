@preconcurrency import AppKit
import SwiftUI

/// 表格数据模型
nonisolated struct TableData: Codable {
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
/// NSTextAttachment 的编解码入口由 AppKit 定义为非隔离；实例仍只由编辑器在主线程展示。
nonisolated final class TableTextAttachment: NSTextAttachment {
    private static let dataKey = "table_data"
    private static let isTableDebugEnabled = false
    private static func log(_ message: String) {
        if isTableDebugEnabled {
            DebugLog.table(message, level: .debug)
        }
    }
    
    var tableData: TableData
    private var lastSerializedTableDataJSON: Data?
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
        if self.fileType == nil || self.fileType?.hasPrefix("dyn.") == true {
            self.fileType = "com.notebook.table"
        }
        updateImage()
    }
    
    func updateImage() {
        if self.fileType == nil || self.fileType?.hasPrefix("dyn.") == true {
            self.fileType = "com.notebook.table"
        }
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
        
        let backgroundColor = AttachmentAppearance.backgroundColor
        let borderColor = AttachmentAppearance.borderColor
        let textColor = AttachmentAppearance.primaryTextColor
        
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
        DebugLog.table("prepareForSaving start rows=\(tableData.rowCount) cols=\(tableData.columnCount)", level: .debug)
        DebugLog.table("prepareForSaving data=\(tableData.rows)", level: .debug)
        Self.log("[TableDebug] prepareForSaving called, tableData rows: \(tableData.rowCount), cols: \(tableData.columnCount)")
        
        // 保存前强制修正 UTI 与 fileWrapper（使用 PNG 形式，避免文件图标）
        if self.fileType == nil || self.fileType?.hasPrefix("dyn.") == true {
            self.fileType = "public.png"
        }
        if self.fileWrapper == nil || self.fileWrapper?.preferredFilename?.isEmpty == true {
            let wrapper = FileWrapper(regularFileWithContents: Data())
            wrapper.preferredFilename = "table.png"
            self.fileWrapper = wrapper
        }
        
        // 确保图像已生成
        if self.image == nil {
            Self.log("[TableDebug] Image is nil, calling updateImage()")
            updateImage()
        }
        
        // 将图像转换为 PNG 数据并设置到 contents
        // 这样 RTFD 保存时就能包含图像数据
        guard let image = self.image else {
            Self.log("[TableDebug] prepareForSaving: image is still nil after updateImage()")
            return
        }
        
        Self.log("[TableDebug] Image size: \(image.size.width) x \(image.size.height)")
        
        // 尝试从 NSImage 的 representations 获取 bitmap
        var pngData: Data?
        if let bitmapRep = image.representations.first as? NSBitmapImageRep {
            Self.log("[TableDebug] Found bitmapRep, attempting PNG conversion...")
            pngData = bitmapRep.representation(using: .png, properties: [:])
        }
        
        // 如果方法1失败，尝试通过 CGImage 转换
        if pngData == nil {
            Self.log("[TableDebug] Trying CGImage conversion...")
            if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                let rep = NSBitmapImageRep(cgImage: cgImage)
                rep.size = image.size
                pngData = rep.representation(using: .png, properties: [:])
            }
        }
        
        // 如果方法2也失败，创建新的 bitmap representation
        if pngData == nil {
            Self.log("[TableDebug] Trying new bitmap method...")
            let size = image.size
            guard size.width > 0, size.height > 0 else {
                Self.log("[TableDebug] prepareForSaving: invalid image size")
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
            Self.log("[TableDebug] prepareForSaving: FAILED - all methods exhausted")
            return
        }
        
        // 将 tableData 编码为 JSON
        do {
            let tableDataJSON = try JSONEncoder().encode(tableData)
            
            // 使用目录型 fileWrapper 保存 PNG + JSON（RTFD 会完整保留目录内容）
            self.contents = finalPngData
            self.fileType = "public.png"
            let pngWrapper = FileWrapper(regularFileWithContents: finalPngData)
            pngWrapper.preferredFilename = "table.png"
            let jsonWrapper = FileWrapper(regularFileWithContents: tableDataJSON)
            jsonWrapper.preferredFilename = "table.json"
            let dirWrapper = FileWrapper(directoryWithFileWrappers: [
                "table.png": pngWrapper,
                "table.json": jsonWrapper
            ])
            dirWrapper.preferredFilename = "table.ntable"
            self.fileWrapper = dirWrapper
            lastSerializedTableDataJSON = tableDataJSON
            DebugLog.table("prepareForSaving wrote wrapper png=\(finalPngData.count) json=\(tableDataJSON.count)", level: .debug)
            Self.log("[TableDebug] prepareForSaving: SUCCESS, PNG=\(finalPngData.count) bytes, JSON=\(tableDataJSON.count) bytes")
        } catch {
            Self.log("[TableDebug] prepareForSaving: FAILED to encode tableData: \(error)")
            // 回退到只保存PNG
            self.contents = finalPngData
            self.fileType = "public.png"
            let pngWrapper = FileWrapper(regularFileWithContents: finalPngData)
            pngWrapper.preferredFilename = "table.png"
            self.fileWrapper = pngWrapper
            Self.log("[TableDebug] prepareForSaving: Fallback to PNG only, size=\(finalPngData.count) bytes")
        }
    }
    
    // MARK: - 从普通附件恢复
    
    /// 判断普通附件是否"像"一个表格（用于重启后反序列化恢复交互）
    static func looksLikeTable(_ attachment: NSTextAttachment) -> Bool {
        if attachment is TableTextAttachment ||
            attachment is AttachmentTextAttachment ||
            attachment is AudioBlockAttachment ||
            attachment is CheckboxTextAttachment {
            return false
        }

        let bounds = attachment.bounds
        
        // 表格通常宽度>100, 高度>50
        let hasTableSizedBounds = bounds.width > 100 && bounds.height > 50
        
        // 检查是否有图像数据（contents 或 fileWrapper）
        var hasImageData = false
        if attachment.image != nil {
            hasImageData = true
        } else if let contents = attachment.contents, !contents.isEmpty {
            hasImageData = true
        } else if let wrapper = attachment.fileWrapper, wrapper.isRegularFile,
                  let wrapperData = wrapper.regularFileContents, !wrapperData.isEmpty {
            hasImageData = true
        } else if let wrapper = attachment.fileWrapper, wrapper.isDirectory,
                  let pngWrapper = wrapper.fileWrappers?["table.png"],
                  let pngData = pngWrapper.regularFileContents, !pngData.isEmpty {
            hasImageData = true
        }
        
        let fileType = attachment.fileType ?? ""
        let preferredFilename = attachment.fileWrapper?.preferredFilename ?? ""
        let hasTableMarker = preferredFilename.hasSuffix("table.png") || preferredFilename.hasSuffix(".ntable")
        
        // 只要能解析出表格 JSON，就认为是表格
        let hasEmbeddedTableData = extractTableData(from: attachment.contents) != nil
            || (attachment.fileWrapper?.isRegularFile == true
                ? extractTableData(from: attachment.fileWrapper?.regularFileContents)
                : nil) != nil
        
        Self.log("[TableDebug] looksLikeTable: bounds=\(bounds.width)x\(bounds.height), hasImageData=\(hasImageData), hasEmbeddedTableData=\(hasEmbeddedTableData), marker=\(hasTableMarker), fileType=\(fileType)")
        
        return hasTableMarker || hasEmbeddedTableData || (hasTableSizedBounds && hasImageData)
    }
    
    /// 从普通 NSTextAttachment 恢复 TableTextAttachment
    static func recover(from attachment: NSTextAttachment) -> TableTextAttachment? {
        Self.log("[TableDebug] recover: attempting to recover from attachment")
        
        // 创建新的表格附件
        let newAttachment = TableTextAttachment()
        
        // 保留原始边界
        newAttachment.bounds = attachment.bounds
        
        // 优先从目录型 fileWrapper 恢复（table.json + table.png）
        if let wrapper = attachment.fileWrapper, wrapper.isDirectory {
            let fileWrappers = wrapper.fileWrappers ?? [:]
            if let jsonWrapper = fileWrappers["table.json"],
               let jsonData = jsonWrapper.regularFileContents,
               let tableData = try? JSONDecoder().decode(TableData.self, from: jsonData) {
                Self.log("[TableDebug] recover: restored tableData from fileWrapper JSON")
                newAttachment.tableData = tableData
                if let pngWrapper = fileWrappers["table.png"],
                   let pngData = pngWrapper.regularFileContents {
                    newAttachment.contents = pngData
                    newAttachment.fileType = "public.png"
                }
                newAttachment.updateImage()
                Self.log("[TableDebug] recover: success (directory wrapper)")
                return newAttachment
            }
        }
        
        // 尝试从 contents / fileWrapper 恢复 tableData
        // 格式: [PNG数据][4字节JSON长度][JSON数据]
        let rawContents: Data? = {
            if let contents = attachment.contents { return contents }
            if let wrapper = attachment.fileWrapper, wrapper.isRegularFile {
                return wrapper.regularFileContents
            }
            return nil
        }()
        if let contents = rawContents, contents.count > 4 {
            Self.log("[TableDebug] recover: contents size = \(contents.count) bytes")
            if let (tableData, pngData) = extractTableData(from: contents) {
                Self.log("[TableDebug] recover: restored tableData with \(tableData.rowCount) rows, \(tableData.columnCount) cols")
                newAttachment.tableData = tableData
                newAttachment.contents = pngData
                newAttachment.fileType = "public.png"
                newAttachment.updateImage()
                Self.log("[TableDebug] recover: success")
                return newAttachment
            }
            
            // 如果无法解析嵌入的JSON，尝试将整个内容作为PNG
            Self.log("[TableDebug] recover: fallback to treating entire contents as PNG")
            newAttachment.contents = contents
            newAttachment.fileType = "public.png"
        } else {
            Self.log("[TableDebug] recover: no contents or contents too small")
        }
        
        // 无法恢复原始数据，创建默认表格
        Self.log("[TableDebug] recover: creating default 3x3 table")
        newAttachment.tableData = TableData(rows: 3, columns: 3)
        newAttachment.updateImage()
        
        return newAttachment
    }
    
    /// 解析嵌入在 PNG 末尾的表格 JSON
    /// - Returns: (tableData, pngData)
    static func extractTableData(from data: Data?) -> (TableData, Data)? {
        guard let data, data.count > 4 else { return nil }
        let lengthData = data.suffix(4)
        var jsonLength: UInt32 = 0
        _ = withUnsafeMutableBytes(of: &jsonLength) { buffer in
            lengthData.copyBytes(to: buffer)
        }
        jsonLength = UInt32(bigEndian: jsonLength)
        if jsonLength == 0 || jsonLength > 200000 { return nil }
        let totalLength = Int(jsonLength) + 4
        guard totalLength <= data.count else { return nil }
        let jsonStart = data.count - totalLength
        let jsonData = data.subdata(in: jsonStart..<(data.count - 4))
        guard let tableData = try? JSONDecoder().decode(TableData.self, from: jsonData) else { return nil }
        let pngData = data.subdata(in: 0..<jsonStart)
        return (tableData, pngData)
    }
}
