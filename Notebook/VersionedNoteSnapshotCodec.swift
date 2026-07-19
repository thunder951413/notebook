import Foundation
import Compression

/// 数据库内部历史快照的向后兼容存储编解码器。
///
/// 同步信封仍使用普通 JSON；这里只压缩 `BlockDocumentNoteVersionEntity.snapshotData`。
/// 没有魔数的旧数据按原始 JSON 读取，因而不需要一次性迁移，也不会改变内容指纹。
enum VersionedNoteSnapshotCodec {
    enum CodecError: LocalizedError {
        case invalidHeader
        case invalidUncompressedSize(Int)
        case decompressionFailed(expected: Int, actual: Int)

        var errorDescription: String? {
            switch self {
            case .invalidHeader:
                return "历史快照压缩头无效"
            case .invalidUncompressedSize(let size):
                return "历史快照声明了不安全的解压大小：\(size)"
            case .decompressionFailed(let expected, let actual):
                return "历史快照解压失败（期望 \(expected) 字节，实际 \(actual) 字节）"
            }
        }
    }

    nonisolated private static let magic = Data("NBKSNPZ1".utf8)
    nonisolated private static let sizeFieldLength = MemoryLayout<UInt64>.size
    nonisolated private static let maximumUncompressedBytes = 512 * 1024 * 1024

    static func encode(
        _ snapshot: VersionedNoteSnapshot,
        using encoder: JSONEncoder
    ) throws -> Data {
        try storageData(from: encoder.encode(snapshot))
    }

    static func decode(
        _ storedData: Data,
        using decoder: JSONDecoder
    ) throws -> VersionedNoteSnapshot {
        try decoder.decode(VersionedNoteSnapshot.self, from: rawJSON(from: storedData))
    }

    nonisolated static func storageData(from rawJSON: Data) throws -> Data {
        guard let compressed = compress(rawJSON) else { return rawJSON }
        let headerLength = magic.count + sizeFieldLength
        guard compressed.count + headerLength < rawJSON.count else {
            return rawJSON
        }

        var result = Data(capacity: headerLength + compressed.count)
        result.append(magic)
        var originalSize = UInt64(rawJSON.count).littleEndian
        withUnsafeBytes(of: &originalSize) { result.append(contentsOf: $0) }
        result.append(compressed)
        return result
    }

    nonisolated static func rawJSON(from storedData: Data) throws -> Data {
        guard storedData.starts(with: magic) else { return storedData }
        let headerLength = magic.count + sizeFieldLength
        guard storedData.count > headerLength else { throw CodecError.invalidHeader }

        let sizeBytes = storedData[magic.count..<headerLength]
        let declaredSize = sizeBytes.enumerated().reduce(UInt64(0)) { partial, pair in
            partial | (UInt64(pair.element) << UInt64(pair.offset * 8))
        }
        guard declaredSize > 0,
              declaredSize <= UInt64(maximumUncompressedBytes),
              declaredSize <= UInt64(Int.max) else {
            throw CodecError.invalidUncompressedSize(Int(clamping: declaredSize))
        }

        let expectedSize = Int(declaredSize)
        let compressed = storedData.dropFirst(headerLength)
        var decoded = Data(count: expectedSize)
        let decodedCount = decoded.withUnsafeMutableBytes { destination in
            compressed.withUnsafeBytes { source in
                guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress,
                      let sourceBase = source.bindMemory(to: UInt8.self).baseAddress else {
                    return 0
                }
                return compression_decode_buffer(
                    destinationBase,
                    expectedSize,
                    sourceBase,
                    compressed.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        guard decodedCount == expectedSize else {
            throw CodecError.decompressionFailed(expected: expectedSize, actual: decodedCount)
        }
        return decoded
    }

    nonisolated static func isCompressed(_ data: Data) -> Bool {
        data.starts(with: magic)
    }

    nonisolated private static func compress(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        var capacity = max(256, data.count + data.count / 8 + 64)

        for _ in 0..<4 {
            var destination = Data(count: capacity)
            let compressedCount = destination.withUnsafeMutableBytes { destinationBytes in
                data.withUnsafeBytes { sourceBytes in
                    guard let destinationBase = destinationBytes.bindMemory(to: UInt8.self).baseAddress,
                          let sourceBase = sourceBytes.bindMemory(to: UInt8.self).baseAddress else {
                        return 0
                    }
                    return compression_encode_buffer(
                        destinationBase,
                        capacity,
                        sourceBase,
                        data.count,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }
            if compressedCount > 0 {
                destination.removeSubrange(compressedCount..<destination.count)
                return destination
            }
            capacity *= 2
        }
        return nil
    }
}
