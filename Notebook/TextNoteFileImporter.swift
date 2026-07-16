import Foundation
import SwiftUI

struct ImportedTextNoteFile: Sendable, Equatable {
    let sourceURL: URL
    let title: String
    let content: String
}

struct TextNoteImportFailure: Sendable, Equatable {
    let filename: String
    let message: String
}

struct TextNoteImportBatch: Sendable, Equatable {
    let documents: [ImportedTextNoteFile]
    let failures: [TextNoteImportFailure]
}

struct TextNoteImportTarget: Sendable, Equatable {
    let folderID: UUID?
    let folderName: String
    let encryptedFolderID: UUID?
    let tagID: UUID?
}

enum TextNoteFileImportError: LocalizedError {
    case unsupportedType(String)
    case notARegularFile(String)
    case fileTooLarge(String, Int)
    case unsupportedEncoding(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedType(let filename):
            return "不支持的文件类型：\(filename)"
        case .notARegularFile(let filename):
            return "不是可读取的普通文件：\(filename)"
        case .fileTooLarge(let filename, let maximumMegabytes):
            return "文件过大：\(filename)（最大 \(maximumMegabytes) MB）"
        case .unsupportedEncoding(let filename):
            return "无法识别文本编码：\(filename)"
        }
    }
}

enum TextNoteFileImporter {
    nonisolated static let supportedPathExtensions: Set<String> = ["txt", "md"]
    nonisolated static let maximumByteCount = 50 * 1_024 * 1_024

    nonisolated static func supports(_ url: URL) -> Bool {
        supportedPathExtensions.contains(url.pathExtension.lowercased())
    }

    nonisolated static func load(_ url: URL) throws -> ImportedTextNoteFile {
        let filename = url.lastPathComponent
        guard supports(url) else {
            throw TextNoteFileImportError.unsupportedType(filename)
        }

        let accessedSecurityScope = url.startAccessingSecurityScopedResource()
        defer {
            if accessedSecurityScope {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let resourceValues = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard resourceValues.isRegularFile == true else {
            throw TextNoteFileImportError.notARegularFile(filename)
        }
        if let fileSize = resourceValues.fileSize, fileSize > maximumByteCount {
            throw TextNoteFileImportError.fileTooLarge(filename, maximumByteCount / 1_024 / 1_024)
        }

        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let encodings: [String.Encoding] = [
            .utf8,
            .utf16,
            .utf16LittleEndian,
            .utf16BigEndian,
            .isoLatin1
        ]
        guard let content = encodings.lazy.compactMap({ String(data: data, encoding: $0) }).first else {
            throw TextNoteFileImportError.unsupportedEncoding(filename)
        }

        let title = url.deletingPathExtension().lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ImportedTextNoteFile(
            sourceURL: url,
            title: title.isEmpty ? filename : title,
            content: content
        )
    }

    nonisolated static func loadBatch(_ urls: [URL]) -> TextNoteImportBatch {
        var documents: [ImportedTextNoteFile] = []
        var failures: [TextNoteImportFailure] = []

        for url in urls where supports(url) {
            do {
                documents.append(try load(url))
            } catch {
                failures.append(
                    TextNoteImportFailure(
                        filename: url.lastPathComponent,
                        message: error.localizedDescription
                    )
                )
            }
        }
        return TextNoteImportBatch(documents: documents, failures: failures)
    }
}

struct TextNoteDropModifier: ViewModifier {
    @Binding var isTargeted: Bool
    @Binding var isImporting: Bool
    @Binding var message: String?
    let accentColor: Color
    let onDrop: ([URL]) -> Bool

    private var isShowingMessage: Binding<Bool> {
        Binding(
            get: { message != nil },
            set: { isPresented in
                if !isPresented {
                    message = nil
                }
            }
        )
    }

    func body(content: Content) -> some View {
        content
            .dropDestination(for: URL.self) { urls, _ in
                onDrop(urls)
            } isTargeted: { newValue in
                isTargeted = newValue
            }
            .overlay {
                if isTargeted || isImporting {
                    ZStack {
                        RoundedRectangle(cornerRadius: 14)
                            .fill(accentColor.opacity(0.12))
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(accentColor, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))

                        Label(
                            isImporting ? "正在导入文本笔记…" : "松开以导入 TXT / Markdown 笔记",
                            systemImage: isImporting ? "arrow.triangle.2.circlepath" : "doc.badge.plus"
                        )
                        .font(.headline)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .background(.regularMaterial, in: Capsule())
                    }
                    .padding(12)
                    .allowsHitTesting(false)
                }
            }
            .alert("导入文本笔记", isPresented: isShowingMessage) {
                Button("好", role: .cancel) {
                    message = nil
                }
            } message: {
                Text(message ?? "导入失败")
            }
    }
}
