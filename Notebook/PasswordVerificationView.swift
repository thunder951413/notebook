import SwiftUI

/// 密码验证视图 - 用于验证密码后展开加密文件夹
struct PasswordVerificationView: View {
    @EnvironmentObject private var themeManager: ThemeManager
    @Environment(\.dismiss) private var dismiss
    
    @Binding var isUnlocked: Bool
    @Binding var isExpanded: Bool
    var onUnlock: (() -> Void)? = nil
    
    @State private var password = ""
    @State private var showPassword = false
    @State private var errorMessage: String?
    @State private var shakeAnimation = false
    
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            
            // 锁图标
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 48))
                .foregroundStyle(themeManager.accentColor)
            
            // 标题
            Text("验证密码")
                .font(.title3)
                .bold()
            
            Text("请输入密码以查看加密内容")
                .font(.caption)
                .foregroundStyle(.secondary)
            
            // 密码输入框
            VStack(spacing: 12) {
                HStack {
                    if showPassword {
                        TextField("密码", text: $password)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        SecureField("密码", text: $password)
                            .textFieldStyle(.roundedBorder)
                    }
                    
                    Button {
                        showPassword.toggle()
                    } label: {
                        Image(systemName: showPassword ? "eye.slash" : "eye")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .frame(width: 24)
                }
                .frame(width: 200)
                .offset(x: shakeAnimation ? -10 : 0)
                .animation(shakeAnimation ? .easeInOut(duration: 0.1).repeatCount(3) : .default, value: shakeAnimation)
                
                // 错误信息
                if let errorMessage {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.caption)
                        Text(errorMessage)
                            .font(.caption)
                    }
                    .foregroundColor(.red)
                }
                
                // 按钮组
                HStack(spacing: 12) {
                    Button {
                        dismiss()
                    } label: {
                        Text("取消")
                            .frame(width: 80)
                    }
                    .buttonStyle(.bordered)
                    
                    Button {
                        verifyPassword()
                    } label: {
                        Text("解锁")
                            .frame(width: 80)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(themeManager.accentColor)
                    .disabled(password.isEmpty)
                }
                .padding(.top, 8)
            }
            
            Spacer()
            
            // 提示信息
            if !PasswordManager.shared.hasPassword {
                Text("尚未设置密码，请先在设置中设置密码")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
        }
        .padding()
        .frame(width: 400, height: 300)
    }
    
    // MARK: - 验证密码
    private func verifyPassword() {
        guard PasswordManager.shared.hasPassword else {
            errorMessage = "尚未设置密码"
            triggerShake()
            return
        }
        
        if PasswordManager.shared.verifyPassword(password) {
            isUnlocked = true
            isExpanded = true
            errorMessage = nil
            onUnlock?()
            dismiss()
        } else {
            errorMessage = "密码错误"
            triggerShake()
        }
    }
    
    private func triggerShake() {
        shakeAnimation = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            shakeAnimation = false
        }
    }
}

#Preview {
    PasswordVerificationView(isUnlocked: .constant(false), isExpanded: .constant(false), onUnlock: nil)
        .environmentObject(ThemeManager.shared)
}
