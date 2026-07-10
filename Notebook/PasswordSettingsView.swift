import SwiftUI

/// 密码设置视图
struct PasswordSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var passwordManager = PasswordManager.shared
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var showCurrentPassword = false
    @State private var showNewPassword = false
    @State private var showConfirmPassword = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showClearConfirmation = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // 标题
            HStack {
                HStack(spacing: 10) {
                    Image(systemName: "lock.shield")
                        .font(.title2)
                        .foregroundColor(.accentColor)
                    
                    Text("应用密码")
                        .font(.title2)
                        .bold()
                }
                
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
            
            // 说明文字
            Text(passwordManager.hasPassword
                 ? "已设置应用内访问密码。您可以修改或清除密码。"
                 : "设置密码可限制应用内访问，但不会加密磁盘上的笔记数据库与附件。")
                .font(.caption)
                .foregroundColor(.secondary)
            
            if passwordManager.hasPassword {
                // 修改密码模式
                VStack(alignment: .leading, spacing: 12) {
                    // 当前密码
                    passwordField(
                        title: "当前密码",
                        text: $currentPassword,
                        isVisible: $showCurrentPassword
                    )
                    
                    Divider()
                        .padding(.vertical, 4)
                    
                    // 新密码
                    passwordField(
                        title: "新密码",
                        text: $newPassword,
                        isVisible: $showNewPassword
                    )
                    
                    // 确认新密码
                    passwordField(
                        title: "确认新密码",
                        text: $confirmPassword,
                        isVisible: $showConfirmPassword
                    )
                    
                    // 按钮组
                    HStack(spacing: 12) {
                        Button("取消") {
                            dismiss()
                        }

                        Button(role: .destructive) {
                            showClearConfirmation = true
                        } label: {
                            Text("清除密码")
                        }
                        .buttonStyle(.bordered)
                        
                        Spacer()
                        
                        Button {
                            changePassword()
                        } label: {
                            Text("修改密码")
                                .frame(width: 100)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(newPassword.isEmpty || currentPassword.isEmpty)
                    }
                    .padding(.top, 8)
                }
            } else {
                // 设置新密码模式
                VStack(alignment: .leading, spacing: 12) {
                    // 新密码
                    passwordField(
                        title: "设置密码",
                        text: $newPassword,
                        isVisible: $showNewPassword
                    )
                    
                    // 确认密码
                    passwordField(
                        title: "确认密码",
                        text: $confirmPassword,
                        isVisible: $showConfirmPassword
                    )
                    
                    // 设置按钮
                    HStack {
                        Button("取消") {
                            dismiss()
                        }

                        Spacer()
                        
                        Button {
                            setPassword()
                        } label: {
                            Text("设置密码")
                                .frame(width: 100)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(newPassword.isEmpty)
                    }
                    .padding(.top, 8)
                }
            }
            
            // 消息显示
            if let errorMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundColor(.red)
                    Text(errorMessage)
                        .foregroundColor(.red)
                        .font(.caption)
                }
                .padding(.top, 4)
            }
            
            if let successMessage {
                HStack {
                    Image(systemName: "checkmark.circle")
                        .foregroundColor(.green)
                    Text(successMessage)
                        .foregroundColor(.green)
                        .font(.caption)
                }
                .padding(.top, 4)
            }
            
            Spacer()
        }
        .padding(24)
        .frame(width: 420, height: 360)
        .alert("确认清除密码", isPresented: $showClearConfirmation) {
            Button("取消", role: .cancel) {}
            Button("确认清除", role: .destructive) {
                clearPassword()
            }
        } message: {
            Text("清除后将取消应用内访问限制。磁盘数据本来就未由此密码加密。确定要清除吗？")
        }
    }
    
    // MARK: - 密码输入框组件
    private func passwordField(
        title: String,
        text: Binding<String>,
        isVisible: Binding<Bool>
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            
            HStack {
                if isVisible.wrappedValue {
                    TextField(title, text: text)
                        .textFieldStyle(.roundedBorder)
                } else {
                    SecureField(title, text: text)
                        .textFieldStyle(.roundedBorder)
                }
                
                Button {
                    isVisible.wrappedValue.toggle()
                } label: {
                    Image(systemName: isVisible.wrappedValue ? "eye.slash" : "eye")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 24)
            }
        }
    }
    
    // MARK: - 操作
    
    private func setPassword() {
        // 验证密码
        guard newPassword == confirmPassword else {
            showError("两次输入的密码不一致")
            return
        }
        
        guard newPassword.count >= 4 else {
            showError("密码长度至少为4位")
            return
        }
        
        // 设置密码
        if PasswordManager.shared.setPassword(newPassword) {
            showSuccess("密码设置成功")
            clearFields()
        } else {
            showError("密码设置失败，请重试")
        }
    }
    
    private func changePassword() {
        // 验证新密码
        guard newPassword == confirmPassword else {
            showError("两次输入的新密码不一致")
            return
        }
        
        guard newPassword.count >= 4 else {
            showError("新密码长度至少为4位")
            return
        }
        
        guard newPassword != currentPassword else {
            showError("新密码不能与当前密码相同")
            return
        }
        
        // 修改密码
        if PasswordManager.shared.changePassword(oldPassword: currentPassword, newPassword: newPassword) {
            showSuccess("密码修改成功")
            clearFields()
        } else {
            showError("当前密码错误，请重新输入")
        }
    }
    
    private func clearPassword() {
        if PasswordManager.shared.clearPassword(currentPassword: currentPassword) {
            showSuccess("密码已清除")
            clearFields()
        } else {
            showError("当前密码错误，无法清除")
        }
    }
    
    private func clearFields() {
        currentPassword = ""
        newPassword = ""
        confirmPassword = ""
        showCurrentPassword = false
        showNewPassword = false
        showConfirmPassword = false
    }
    
    private func showError(_ message: String) {
        errorMessage = message
        successMessage = nil
        
        // 3秒后清除错误
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if self.errorMessage == message {
                self.errorMessage = nil
            }
        }
    }
    
    private func showSuccess(_ message: String) {
        successMessage = message
        errorMessage = nil

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if self.successMessage == message {
                dismiss()
            }
        }
        
        // 3秒后清除成功消息
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if self.successMessage == message {
                self.successMessage = nil
            }
        }
    }
}

#Preview {
    PasswordSettingsView()
}
