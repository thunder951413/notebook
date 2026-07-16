import SwiftUI

struct NotebookSettingView: View {
    @Binding var note: Note
    @EnvironmentObject private var store: NoteStore
    @Environment(\.dismiss) private var dismiss
    
    @State private var selectedDate: Date
    
    init(note: Binding<Note>) {
        self._note = note
        // 默认显示现有提醒时间，若无则显示 1 小时后
        self._selectedDate = State(initialValue: note.wrappedValue.reminderAt ?? Date().addingTimeInterval(3600))
    }
    
    var body: some View {
        VStack(spacing: 16) {
            Text(l10n(L10nKeys.Note.reminderTitle))
                .font(.headline)
            
            DatePicker(l10n(L10nKeys.Note.reminder), selection: $selectedDate, displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.graphical)
                .labelsHidden()
            
            HStack(spacing: 12) {
                if note.reminderAt != nil {
                    Button(role: .destructive) {
                        clearReminder()
                    } label: {
                        Text(l10n(L10nKeys.Note.clearReminder))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                
                Button {
                    saveReminder()
                } label: {
                    Text(l10n(L10nKeys.Note.setReminder))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppColors.accentYellow)
                .foregroundStyle(.black)
            }
        }
        .padding(16)
        .frame(width: 280)
    }
    
    private func saveReminder() {
        note.reminderAt = selectedDate
        store.updateNote(note)
        
        // 调度通知：标题用笔记标题，正文取前30字
        let body = note.content.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = body.prefix(30) + (body.count > 30 ? "..." : "")
        
        Task {
            await NotificationManager.shared.schedule(
                noteID: note.id,
                title: note.title.isEmpty ? l10n(L10nKeys.Note.reminderTitle) : note.title,
                body: String(preview),
                reminderAt: selectedDate,
                recurrence: note.recurrenceRule
            )
        }
        
        dismiss()
    }
    
    private func clearReminder() {
        note.reminderAt = nil
        store.updateNote(note)
        NotificationManager.shared.cancel(noteID: note.id)
        dismiss()
    }
}
