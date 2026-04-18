import SwiftUI

/// 关于页面视图
struct AboutView: View {
    var body: some View {
        VStack(spacing: 20) {
            // 应用图标
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 100, height: 100)
                .cornerRadius(16)

            // 应用名称
            Text("Notebook")
                .font(.system(size: 24, weight: .bold))

            // 版本号
            Text(AppVersion.current.displayString)
                .font(.system(size: 14))
                .foregroundColor(.secondary)

            Divider()
                .padding(.horizontal, 40)

            // 作者信息
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("作者:")
                        .foregroundColor(.secondary)
                        .frame(width: 60, alignment: .trailing)
                    Text("Yanyan")
                        .fontWeight(.medium)
                }

                HStack {
                    Text("邮箱:")
                        .foregroundColor(.secondary)
                        .frame(width: 60, alignment: .trailing)
                    Text("thunder951413@gmail.com")
                        .fontWeight(.medium)
                        .textSelection(.enabled)
                }
            }
            .font(.system(size: 13))

            Divider()
                .padding(.horizontal, 40)

            // 项目帮助链接
            Button("在 GitHub 上查看") {
                if let url = AppSettings.shared.githubRepositoryURL {
                    NSWorkspace.shared.open(url)
                }
            }
            .buttonStyle(.link)

            // 版权信息
            Text("© 2025 Yanyan. All rights reserved.")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
        .padding(30)
        .frame(width: 400, height: 320)
    }
}

#Preview {
    AboutView()
}
