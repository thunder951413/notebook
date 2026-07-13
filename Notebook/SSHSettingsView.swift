import SwiftUI

/// SSH 设置视图
struct SSHSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    
    @State private var host: String = ""
    @State private var port: String = "22"
    @State private var username: String = ""
    @State private var password: String = ""
    @State private var repositoryPath: String = "~/notebook_backup"
    
    @State private var isTesting = false
    @State private var testResult: TestResult?
    
    enum TestResult: Equatable {
        case success
        case failure(String)
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // 标题
            HStack {
                Text("SSH 服务器配置")
                    .font(.title2)
                    .bold()
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            
            Divider()
            
            // 服务器地址
            VStack(alignment: .leading, spacing: 6) {
                Text("服务器地址")
                    .font(.headline)
                TextField("例如: 192.168.1.100 或 nas.example.com", text: $host)
                    .textFieldStyle(.roundedBorder)
            }
            
            // 端口
            VStack(alignment: .leading, spacing: 6) {
                Text("端口")
                    .font(.headline)
                TextField("22", text: $port)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
            }
            
            // 用户名
            VStack(alignment: .leading, spacing: 6) {
                Text("用户名")
                    .font(.headline)
                TextField("例如: admin", text: $username)
                    .textFieldStyle(.roundedBorder)
            }
            
            // 密码
            VStack(alignment: .leading, spacing: 6) {
                Text("密码")
                    .font(.headline)
                SecureField("输入密码", text: $password)
                    .textFieldStyle(.roundedBorder)
            }
            
            // 仓库路径
            VStack(alignment: .leading, spacing: 6) {
                Text("仓库路径")
                    .font(.headline)
                TextField("~/notebook_backup", text: $repositoryPath)
                    .textFieldStyle(.roundedBorder)
                Text("NAS 上用于存储备份的目录路径")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            
            // 测试结果
            if let result = testResult {
                HStack {
                    Image(systemName: result == .success ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result == .success ? .green : .red)
                    switch result {
                    case .success:
                        Text("连接成功！配置已保存")
                            .foregroundStyle(.green)
                    case .failure(let message):
                        Text(message)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.vertical, 8)
            }
            
            Spacer()
            
            // 按钮
            HStack {
                Button {
                    dismiss()
                } label: {
                    Text("取消")
                }
                
                Spacer()

                MobileSyncQRCodeButton()
                
                Button {
                    testAndSaveConnection()
                } label: {
                    if isTesting {
                        HStack(spacing: 6) {
                            ProgressView()
                                .scaleEffect(0.8)
                            Text("测试中...")
                        }
                    } else {
                        Text("测试并保存")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isTesting || !isFormValid)
            }
        }
        .padding(24)
        .frame(width: 560, height: 520)
        .onAppear {
            loadExistingConfig()
        }
    }
    
    private var isFormValid: Bool {
        !host.isEmpty && !username.isEmpty && !password.isEmpty
    }
    
    private func loadExistingConfig() {
        let config = SSHConfigManager.shared.config
        host = config.host
        port = String(config.port)
        username = config.username
        password = SSHConfigManager.shared.loadPassword() ?? config.password
        repositoryPath = config.repositoryPath
    }
    
    private func testAndSaveConnection() {
        let normalizedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRepositoryPath = repositoryPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPort = port.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPassword = password.trimmingCharacters(in: CharacterSet(charactersIn: "\r\n"))

        guard let portNumber = Int(normalizedPort) else {
            testResult = .failure("端口号无效")
            return
        }
        
        isTesting = true
        testResult = nil
        
        Task {
            do {
                try await testSSHConnection(
                    host: normalizedHost,
                    port: portNumber,
                    username: normalizedUsername,
                    password: normalizedPassword
                )
                
                // 保存配置
                let config = SSHConfig(
                    host: normalizedHost,
                    port: portNumber,
                    username: normalizedUsername,
                    password: normalizedPassword,
                    repositoryPath: normalizedRepositoryPath
                )
                SSHConfigManager.shared.config = config
                
                await MainActor.run {
                    testResult = .success
                    isTesting = false
                    // 延迟关闭弹窗，让用户看到成功消息
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        dismiss()
                    }
                }
            } catch {
                await MainActor.run {
                    testResult = .failure(error.localizedDescription)
                    isTesting = false
                }
            }
        }
    }

    /// 测试 SSH 连接
    private func testSSHConnection(host: String, port: Int, username: String, password: String) async throws {
        let config = SSHConfig(
            host: host,
            port: port,
            username: username,
            password: password,
            repositoryPath: ""
        )
        
        // 使用 expect 脚本进行密码认证测试
        try await SSHSyncManager.shared.testConnectionWithPassword(config: config)
    }
}

#Preview {
    SSHSettingsView()
}
