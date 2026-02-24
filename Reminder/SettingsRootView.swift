import SwiftUI
import SwiftData

/// 设置界面根视图：展示/修改数据存储路径
struct SettingsRootView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore

    @State private var isChoosingDirectory = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("数据存储位置")
                .font(.title2)
                .bold()

            VStack(alignment: .leading, spacing: 8) {
                Text("当前路径：")
                    .font(.headline)

                if let url = storage.baseDirectoryURL {
                    Text(url.path)
                        .font(.system(size: 12, weight: .regular, design: .monospaced))
                        .lineLimit(3)
                        .textSelection(.enabled)
                } else {
                    Text("尚未配置，请选择一个文件夹作为数据存储位置。").foregroundColor(.secondary)
                }
            }

            HStack(spacing: 12) {
                Button {
                    chooseDirectory()
                } label: {
                    Text(storage.isConfigured ? "更改路径" : "选择路径")
                }

                if storage.isConfigured {
                    Button("在 Finder 中显示") {
                        if let url = storage.baseDirectoryURL {
                            NSWorkspace.shared.activateFileViewerSelecting([url])
                        }
                    }
                }
            }

            if let error = errorMessage {
                Text(error)
                    .foregroundColor(.red)
                    .font(.footnote)
            }

            Spacer()
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 320)
    }

    private func chooseDirectory() {
        errorMessage = nil
        isChoosingDirectory = true

        Task { @MainActor in
            do {
                try await storage.promptUserToChooseBaseDirectory()
                // 重新配置 SwiftData 容器
                try persistence.configureIfPossible()

                // 关键：切换路径后必须把新的 ModelContext 注入 NoteStore，否则无法读取/写入数据
                if let container = persistence.modelContainer {
                    store.setContext(container.mainContext)
                } else {
                    // 配置失败时清空展示，避免误导
                    store.notes = []
                    store.folders = []
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isChoosingDirectory = false
        }
    }
}
