import Foundation
import Compression

enum ArchiveUtility {
    static func createZip(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default

        // 如果目标文件已存在，先删除
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }

        // 使用原生 Swift 创建 ZIP 归档
        try createZipArchive(sourceDirectory: sourceURL, destinationURL: destinationURL)
    }

    /// 使用原生 Swift 创建 ZIP 归档
    private static func createZipArchive(sourceDirectory: URL, destinationURL: URL) throws {
        DebugLog.storage("开始创建 ZIP 归档...", level: .debug)
        DebugLog.storage("源目录: \(sourceDirectory.path)", level: .debug)
        DebugLog.storage("目标文件: \(destinationURL.path)", level: .debug)

        // 递归收集所有文件
        var files: [(relativePath: String, fileURL: URL)] = []
        try collectFiles(in: sourceDirectory, relativePath: "", files: &files)
        DebugLog.storage("收集到 \(files.count) 个文件", level: .debug)

        // 创建 ZIP 数据
        var zipData = Data()
        var fileEntries: [(relativePath: String, fileData: Data, crc32: UInt32, localHeaderSize: Int)] = []

        // 写入本地文件头
        for (index, (relativePath, fileURL)) in files.enumerated() {
            DebugLog.storage("处理文件 \(index + 1)/\(files.count): \(relativePath)", level: .debug)

            do {
                let fileData = try Data(contentsOf: fileURL)
                let crc32 = calculateCRC32(fileData)
                let compressedData = compressData(fileData)

                // 本地文件头
                let localHeader = createLocalFileHeader(
                    fileName: relativePath,
                    compressedSize: compressedData.count,
                    uncompressedSize: fileData.count,
                    crc32: crc32
                )
                zipData.append(localHeader)
                zipData.append(compressedData)

                // 记录文件信息用于中央目录
                fileEntries.append((relativePath: relativePath, fileData: fileData, crc32: crc32, localHeaderSize: localHeader.count))
            } catch {
                DebugLog.storage("无法读取文件 \(relativePath): \(error)", level: .warn)
                throw error
            }
        }

        DebugLog.storage("写入中央目录...", level: .debug)

        // 写入中央目录
        var centralDirectory = Data()
        var centralDirectoryOffset = 0

        for entry in fileEntries {
            let compressedData = compressData(entry.fileData)

            let centralHeader = createCentralDirectoryHeader(
                fileName: entry.relativePath,
                compressedSize: compressedData.count,
                uncompressedSize: entry.fileData.count,
                crc32: entry.crc32,
                localHeaderOffset: centralDirectoryOffset
            )
            centralDirectory.append(centralHeader)
            centralDirectoryOffset += entry.localHeaderSize + compressedData.count
        }

        zipData.append(centralDirectory)

        // 写入结束记录
        let endRecord = createEndOfCentralDirectory(
            numEntries: files.count,
            centralDirectorySize: centralDirectory.count,
            centralDirectoryOffset: centralDirectoryOffset
        )
        zipData.append(endRecord)

        DebugLog.storage("写入 ZIP 文件，大小: \(zipData.count) bytes...", level: .debug)

        // 写入文件
        do {
            try zipData.write(to: destinationURL)
            DebugLog.storage("ZIP 文件创建成功", level: .debug)
        } catch {
            DebugLog.storage("写入 ZIP 文件失败: \(error)", level: .warn)
            throw error
        }
    }

    /// 递归收集目录中的所有文件
    private static func collectFiles(in directory: URL, relativePath: String, files: inout [(relativePath: String, fileURL: URL)]) throws {
        let fileManager = FileManager.default
        let contents = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)

        for item in contents {
            let itemName = item.lastPathComponent
            let itemRelativePath = relativePath.isEmpty ? itemName : "\(relativePath)/\(itemName)"

            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: item.path, isDirectory: &isDirectory) {
                if isDirectory.boolValue {
                    // 递归处理子目录
                    try collectFiles(in: item, relativePath: itemRelativePath, files: &files)
                } else {
                    // 添加文件
                    files.append((relativePath: itemRelativePath, fileURL: item))
                }
            }
        }
    }

    // MARK: - ZIP 格式辅助方法

    /// 计算 CRC32
    private static func calculateCRC32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        let table = crc32Table

        for byte in data {
            let index = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = (crc >> 8) ^ table[index]
        }

        return crc ^ 0xFFFFFFFF
    }

    /// CRC32 查找表
    private static var crc32Table: [UInt32] = {
        var table = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var crc = UInt32(i)
            for _ in 0..<8 {
                if crc & 1 == 1 {
                    crc = (crc >> 1) ^ 0xEDB88320
                } else {
                    crc >>= 1
                }
            }
            table[i] = crc
        }
        return table
    }()

    /// 压缩数据（使用存储模式，不压缩）
    private static func compressData(_ data: Data) -> Data {
        // 使用存储模式（不压缩），简化实现
        return data
    }

    /// 创建本地文件头
    private static func createLocalFileHeader(fileName: String, compressedSize: Int, uncompressedSize: Int, crc32: UInt32) -> Data {
        var header = Data()
        let fileNameData = fileName.data(using: .utf8)!

        // 本地文件头签名
        header.append(contentsOf: [0x50, 0x4B, 0x03, 0x04])
        // 版本（2.0）
        header.append(contentsOf: [0x14, 0x00])
        // 通用标志
        header.append(contentsOf: [0x00, 0x00])
        // 压缩方法（0 = 存储）
        header.append(contentsOf: [0x00, 0x00])
        // 修改时间/日期
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // CRC32
        header.append(contentsOf: withUnsafeBytes(of: crc32.littleEndian) { Array($0) })
        // 压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(compressedSize).littleEndian) { Array($0) })
        // 未压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(uncompressedSize).littleEndian) { Array($0) })
        // 文件名长度
        header.append(contentsOf: withUnsafeBytes(of: UInt16(fileNameData.count).littleEndian) { Array($0) })
        // 额外字段长度
        header.append(contentsOf: [0x00, 0x00])
        // 文件名
        header.append(fileNameData)

        return header
    }

    /// 创建中央目录头
    private static func createCentralDirectoryHeader(fileName: String, compressedSize: Int, uncompressedSize: Int, crc32: UInt32, localHeaderOffset: Int) -> Data {
        var header = Data()
        let fileNameData = fileName.data(using: .utf8)!

        // 中央目录签名
        header.append(contentsOf: [0x50, 0x4B, 0x01, 0x02])
        // 创建者版本
        header.append(contentsOf: [0x14, 0x00])
        // 所需版本
        header.append(contentsOf: [0x14, 0x00])
        // 通用标志
        header.append(contentsOf: [0x00, 0x00])
        // 压缩方法
        header.append(contentsOf: [0x00, 0x00])
        // 修改时间/日期
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // CRC32
        header.append(contentsOf: withUnsafeBytes(of: crc32.littleEndian) { Array($0) })
        // 压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(compressedSize).littleEndian) { Array($0) })
        // 未压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(uncompressedSize).littleEndian) { Array($0) })
        // 文件名长度
        header.append(contentsOf: withUnsafeBytes(of: UInt16(fileNameData.count).littleEndian) { Array($0) })
        // 额外字段长度
        header.append(contentsOf: [0x00, 0x00])
        // 注释长度
        header.append(contentsOf: [0x00, 0x00])
        // 磁盘号
        header.append(contentsOf: [0x00, 0x00])
        // 内部文件属性
        header.append(contentsOf: [0x00, 0x00])
        // 外部文件属性
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // 本地文件头偏移
        header.append(contentsOf: withUnsafeBytes(of: UInt32(localHeaderOffset).littleEndian) { Array($0) })
        // 文件名
        header.append(fileNameData)

        return header
    }

    /// 创建中央目录结束记录
    private static func createEndOfCentralDirectory(numEntries: Int, centralDirectorySize: Int, centralDirectoryOffset: Int) -> Data {
        var record = Data()

        // 结束记录签名
        record.append(contentsOf: [0x50, 0x4B, 0x05, 0x06])
        // 磁盘号
        record.append(contentsOf: [0x00, 0x00])
        // 中央目录起始磁盘
        record.append(contentsOf: [0x00, 0x00])
        // 磁盘上的条目数
        record.append(contentsOf: withUnsafeBytes(of: UInt16(numEntries).littleEndian) { Array($0) })
        // 总条目数
        record.append(contentsOf: withUnsafeBytes(of: UInt16(numEntries).littleEndian) { Array($0) })
        // 中央目录大小
        record.append(contentsOf: withUnsafeBytes(of: UInt32(centralDirectorySize).littleEndian) { Array($0) })
        // 中央目录偏移
        record.append(contentsOf: withUnsafeBytes(of: UInt32(centralDirectoryOffset).littleEndian) { Array($0) })
        // 注释长度
        record.append(contentsOf: [0x00, 0x00])

        return record
    }


    static func unzipFile(at zipURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destinationURL, withIntermediateDirectories: true)

        // 读取 ZIP 文件数据
        let zipData = try Data(contentsOf: zipURL)

        // 解析并解压 ZIP 文件
        try extractZipData(zipData, to: destinationURL)
    }

    /// 解析并解压 ZIP 数据
    private static func extractZipData(_ zipData: Data, to destinationURL: URL) throws {
        var offset = 0
        var fileEntries: [ZipEntry] = []

        // 首先扫描所有本地文件头
        while offset < zipData.count - 30 {
            // 检查本地文件头签名 (0x04034b50)
            guard zipData.count >= offset + 4 else { break }
            let signature = zipData.subdata(in: offset..<offset+4).withUnsafeBytes { $0.load(as: UInt32.self) }

            if signature == 0x04034b50 {
                // 解析本地文件头
                let entry = try parseLocalFileHeader(zipData, offset: offset)
                fileEntries.append(entry)
                offset = entry.nextOffset
            } else if signature == 0x02014b50 {
                // 中央目录开始，停止扫描
                break
            } else {
                offset += 1
            }
        }

        // 解压每个文件
        for entry in fileEntries {
            // 安全检查：防止路径遍历攻击
            let sanitizedName = sanitizeZipEntryName(entry.name)
            guard !sanitizedName.isEmpty else {
                DebugLog.storage("跳过无效文件名: \(entry.name)", level: .debug)
                continue
            }

            let fileURL = destinationURL.appendingPathComponent(sanitizedName)

            // 确保文件在目标目录内
            let resolvedPath = fileURL.resolvingSymlinksInPath().path
            let resolvedDest = destinationURL.resolvingSymlinksInPath().path
            guard resolvedPath.hasPrefix(resolvedDest) else {
                DebugLog.storage("检测到路径遍历攻击，跳过: \(entry.name)", level: .debug)
                continue
            }

            let fileDir = fileURL.deletingLastPathComponent()

            // 创建目录结构
            if !FileManager.default.fileExists(atPath: fileDir.path) {
                try FileManager.default.createDirectory(at: fileDir, withIntermediateDirectories: true)
            }

            // 解压数据
            let uncompressedData: Data
            if entry.compressionMethod == 0 {
                // 存储模式（未压缩）
                uncompressedData = entry.data
            } else if entry.compressionMethod == 8 {
                // DEFLATE 压缩 - 使用 zlib 解压
                uncompressedData = try decompressData(entry.data, uncompressedSize: entry.uncompressedSize)
            } else {
                throw NSError(domain: "ArchiveUtility", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported compression method: \(entry.compressionMethod)"])
            }

            // 写入文件
            try uncompressedData.write(to: fileURL)
        }

        DebugLog.storage("解压完成，共 \(fileEntries.count) 个文件", level: .debug)
    }

    /// ZIP 文件条目
    private struct ZipEntry {
        let name: String
        let data: Data
        let nextOffset: Int
        let compressedSize: Int
        let uncompressedSize: Int
        let compressionMethod: UInt16
    }

    /// 解析本地文件头
    private static func parseLocalFileHeader(_ zipData: Data, offset: Int) throws -> ZipEntry {
        guard zipData.count >= offset + 30 else {
            throw NSError(domain: "ArchiveUtility", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid local file header"])
        }

        // 跳过签名 (4 bytes)
        var pos = offset + 4

        // 版本 (2 bytes) + 标志 (2 bytes) + 压缩方法 (2 bytes)
        let compressionMethod = zipData.subdata(in: pos+4..<pos+6).withUnsafeBytes { $0.load(as: UInt16.self) }
        pos += 6

        // 修改时间 (2 bytes) + 修改日期 (2 bytes)
        pos += 4

        // CRC32 (4 bytes)
        pos += 4

        // 压缩大小 (4 bytes)
        let compressedSize = Int(zipData.subdata(in: pos..<pos+4).withUnsafeBytes { $0.load(as: UInt32.self) })
        pos += 4

        // 未压缩大小 (4 bytes)
        let uncompressedSize = Int(zipData.subdata(in: pos..<pos+4).withUnsafeBytes { $0.load(as: UInt32.self) })
        pos += 4

        // 文件名长度 (2 bytes)
        let fileNameLength = Int(zipData.subdata(in: pos..<pos+2).withUnsafeBytes { $0.load(as: UInt16.self) })
        pos += 2

        // 额外字段长度 (2 bytes)
        let extraFieldLength = Int(zipData.subdata(in: pos..<pos+2).withUnsafeBytes { $0.load(as: UInt16.self) })
        pos += 2

        // 文件名
        guard zipData.count >= pos + fileNameLength else {
            throw NSError(domain: "ArchiveUtility", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid file name"])
        }
        let fileNameData = zipData.subdata(in: pos..<pos+fileNameLength)
        let fileName = String(data: fileNameData, encoding: .utf8) ?? "unknown"
        pos += fileNameLength

        // 跳过额外字段
        pos += extraFieldLength

        // 文件数据
        guard zipData.count >= pos + compressedSize else {
            throw NSError(domain: "ArchiveUtility", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid file data"])
        }
        let fileData = zipData.subdata(in: pos..<pos+compressedSize)
        pos += compressedSize

        return ZipEntry(name: fileName, data: fileData, nextOffset: pos, compressedSize: compressedSize, uncompressedSize: uncompressedSize, compressionMethod: compressionMethod)
    }

    /// 解压 DEFLATE 压缩的数据
    private static func decompressData(_ data: Data, uncompressedSize: Int) throws -> Data {
        // 使用 Compression 框架解压
        guard !data.isEmpty else { return Data() }

        let bufferSize = max(uncompressedSize, 4096)
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destinationBuffer.deallocate() }

        let result = data.withUnsafeBytes { sourcePtr in
            compression_decode_buffer(
                destinationBuffer,
                bufferSize,
                sourcePtr.bindMemory(to: UInt8.self).baseAddress!,
                data.count,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard result != 0 else {
            throw NSError(domain: "ArchiveUtility", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to decompress data"])
        }

        return Data(bytes: destinationBuffer, count: result)
    }

    /// 清理 ZIP 条目文件名，防止路径遍历攻击
    private static func sanitizeZipEntryName(_ name: String) -> String {
        // 移除前导的 /
        var sanitized = name
        while sanitized.hasPrefix("/") {
            sanitized.removeFirst()
        }

        // 分割路径组件
        let components = sanitized.split(separator: "/").map(String.init)

        // 过滤掉 .. 和 . 以及空组件
        var validComponents: [String] = []
        for component in components {
            if component == ".." || component == "." || component.isEmpty {
                continue
            }
            // 检查非法字符
            if component.contains("..") || component.contains("//") {
                continue
            }
            validComponents.append(component)
        }

        return validComponents.joined(separator: "/")
    }

}
