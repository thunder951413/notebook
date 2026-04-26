import SwiftUI
import SwiftData

/// 冲突差异视图：左右对比本地和远程版本
struct ConflictDiffView: View {
    let noteID: UUID
    let localContent: NSAttributedString

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: NoteStore

    @State private var remoteText: String = ""
    @State private var localText: String = ""
    @State private var diffLines: [DiffLine] = []
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("冲突差异对比")
                    .font(.headline)
                Spacer()
                Button("关闭") { dismiss() }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(nsColor: .windowBackgroundColor))

            Divider()

            if isLoading {
                ProgressView("加载远程版本...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // 差异视图
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // 图例
                        HStack(spacing: 16) {
                            Label("本地版本", systemImage: "doc.fill")
                                .foregroundStyle(.blue)
                            Label("远程版本", systemImage: "doc.fill")
                                .foregroundStyle(.green)
                            Label("差异行", systemImage: "arrow.left.arrow.right")
                                .foregroundStyle(.orange)
                        }
                        .font(.caption)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)

                        Divider()

                        // 并排对比
                        HStack(alignment: .top, spacing: 0) {
                            // 本地
                            VStack(alignment: .leading, spacing: 0) {
                                Text("本地版本")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.blue.opacity(0.08))

                                ScrollView {
                                    Text(localText)
                                        .font(.system(.body, design: .monospaced))
                                        .textSelection(.enabled)
                                        .padding(12)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }

                            Divider()

                            // 远程
                            VStack(alignment: .leading, spacing: 0) {
                                Text("远程版本")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.green.opacity(0.08))

                                ScrollView {
                                    Text(remoteText)
                                        .font(.system(.body, design: .monospaced))
                                        .textSelection(.enabled)
                                        .padding(12)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }

                Divider()

                // 统一差异视图
                if !diffLines.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("差异摘要")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)

                        ScrollView {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(diffLines.enumerated()), id: \.offset) { _, line in
                                    HStack(spacing: 4) {
                                        Text(line.prefix)
                                            .font(.system(.caption, design: .monospaced))
                                            .foregroundStyle(line.prefixColor)
                                            .frame(width: 16, alignment: .center)
                                        Text(line.text)
                                            .font(.system(.caption, design: .monospaced))
                                            .foregroundStyle(colorScheme == .dark ? .white : .black)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .padding(.vertical, 1)
                                    .padding(.horizontal, 12)
                                    .background(line.backgroundColor(for: colorScheme))
                                }
                            }
                            .padding(.vertical, 8)
                        }
                        .frame(maxHeight: 200)
                    }
                }

                Divider()

                // 操作按钮
                HStack {
                    Spacer()
                    Button("保留本地版本") {
                        resolveConflict(keepLocal: true)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.regular)

                    Button("采用远程版本") {
                        resolveConflict(keepLocal: false)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
        .frame(width: 700, height: 550)
        .onAppear {
            loadRemoteSnapshot()
            localText = localContent.string
            computeDiff()
        }
    }

    private func loadRemoteSnapshot() {
        guard let context = PersistenceController.shared.modelContainer?.mainContext else {
            isLoading = false
            return
        }
        do {
            if let snapshot = try BlockDocumentNoteVersionStore.conflictRemoteSnapshot(for: noteID, context: context) {
                // 从 snapshot 的 blocks 中提取纯文本
                var lines: [String] = []
                for block in snapshot.document.blocks {
                    if let inlineTexts = block.text {
                        lines.append(inlineTexts.map { $0.text }.joined())
                    } else {
                        lines.append("")
                    }
                }
                remoteText = lines.joined(separator: "\n")
            }
        } catch {
            Logger.shared.log(.app, .warn, "Failed to load conflict snapshot: \(error)")
        }
        isLoading = false
    }

    private func computeDiff() {
        let localLines = localText.components(separatedBy: "\n")
        let remoteLines = remoteText.components(separatedBy: "\n")
        diffLines = simpleDiff(local: localLines, remote: remoteLines)
    }

    private func simpleDiff(local: [String], remote: [String]) -> [DiffLine] {
        var result: [DiffLine] = []
        let maxLen = max(local.count, remote.count)
        for i in 0..<maxLen {
            let l = i < local.count ? local[i] : nil
            let r = i < remote.count ? remote[i] : nil
            if l == r {
                result.append(DiffLine(prefix: " ", text: l ?? "", kind: .same))
            } else {
                if let l { result.append(DiffLine(prefix: "−", text: l, kind: .removed)) }
                if let r { result.append(DiffLine(prefix: "+", text: r, kind: .added)) }
            }
        }
        return result
    }

    private func resolveConflict(keepLocal: Bool) {
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }
        do {
            if keepLocal {
                try BlockDocumentNoteVersionStore.resolveConflictKeepLocal(noteID: noteID, context: context)
            } else {
                try BlockDocumentNoteVersionStore.resolveConflictKeepRemote(noteID: noteID, context: context)
                store.fetchData()
            }
        } catch {
            Logger.shared.log(.app, .warn, "Failed to resolve conflict: \(error)")
        }
        dismiss()
    }
}

// MARK: - Diff 数据模型

private enum DiffKind {
    case same, added, removed
}

private struct DiffLine {
    let prefix: String
    let text: String
    let kind: DiffKind

    var prefixColor: Color {
        switch kind {
        case .same: return .secondary
        case .added: return .green
        case .removed: return .red
        }
    }

    func backgroundColor(for scheme: ColorScheme) -> Color {
        switch kind {
        case .same: return .clear
        case .added: return scheme == .dark ? .green.opacity(0.15) : .green.opacity(0.1)
        case .removed: return scheme == .dark ? .red.opacity(0.15) : .red.opacity(0.1)
        }
    }
}
