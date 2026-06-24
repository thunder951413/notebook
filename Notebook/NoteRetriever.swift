import Foundation
import AppKit

/// 从笔记库中检索与用户问题最相关的 Top-K 篇笔记。
///
/// 检索算法（简单有效，无需 FTS/向量）：
/// 1. 把问题拆成带权重的搜索线索：原始短语、中文关键词、英文/CamelCase 标识符片段
/// 2. 对常见关系型问题做轻量同义词扩展（如“上级”→“主管/领导/manager/汇报”）
/// 3. 标题命中、正文命中、完整短语命中分别计分
/// 4. 按 score 降序排列，取前 K 篇（score > 0 的才入选）
/// 5. 排除已被 @ 引用的笔记 ID（避免重复注入）
struct NoteRetriever {
    /// 检索结果
    struct RetrievedNote {
        let id: UUID
        let title: String
        let content: String
        let relevanceScore: Int
        let images: [AIImageAttachment]
    }

    /// 用问题文本检索最相关的 Top-K 篇笔记
    /// - Parameters:
    ///   - query: 用户的问题文本
    ///   - limit: 最多返回的笔记数（Top-K）
    ///   - excludedIDs: 需排除的笔记 ID（如已被 @ 引用的笔记）
    ///   - store: NoteStore 实例
    /// - Returns: 按相关度降序排列的笔记列表
    static func retrieveTopK(
        query: String,
        limit: Int = 5,
        excluding excludedIDs: Set<UUID>,
        store: NoteStore
    ) -> [RetrievedNote] {
        let clues = searchClues(for: query)
        guard !clues.isEmpty else { return [] }

        guard let context = store.modelContext else { return [] }

        // 过滤候选笔记：非回收站、未被 @ 排除
        let candidates = store.activeNotes.filter { !excludedIDs.contains($0.id) }
        guard !candidates.isEmpty else { return [] }

        var scored: [RetrievedNote] = []

        for note in candidates {
            // 获取可搜索文本（标题 + 正文）
            let title = note.title
            let bodyText: String
            if note.isContentLoaded {
                bodyText = note.content.string
            } else {
                bodyText = (try? store.loadSearchableText(noteID: note.id, context: context)) ?? note.contentPreview
            }
            // 统计命中线索分数
            let score = relevanceScore(title: title, body: bodyText, clues: clues)
            guard score > 0 else { continue }

            // 提取图片（仅对已加载内容的笔记）
            let images: [AIImageAttachment]
            if note.isContentLoaded {
                images = Self.extractImages(from: note.content)
            } else {
                images = []
            }

            scored.append(RetrievedNote(
                id: note.id,
                title: title.isEmpty ? "无标题" : title,
                content: bodyText,
                relevanceScore: score,
                images: images
            ))
        }

        // 按相关度降序排列，取前 K 篇
        return scored.sorted { $0.relevanceScore > $1.relevanceScore }.prefix(limit).map { $0 }
    }

    // MARK: - 分词

    private enum ClueKind {
        case exactPhrase
        case keyword
        case expandedKeyword

        var bodyWeight: Int {
            switch self {
            case .exactPhrase: return 8
            case .keyword: return 3
            case .expandedKeyword: return 2
            }
        }

        var titleBonus: Int {
            switch self {
            case .exactPhrase: return 8
            case .keyword: return 4
            case .expandedKeyword: return 2
            }
        }
    }

    private struct SearchClue {
        let text: String
        let kind: ClueKind
    }

    /// 将查询文本转换为搜索线索。
    /// 中文保留连续关键词/2-gram，不再只按单字匹配；英文额外拆 CamelCase / snake_case / kebab-case。
    private static func searchClues(for text: String) -> [SearchClue] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var clues: [SearchClue] = []
        var seen = Set<String>()

        func append(_ raw: String, kind: ClueKind) {
            let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty else { return }

            let isCJK = normalized.unicodeScalars.contains { $0.value > 0x2E80 }
            let lowercased = normalized.lowercased()
            guard isCJK || lowercased.count >= 2 else { return }
            guard !isNoiseToken(lowercased) else { return }
            guard seen.insert(lowercased).inserted else { return }

            clues.append(SearchClue(text: normalized, kind: kind))
        }

        append(trimmed, kind: .exactPhrase)

        for phrase in cjkKeywordPhrases(in: trimmed) {
            append(phrase, kind: .keyword)
        }

        var currentLatin = ""
        for scalar in trimmed.unicodeScalars {
            let char = Character(scalar)

            if char.isLetter || char.isNumber {
                if scalar.value > 0x2E80 {
                    if !currentLatin.isEmpty {
                        appendLatinToken(currentLatin, to: &clues, seen: &seen)
                        currentLatin = ""
                    }
                } else {
                    currentLatin.append(char)
                }
            } else {
                if !currentLatin.isEmpty {
                    appendLatinToken(currentLatin, to: &clues, seen: &seen)
                    currentLatin = ""
                }
            }
        }

        if !currentLatin.isEmpty {
            appendLatinToken(currentLatin, to: &clues, seen: &seen)
        }

        for expanded in expandedQueryTerms(from: clues.map(\.text)) {
            append(expanded, kind: .expandedKeyword)
        }

        return clues
    }

    private static func appendLatinToken(_ token: String, to clues: inout [SearchClue], seen: inout Set<String>) {
        func append(_ raw: String) {
            let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let lowercased = normalized.lowercased()
            guard lowercased.count >= 2, !isNoiseToken(lowercased), seen.insert(lowercased).inserted else { return }
            clues.append(SearchClue(text: normalized, kind: .keyword))
        }

        append(token)

        for part in splitIdentifier(token) where part.caseInsensitiveCompare(token) != .orderedSame {
            append(part)
        }
    }

    private static func splitIdentifier(_ token: String) -> [String] {
        let separated = token.replacingOccurrences(of: #"[_\-.]+"#, with: " ", options: .regularExpression)
        let pattern = #"[A-Z]+(?=[A-Z][a-z]|\b)|[A-Z]?[a-z]+|\d+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return separated.split(separator: " ").map(String.init)
        }

        return separated
            .split(separator: " ")
            .flatMap { chunk -> [String] in
                let value = String(chunk)
                let range = NSRange(value.startIndex..., in: value)
                let matches = regex.matches(in: value, options: [], range: range)
                let parts = matches.compactMap { match -> String? in
                    guard let swiftRange = Range(match.range, in: value) else { return nil }
                    return String(value[swiftRange])
                }
                return parts.isEmpty ? [value] : parts
            }
    }

    private static func cjkKeywordPhrases(in text: String) -> [String] {
        let segments = text.split { scalar in
            guard let unicodeScalar = scalar.unicodeScalars.first else { return true }
            return unicodeScalar.value <= 0x2E80
        }.map(String.init)

        var phrases: [String] = []
        for segment in segments {
            let characters = Array(segment).map(String.init)
            guard !characters.isEmpty else { continue }

            for n in stride(from: min(4, characters.count), through: 2, by: -1) {
                guard characters.count >= n else { continue }
                for index in 0...(characters.count - n) {
                    let phrase = characters[index..<(index + n)].joined()
                    if !isNoiseToken(phrase) {
                        phrases.append(phrase)
                    }
                }
            }

            for character in characters where !isNoiseToken(character) {
                phrases.append(character)
            }
        }

        return phrases
    }

    private static func expandedQueryTerms(from terms: [String]) -> [String] {
        let joined = terms.joined(separator: " ").lowercased()
        var expanded: [String] = []

        if joined.contains("上级") || joined.contains("领导") || joined.contains("主管") || joined.contains("老板") || joined.contains("manager") || joined.contains("supervisor") {
            expanded += [
                "主管", "直属主管", "直接主管", "领导", "上级", "老板",
                "manager", "supervisor", "lead", "leader", "reports to", "report to",
                "汇报", "汇报给", "直属", "负责人"
            ]
        }

        if joined.contains("是什么") || joined.contains("什么意思") || joined.contains("what is") {
            expanded += ["定义", "含义", "说明", "介绍", "用途", "作用", "meaning", "definition", "overview"]
        }

        return expanded
    }

    private static func isNoiseToken(_ token: String) -> Bool {
        let stopwords: Set<String> = [
            "我", "的", "是", "谁", "什么", "哪个", "哪位", "吗", "呢", "了", "和", "与", "及",
            "这个", "那个", "一下", "请问", "告诉", "帮我", "我的", "是谁", "是什么",
            "a", "an", "the", "is", "are", "am", "who", "what", "which", "please", "tell", "me", "my"
        ]
        return stopwords.contains(token.lowercased())
    }

    // MARK: - 匹配计分

    /// 统计文本中命中的线索分数（每个线索最多计 1 次）
    private static func relevanceScore(title: String, body: String, clues: [SearchClue]) -> Int {
        var score = 0
        for clue in clues {
            var clueScore = 0
            if title.localizedCaseInsensitiveContains(clue.text) {
                clueScore += clue.kind.bodyWeight + clue.kind.titleBonus
            }
            if body.localizedCaseInsensitiveContains(clue.text) {
                clueScore += clue.kind.bodyWeight
            }
            score += clueScore
        }
        return score
    }

    // MARK: - 图片提取

    /// 从 NSAttributedString 中提取图片附件（与 AIPanelView 原有 extractImages 逻辑一致）
    static func extractImages(from attributedString: NSAttributedString) -> [AIImageAttachment] {
        var images: [AIImageAttachment] = []
        let range = NSRange(location: 0, length: attributedString.length)

        attributedString.enumerateAttribute(.attachment, in: range, options: []) { value, _, _ in
            guard let attachment = value else { return }

            // 处理 AttachmentTextAttachment
            if let textAttachment = attachment as? AttachmentTextAttachment {
                guard textAttachment.kind == .image else { return }
                guard let imageData = textAttachment.attachmentData() else { return }

                let base64String = imageData.base64EncodedString()
                let mimeType = Self.mimeTypeForPath(textAttachment.attachmentFilename)
                images.append(AIImageAttachment(base64Data: base64String, mimeType: mimeType))
            }
            // 处理普通 NSTextAttachment
            else if let nsAttachment = attachment as? NSTextAttachment {
                // 尝试从 fileWrapper 获取数据
                if let fileWrapper = nsAttachment.fileWrapper,
                   let data = fileWrapper.regularFileContents {
                    let base64String = data.base64EncodedString()
                    images.append(AIImageAttachment(base64Data: base64String, mimeType: "image/png"))
                }
                // 尝试从 image 属性获取
                else if let image = nsAttachment.image,
                        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
                    if let data = bitmapRep.representation(using: .png, properties: [:]) {
                        let base64String = data.base64EncodedString()
                        images.append(AIImageAttachment(base64Data: base64String, mimeType: "image/png"))
                    }
                }
            }
        }

        return images
    }

    /// 根据文件路径获取 MIME 类型
    private static func mimeTypeForPath(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        default: return "image/jpeg"
        }
    }
}
