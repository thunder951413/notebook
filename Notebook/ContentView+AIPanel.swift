import SwiftUI
import AppKit
import SwiftData

struct AIPanelView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore
    @Binding var isExpanded: Bool
    @Binding var panelWidth: CGFloat
    @StateObject private var themeManager = ThemeManager.shared
    private let aiService = AIService.shared
    @StateObject private var configManager = AIConfigManager.shared
    
    // 拖动状态
    @State private var isDragging: Bool = false
    @State private var dragStartWidth: CGFloat = 320
    
    // 对话状态
    @State private var messages: [AIMessage] = []
    @State private var inputText: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil
    @State private var streamingMessage: String = ""
    /// 全库问答模式开关：开启时每次提问自动检索 Top-K 相关笔记作为 context
    @State private var isKnowledgeBaseMode: Bool = true

    private let minWidth: CGFloat = 250
    private let maxWidth: CGFloat = 600
    
    var body: some View {
        VStack(spacing: 0) {
            // 顶部工具栏
            HStack {
                Text("AI 助手")
                    .font(.headline)
                    .foregroundStyle(.primary)
                
                Spacer()

                // 全库问答开关
                Button {
                    isKnowledgeBaseMode.toggle()
                } label: {
                    Image(systemName: isKnowledgeBaseMode ? "books.vertical.fill" : "books.vertical")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(isKnowledgeBaseMode ? Color.accentColor : Color.secondary)
                .notebookHelp(isKnowledgeBaseMode ? "全库问答：已开启（自动检索相关笔记）" : "全库问答：已关闭（点击开启）")

                // 插入到笔记按钮
                Button {
                    insertConversationToNote()
                } label: {
                    Image(systemName: "square.and.arrow.down")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .notebookHelp("插入对话到笔记")
                .disabled(messages.isEmpty)
                
                // 设置按钮
                AISettingsButton()
                
                Button {
                    messages.removeAll()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .notebookHelp("清空对话")
                
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        isExpanded = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .notebookHelp("关闭")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 错误提示
            if let errorMessage = errorMessage {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .padding(.top, 2)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button {
                        self.errorMessage = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.orange.opacity(0.1))
            }
            
            // 消息列表
            ScrollView {
                ScrollViewReader { proxy in
                    LazyVStack(spacing: 12) {
                        if messages.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "brain")
                                    .font(.system(size: 48))
                                    .foregroundStyle(themeManager.accentColor.opacity(0.6))
                                Text("开始与 AI 对话")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Text("输入问题或选择笔记内容提问")
                                    .font(.caption)
                                    .foregroundStyle(.secondary.opacity(0.7))
                            }
                            .frame(maxWidth: .infinity, minHeight: 200)
                            .padding(.top, 60)
                        } else {
                            ForEach(messages) { message in
                                MessageBubble(message: message)
                            }

                            if isLoading {
                                HStack {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text("AI 思考中...")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                    .onChange(of: messages.count) { _, _ in
                        if let lastId = messages.last?.id {
                            withAnimation {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: .infinity)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 输入区域
            VStack(spacing: 8) {
                // 当前模型显示（可点击选择）
                AIServiceSelectorHeader()
                
                HStack(spacing: 8) {
                    AIInputField(
                        text: $inputText,
                        onSend: sendMessage,
                        isLoading: isLoading
                    )
                    
                    Button {
                        sendMessage()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : themeManager.accentColor)
                    }
                    .buttonStyle(.plain)
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppColors.editorBackground(colorScheme))
        }
        .frame(width: panelWidth)
        .background(AppColors.editorBackground(colorScheme))
        .overlay(
            Rectangle()
                .frame(width: 1)
                .foregroundStyle(Color.gray.opacity(0.2)),
            alignment: .leading
        )
        .overlay(
            // 拖动条
            HStack {
                Rectangle()
                    .fill(isDragging ? themeManager.accentColor : Color.clear)
                    .frame(width: 4)
                    .contentShape(Rectangle().size(width: 12, height: .infinity))
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                if !isDragging {
                                    isDragging = true
                                    dragStartWidth = panelWidth
                                }
                                // 向左拖动（减小 x）增加宽度，向右拖动（增加 x）减小宽度
                                let delta = -value.translation.width
                                let newWidth = dragStartWidth + delta
                                panelWidth = min(max(newWidth, minWidth), maxWidth)
                            }
                            .onEnded { _ in
                                isDragging = false
                            }
                    )
                    .onHover { hovering in
                        if hovering {
                            NSCursor.resizeLeftRight.set()
                        } else {
                            NSCursor.arrow.set()
                        }
                    }
                Spacer()
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .insertConversation)) { _ in
            insertConversationToNote()
        }
    }

    private func sendMessage() {
        let trimmedText = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else { return }

        // 检查是否选择了配置
        guard let config = configManager.selectedConfig else {
            errorMessage = "请先配置 AI 服务"
            return
        }

        // 检查 API Key
        guard !config.apiKey.isEmpty else {
            errorMessage = "请先配置 API Key"
            return
        }

        DebugLog.app("Input text: \(trimmedText)", level: .debug)

        // ① 解析 @ 引用，提取被引用的笔记 ID + 展示文本（去掉 mention 标记）
        let (displayContent, mentionedNoteIDs, mentionedImages) = extractMentionedNotes(trimmedText)
        DebugLog.app(
            "Parsed AI response: displayCharacters=\(displayContent.count), mentionedNotes=\(mentionedNoteIDs.count), images=\(mentionedImages.count)",
            level: .debug
        )

        // ② 全库检索 Top-K 相关笔记（排除已被 @ 引用的笔记）
        let topK = AppSettings.shared.aiKnowledgeBaseTopK
        var retrievedNotes: [NoteRetriever.RetrievedNote] = []
        if isKnowledgeBaseMode {
            retrievedNotes = NoteRetriever.retrieveTopK(
                query: trimmedText,
                limit: topK,
                excluding: mentionedNoteIDs,
                store: store
            )
            DebugLog.app("Knowledge base retrieval: \(retrievedNotes.count) notes (Top-\(topK))", level: .debug)
        }

        // ③ 收集被 @ 引用的笔记内容（强制注入）
        var referencedNotes: [(title: String, content: String, images: [AIImageAttachment])] = []
        for noteID in mentionedNoteIDs {
            store.ensureNoteContentLoaded(id: noteID, pruneAfterLoad: false)
            guard let note = store.notes.first(where: { $0.id == noteID }) else { continue }
            let images = NoteRetriever.extractImages(from: note.content)
            referencedNotes.append((
                title: note.title.isEmpty ? "无标题" : note.title,
                content: note.content.string,
                images: images
            ))
        }

        // ④ 构建 context prompt（@笔记 + Top-K 笔记合并去重）
        let hasContext = !referencedNotes.isEmpty || !retrievedNotes.isEmpty
        let sendContent = buildContextPrompt(
            question: displayContent,
            referencedNotes: referencedNotes,
            retrievedNotes: retrievedNotes
        )
        let allImages = mentionedImages + referencedNotes.flatMap(\.images) + retrievedNotes.flatMap(\.images)

        let userMessage = AIMessage(content: displayContent, isUser: true)
        messages.append(userMessage)
        inputText = ""
        isLoading = true
        errorMessage = nil
        streamingMessage = ""

        // 创建临时的 AI 消息用于流式显示
        let aiMessageId = UUID()
        let aiMessage = AIMessage(id: aiMessageId, content: "", isUser: false)
        messages.append(aiMessage)

        // 准备消息历史（不包含刚添加的空AI消息）
        var messageDTOs = messages.dropLast().map { AIMessageDTO(content: $0.content, isUser: $0.isUser) }

        // ⑤ 如果有笔记 context，在消息数组最前面插入 system role 消息
        if hasContext {
            let systemPrompt = """
            你是一个笔记知识库助手。用户的问题后面附有从其笔记库中检索出的相关笔记内容。
            请基于这些笔记内容回答问题，并在回答中引用具体笔记来源。
            如果笔记中没有足够信息，请如实告知。
            """
            messageDTOs.insert(AIMessageDTO(content: systemPrompt, isUser: false, role: "system"), at: 0)
        }

        // 将最后一条用户消息替换为包含引用内容的完整消息和图片
        if let lastIndex = messageDTOs.indices.last {
            messageDTOs[lastIndex] = AIMessageDTO(content: sendContent, isUser: true, images: allImages)
        }

        // 调用 AI 服务（流式）
        Task {
            do {
                var fullResponse = ""
                try await aiService.sendMessageStream(
                    messages: messageDTOs,
                    apiKey: config.apiKey,
                    baseURL: config.baseURL,
                    model: config.model,
                    temperature: config.temperature,
                    maxTokens: config.maxTokens
                ) { chunk in
                    Task { @MainActor in
                        fullResponse += chunk
                        if let index = messages.firstIndex(where: { $0.id == aiMessageId }) {
                            messages[index].content = fullResponse
                        }
                    }
                }

                isLoading = false
            } catch {
                isLoading = false
                errorMessage = error.localizedDescription
                // 移除失败的 AI 消息
                messages.removeAll { $0.id == aiMessageId }
            }
        }
    }

    /// 解析输入文本中的 @笔记 引用，提取被引用的笔记 ID 集合和图片。
    /// 返回的 displayContent 是去掉 mention 标记后的纯问题文本（用于 UI 显示）。
    private func extractMentionedNotes(_ text: String) -> (displayContent: String, noteIDs: Set<UUID>, images: [AIImageAttachment]) {
        let pattern = #"\[@([^\]]+)\]\(note:([a-zA-Z0-9]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return (text, [], [])
        }

        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = regex.matches(in: text, options: [], range: nsRange)
        guard !matches.isEmpty else {
            return (text, [], [])
        }

        var displayContent = text
        var noteIDs = Set<UUID>()
        var allImages: [AIImageAttachment] = []

        // 从后往前替换，避免位置变化
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: text),
                  let idRange = Range(match.range(at: 2), in: text) else { continue }

            let shortID = String(text[idRange])

            // 查找匹配的笔记（通过ID前缀匹配）
            if let noteID = store.notes.first(where: { $0.id.uuidString.hasPrefix(shortID) })?.id {
                noteIDs.insert(noteID)
                store.ensureNoteContentLoaded(id: noteID, pruneAfterLoad: false)
                if let note = store.notes.first(where: { $0.id == noteID }) {
                    let images = NoteRetriever.extractImages(from: note.content)
                    allImages.append(contentsOf: images)
                }
            }

            // 在展示文本中替换为 [@标题] 简化标记
            let titleRange = Range(match.range(at: 1), in: text)
            let title = titleRange.map { String(text[$0]) } ?? "笔记"
            displayContent.replaceSubrange(fullRange, with: "[@\(title)]")
        }

        return (displayContent, noteIDs, allImages)
    }

    /// 构建 context prompt：用户问题 + 引用笔记内容 + 检索笔记内容
    private func buildContextPrompt(
        question: String,
        referencedNotes: [(title: String, content: String, images: [AIImageAttachment])],
        retrievedNotes: [NoteRetriever.RetrievedNote]
    ) -> String {
        guard !referencedNotes.isEmpty || !retrievedNotes.isEmpty else {
            return question
        }

        var content = "用户问题：\(question)\n\n"
        content += "---\n\n"

        // 先放 @引用的笔记（用户显式指定的，优先级更高）
        if !referencedNotes.isEmpty {
            content += "用户指定引用的笔记：\n\n"
            for (index, note) in referencedNotes.enumerated() {
                content += "【引用笔记 \(index + 1)】\(note.title)\n"
                content += "\(note.content)\n"
                if !note.images.isEmpty {
                    content += "[包含 \(note.images.count) 张图片]\n"
                }
                content += "\n"
            }
        }

        // 再放 Top-K 检索的笔记
        if !retrievedNotes.isEmpty {
            content += "知识库检索到的相关笔记：\n\n"
            for (index, note) in retrievedNotes.enumerated() {
                content += "【笔记 \(index + 1)】\(note.title)\n"
                content += "\(note.content)\n"
                if !note.images.isEmpty {
                    content += "[包含 \(note.images.count) 张图片]\n"
                }
                content += "\n"
            }
        }

        content += "---\n"
        content += "请基于以上笔记内容回答用户问题。如果笔记中没有相关信息，请说明。"

        return content
    }

    /// 将当前对话插入到笔记光标位置
    private func insertConversationToNote() {
        guard !messages.isEmpty else { return }

        // 构建对话内容
        var conversationText = "\n\n--- AI 对话 ---\n\n"
        for message in messages {
            let role = message.isUser ? "用户" : "AI"
            conversationText += "【\(role)】\n\(message.content)\n\n"
        }
        conversationText += "--- 对话结束 ---\n"

        // 发送通知让 ContentView 处理插入
        NotificationCenter.default.post(
            name: .insertTextAtCursor,
            object: nil,
            userInfo: ["text": conversationText]
        )
    }
}
