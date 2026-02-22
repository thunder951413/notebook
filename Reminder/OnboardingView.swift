import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController

    @State private var isChoosing = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("欢迎")
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("首次使用需要选择一个保存目录。应用会在该目录下创建：")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("• ReminderData/Database（笔记数据）")
                Text("• ReminderData/Attachments（图片/音频附件）")
            }
            .font(.body)

            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
            }

            HStack {
                Button {
                    Task { await chooseDirectory() }
                } label: {
                    Text(isChoosing ? "正在打开选择器…" : "选择保存目录")
                        .fontWeight(.semibold)
                }
                .disabled(isChoosing)

                Spacer()
            }

            Text("提示：后续可在设置中更换目录（稍后实现）。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(24)
        .frame(minWidth: 520, minHeight: 360)
    }

    private func chooseDirectory() async {
        isChoosing = true
        defer { isChoosing = false }

        do {
            try await storage.promptUserToChooseBaseDirectory()
            try persistence.configureIfPossible()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

#Preview {
    OnboardingView()
        .environmentObject(StorageLocationManager.shared)
        .environmentObject(PersistenceController.shared)
}
