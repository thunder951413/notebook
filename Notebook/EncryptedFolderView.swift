import SwiftUI

/// 应用内锁定文件夹管理器。
/// 兼容性说明：历史类型名和 UserDefaults key 保持不变，避免破坏既有分类数据。
/// 此功能只提供应用界面内的访问控制，不对数据库或附件执行磁盘加密。
class EncryptedFolderManager {
    static let shared = EncryptedFolderManager()
    
    /// 锁定文件夹的显示名称
    static let folderName = "🔒 锁定"
    
    /// UserDefaults key for encrypted note IDs
    private let encryptedNoteIDsKey = "encrypted_note_ids"
    /// UserDefaults key for note ID to encrypted folder ID mapping
    private let noteToEncryptedFolderKey = "note_to_encrypted_folder"
    
    private init() {
        // 迁移旧数据：将 folderID 以 "ENCRYPTED_" 开头的笔记转换为新的存储方式
        migrateOldEncryptedNotes()
    }
    
    /// 迁移旧格式的加密笔记
    private func migrateOldEncryptedNotes() {
        // 检查是否已迁移
        if NotebookDefaults.shared.bool(forKey: "encrypted_notes_migrated") {
            return
        }
        
        // 标记为已迁移
        NotebookDefaults.shared.set(true, forKey: "encrypted_notes_migrated")
    }
    
    /// 检查笔记是否在加密文件夹中
    func isEncrypted(note: Note) -> Bool {
        let encryptedIDs = getEncryptedNoteIDs()
        return encryptedIDs.contains(note.id.uuidString)
    }
    
    /// 获取所有加密笔记的ID集合
    private func getEncryptedNoteIDs() -> Set<String> {
        let ids = NotebookDefaults.shared.stringArray(forKey: encryptedNoteIDsKey) ?? []
        return Set(ids)
    }
    
    /// 保存加密笔记ID
    private func saveEncryptedNoteID(_ noteID: String) {
        var ids = getEncryptedNoteIDs()
        ids.insert(noteID)
        NotebookDefaults.shared.set(Array(ids), forKey: encryptedNoteIDsKey)
    }
    
    /// 移除加密笔记ID
    private func removeEncryptedNoteID(_ noteID: String) {
        var ids = getEncryptedNoteIDs()
        ids.remove(noteID)
        NotebookDefaults.shared.set(Array(ids), forKey: encryptedNoteIDsKey)
    }
    
    /// 获取笔记所属的加密文件夹ID
    func getEncryptedFolderID(for note: Note) -> UUID? {
        guard isEncrypted(note: note) else { return nil }
        
        let mapping = NotebookDefaults.shared.dictionary(forKey: noteToEncryptedFolderKey) as? [String: String] ?? [:]
        guard let folderIDString = mapping[note.id.uuidString] else { return nil }
        return UUID(uuidString: folderIDString)
    }
    
    /// 保存笔记到加密文件夹的映射
    private func saveNoteToEncryptedFolder(noteID: String, folderID: String) {
        var mapping = NotebookDefaults.shared.dictionary(forKey: noteToEncryptedFolderKey) as? [String: String] ?? [:]
        mapping[noteID] = folderID
        NotebookDefaults.shared.set(mapping, forKey: noteToEncryptedFolderKey)
    }
    
    /// 将笔记移入加密文件夹
    func encryptNote(_ note: inout Note, to encryptedFolderID: UUID? = nil) {
        // 保存笔记ID到加密列表
        saveEncryptedNoteID(note.id.uuidString)
        
        if let folderID = encryptedFolderID {
            note.folderID = folderID
            note.folder = "🔒 " + getEncryptedFolderName(id: folderID)
            // 保存映射关系
            saveNoteToEncryptedFolder(noteID: note.id.uuidString, folderID: folderID.uuidString)
        } else {
            // 默认放入第一个加密文件夹或创建一个默认的
            note.folder = "🔒 锁定笔记"
        }
        // 清空标签，加密笔记不显示在标签中
        note.tagIDs = []
    }
    
    /// 将笔记移出加密文件夹
    func decryptNote(_ note: inout Note, to folder: Folder? = nil) {
        // 从加密列表中移除
        removeEncryptedNoteID(note.id.uuidString)
        
        // 清除映射关系
        var mapping = NotebookDefaults.shared.dictionary(forKey: noteToEncryptedFolderKey) as? [String: String] ?? [:]
        mapping.removeValue(forKey: note.id.uuidString)
        NotebookDefaults.shared.set(mapping, forKey: noteToEncryptedFolderKey)
        
        if let folder = folder {
            note.folderID = folder.id
            note.folder = folder.name
        } else {
            note.folderID = nil
            note.folder = "未分类"
        }
    }
    
    /// 获取加密文件夹名称（从存储中获取）
    private func getEncryptedFolderName(id: UUID) -> String {
        // 从 UserDefaults 或其他存储中获取文件夹名称
        let key = "encrypted_folder_name_\(id.uuidString)"
        return NotebookDefaults.shared.string(forKey: key) ?? "锁定笔记"
    }
    
    // MARK: - Export/Import
    
    /// 导出加密相关数据
    /// - Returns: 包含加密笔记ID列表和映射关系的字典
    func exportEncryptedData() -> [String: Any] {
        let encryptedIDs = Array(getEncryptedNoteIDs())
        let mapping = NotebookDefaults.shared.dictionary(forKey: noteToEncryptedFolderKey) as? [String: String] ?? [:]
        
        return [
            "encryptedNoteIDs": encryptedIDs,
            "noteToFolderMapping": mapping
        ]
    }
    
    /// 导入加密相关数据
    /// - Parameter data: 包含加密笔记ID列表和映射关系的字典
    func importEncryptedData(_ data: [String: Any]) {
        // 导入加密笔记ID列表
        if let encryptedIDs = data["encryptedNoteIDs"] as? [String] {
            NotebookDefaults.shared.set(encryptedIDs, forKey: encryptedNoteIDsKey)
        }
        
        // 导入映射关系
        if let mapping = data["noteToFolderMapping"] as? [String: String] {
            NotebookDefaults.shared.set(mapping, forKey: noteToEncryptedFolderKey)
        }
    }
    
    /// 清除所有加密数据（用于重置）
    func clearAllEncryptedData() {
        NotebookDefaults.shared.removeObject(forKey: encryptedNoteIDsKey)
        NotebookDefaults.shared.removeObject(forKey: noteToEncryptedFolderKey)
    }
}

/// 锁定文件夹视图 - 需要密码验证后才能在应用内查看内容
struct EncryptedFolderView: View {
    @EnvironmentObject private var store: NoteStore
    @EnvironmentObject private var themeManager: ThemeManager
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    
    @Binding var selectedFolder: String
    @Binding var selectedTagID: UUID?
    @Binding var selection: Note.ID?
    
    @State private var password = ""
    @State private var showPassword = false
    @State private var isUnlocked = false
    @State private var errorMessage: String?
    @State private var shakeAnimation = false
    
    // 加密文件夹的固定名称
    static let folderName = EncryptedFolderManager.folderName
    
    var body: some View {
        VStack(spacing: 0) {
            if isUnlocked {
                // 已解锁，显示笔记列表
                unlockedContent
            } else {
                // 未解锁，显示密码输入界面
                passwordLockView
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colorScheme == .dark ? Color.black.opacity(0.2) : Color(nsColor: .controlBackgroundColor))
    }
    
    // MARK: - 密码锁定视图
    private var passwordLockView: some View {
        VStack(spacing: 24) {
            Spacer()
            
            // 锁图标
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 64))
                .foregroundStyle(themeManager.accentColor)
            
            // 标题
            Text("锁定文件夹")
                .font(.title2)
                .bold()
            
            Text("请输入密码以查看锁定内容")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("仅限制应用内访问，不加密磁盘上的数据库与附件")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            
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
                
                // 解锁按钮
                Button {
                    verifyPassword()
                } label: {
                    Text("解锁")
                        .frame(width: 200)
                }
                .buttonStyle(.borderedProminent)
                .tint(themeManager.accentColor)
                .disabled(password.isEmpty)
                
                // 取消按钮
                Button {
                    dismiss()
                } label: {
                    Text("取消")
                        .frame(width: 200)
                }
                .buttonStyle(.bordered)
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
    }
    
    // MARK: - 解锁后的内容视图
    private var unlockedContent: some View {
        VStack(spacing: 0) {
            // 顶部栏
            HStack {
                Image(systemName: "lock.open.fill")
                    .foregroundStyle(themeManager.accentColor)
                Text("🔒 锁定文件夹")
                    .font(.headline)
                Spacer()
                
                // 笔记数量
                let encryptedNotes = store.notes.filter { EncryptedFolderManager.shared.isEncrypted(note: $0) }
                Text("\(encryptedNotes.count) 条笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                
                // 锁定按钮
                Button {
                    withAnimation {
                        isUnlocked = false
                        password = ""
                    }
                } label: {
                    Image(systemName: "lock")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .help("重新锁定")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(colorScheme == .dark ? Color.black.opacity(0.3) : Color.white.opacity(0.5))
            
            Divider()
            
            // 笔记列表
            let encryptedNotes = store.notes.filter { EncryptedFolderManager.shared.isEncrypted(note: $0) }
            if encryptedNotes.isEmpty {
                VStack(spacing: 16) {
                    Spacer()
                    Image(systemName: "doc.text")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary.opacity(0.5))
                    Text("暂无锁定笔记")
                        .foregroundStyle(.secondary)
                    Text("将笔记移入此处可限制应用内访问")
                        .font(.caption)
                        .foregroundStyle(.secondary.opacity(0.7))
                    Spacer()
                }
            } else {
                List(selection: $selection) {
                    Section {
                        ForEach(encryptedNotes) { note in
                            NoteRowView(note: note, isSelected: selection == note.id)
                                .tag(note.id)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    selection = note.id
                                }
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
    }
    
    // MARK: - 验证密码
    private func verifyPassword() {
        guard PasswordManager.shared.hasPassword else {
            errorMessage = "尚未设置密码"
            triggerShake()
            return
        }
        
        if PasswordManager.shared.verifyPassword(password) {
            withAnimation {
                isUnlocked = true
                errorMessage = nil
                selectedFolder = Self.folderName
                selectedTagID = nil
            }
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

/// 加密文件夹行视图 - 在侧边栏显示
struct EncryptedFolderRow: View {
    @EnvironmentObject private var themeManager: ThemeManager
    @Binding var selectedFolder: String
    @Binding var selectedTagID: UUID?
    @Binding var selection: Note.ID?
    @Binding var showingEncryptedFolder: Bool
    
    var isSelected: Bool {
        selectedFolder == EncryptedFolderView.folderName && selectedTagID == nil
    }
    
    var body: some View {
        HStack {
            Image(systemName: "lock.shield")
                .foregroundStyle(isSelected ? .white : .red)
            Text("🔒 锁定")
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(isSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            // 点击时显示加密文件夹视图（需要密码验证）
            showingEncryptedFolder = true
        }
        .padding(.horizontal, 8)
    }
}
