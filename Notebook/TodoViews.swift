import SwiftUI

struct TodoListView: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared

    let todos: [TodoItem]
    @Binding var selection: TodoItem.ID?
    let onCreateTodo: () -> Void
    let onToggleComplete: (TodoItem.ID, Bool) -> Void
    let onDeleteRequest: (TodoItem.ID) -> Void

    private var sortedTodos: [TodoItem] {
        todos.sorted { lhs, rhs in
            if lhs.isCompleted != rhs.isCompleted {
                return !lhs.isCompleted
            }
            if lhs.order != rhs.order {
                return lhs.order < rhs.order
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if sortedTodos.isEmpty {
                ContentUnavailableView(
                    l10n("todo.empty.title"),
                    systemImage: "checklist",
                    description: Text(l10n("todo.empty.description"))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $selection) {
                Section {
                    ForEach(sortedTodos) { todo in
                        TodoRowView(
                            todo: todo,
                            isSelected: selection == todo.id,
                            onToggleComplete: {
                                onToggleComplete(todo.id, !todo.isCompleted)
                            }
                        )
                        .tag(todo.id)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selection = todo.id
                        }
                        .contextMenu {
                            Button(l10n(L10nKeys.common.delete)) {
                                onDeleteRequest(todo.id)
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(l10n(L10nKeys.Todo.title))
                        Spacer()
                        Button {
                            onCreateTodo()
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.borderless)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                }
                .listStyle(.plain)
            }
        }
        .frame(minWidth: 240, maxWidth: 320)
        .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
    }
}

private struct TodoRowView: View {
    let todo: TodoItem
    let isSelected: Bool
    let onToggleComplete: () -> Void
    @StateObject private var themeManager = ThemeManager.shared

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onToggleComplete) {
                Image(systemName: todo.isCompleted ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 16, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(isSelected ? .white : (todo.isCompleted ? .secondary : themeManager.accentColor))

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(todo.title.isEmpty ? l10n(L10nKeys.Todo.untitled) : todo.title)
                        .font(.system(size: 14, weight: .medium))
                        .lineLimit(1)
                        .strikethrough(todo.isCompleted)
                    if todo.isImportant {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(isSelected ? .white.opacity(0.85) : .yellow)
                    }
                    if todo.reminderAt != nil {
                        Image(systemName: "bell.fill")
                            .font(.caption2)
                            .foregroundStyle(isSelected ? .white.opacity(0.85) : .orange)
                    }
                }
                if !todo.contentPreview.isEmpty {
                    Text(todo.contentPreview)
                        .font(.system(size: 12))
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    if let dueAt = todo.dueAt {
                        Label(dueAt.formatted(date: .abbreviated, time: .omitted), systemImage: "calendar")
                    }
                    if todo.isCompleted, let completedAt = todo.completedAt {
                        Label(completedAt.formatted(date: .abbreviated, time: .omitted), systemImage: "checkmark")
                    }
                }
                .font(.caption2)
            }
            .foregroundStyle(isSelected ? .white : .primary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(isSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct TodoDetailView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme

    let todo: TodoItem?
    let lists: [TodoList]
    let onOpenNote: (UUID) -> Void

    @State private var title = ""
    @State private var notesText = ""
    @State private var hasDueDate = false
    @State private var dueAt = Date()
    @State private var hasReminder = false
    @State private var reminderAt = Date()
    @State private var recurrenceRule = "none"
    @State private var isImportant = false
    @State private var listID: UUID?
    @State private var linkedNoteIDs: [UUID] = []
    @State private var steps: [TodoStepEntity] = []
    @State private var newStepText = ""
    @State private var loadedTodoID: UUID?
    @State private var isLoadingDraft = false
    @State private var autosaveTask: Task<Void, Never>?

    private var recurrenceOptions: [(String, String)] {
        [
            (l10n(L10nKeys.Note.noRecurrence), "none"),
            (l10n(L10nKeys.Note.daily), "daily"),
            (l10n(L10nKeys.Note.weekly), "weekly"),
            (l10n(L10nKeys.Note.monthly), "monthly")
        ]
    }

    var body: some View {
        Group {
            if let todo {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(spacing: 10) {
                            Button {
                                store.setTodoCompleted(id: todo.id, completed: !todo.isCompleted)
                            } label: {
                                Image(systemName: todo.isCompleted ? "checkmark.circle.fill" : "circle")
                                    .font(.title2)
                            }
                            .buttonStyle(.plain)

                            TextField(l10n(L10nKeys.Todo.titlePlaceholder), text: $title)
                                .font(.title2)
                                .textFieldStyle(.plain)
                                .onSubmit {
                                    saveNow(todoID: todo.id)
                                }

                            Button {
                                isImportant.toggle()
                                save(todoID: todo.id)
                            } label: {
                                Image(systemName: isImportant ? "star.fill" : "star")
                                    .font(.title3)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(isImportant ? .yellow : .secondary)
                        }

                        Divider()

                        VStack(alignment: .leading, spacing: 8) {
                            Text(l10n(L10nKeys.Todo.steps))
                                .font(.headline)
                            ForEach(steps) { step in
                                HStack(spacing: 8) {
                                    Button {
                                        store.updateTodoStep(id: step.id, checked: !step.checked)
                                        reloadSteps(todoID: todo.id)
                                    } label: {
                                        Image(systemName: step.checked ? "checkmark.circle.fill" : "circle")
                                    }
                                    .buttonStyle(.plain)
                                    TextField(l10n(L10nKeys.Todo.steps), text: Binding(
                                        get: { step.text },
                                        set: { store.updateTodoStep(id: step.id, text: $0) }
                                    ))
                                    .textFieldStyle(.plain)
                                    .strikethrough(step.checked)
                                    Button {
                                        store.deleteTodoStep(id: step.id)
                                        reloadSteps(todoID: todo.id)
                                    } label: {
                                        Image(systemName: "trash")
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(.secondary)
                                }
                            }
                            HStack {
                                TextField(l10n(L10nKeys.Todo.newStep), text: $newStepText)
                                    .textFieldStyle(.roundedBorder)
                                Button {
                                    store.addTodoStep(todoID: todo.id, text: newStepText)
                                    newStepText = ""
                                    reloadSteps(todoID: todo.id)
                                } label: {
                                    Image(systemName: "plus")
                                }
                                .disabled(newStepText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text(l10n(L10nKeys.Todo.notes))
                                .font(.headline)
                            TextEditor(text: $notesText)
                                .font(.body)
                                .frame(minHeight: 120)
                                .scrollContentBackground(.hidden)
                                .padding(8)
                                .background(Color(nsColor: .textBackgroundColor).opacity(colorScheme == .dark ? 0.25 : 0.55))
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            Toggle(l10n(L10nKeys.Todo.dueDate), isOn: $hasDueDate)
                            if hasDueDate {
                                DatePicker(l10n(L10nKeys.Todo.due), selection: $dueAt, displayedComponents: [.date])
                            }

                            Toggle(l10n(L10nKeys.Todo.reminder), isOn: $hasReminder)
                            if hasReminder {
                                DatePicker(l10n(L10nKeys.Todo.reminderAt), selection: $reminderAt, displayedComponents: [.date, .hourAndMinute])
                                Picker(l10n(L10nKeys.Todo.recurrence), selection: $recurrenceRule) {
                                    ForEach(recurrenceOptions, id: \.1) { option in
                                        Text(option.0).tag(option.1)
                                    }
                                }
                                .pickerStyle(.segmented)
                            }

                            Picker(l10n(L10nKeys.Todo.list), selection: Binding(
                                get: { listID ?? UUID.nilValue },
                                set: { listID = $0 == UUID.nilValue ? nil : $0 }
                            )) {
                                Text(l10n(L10nKeys.Todo.noList)).tag(UUID.nilValue)
                                ForEach(lists) { list in
                                    Text(list.name).tag(list.id)
                                }
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(l10n(L10nKeys.Todo.linkedNotes))
                                    .font(.headline)
                                Spacer()
                                Menu {
                                    ForEach(store.activeNotes.filter { note in !linkedNoteIDs.contains(note.id) }) { note in
                                        Button(note.title.isEmpty ? l10n(L10nKeys.Note.untitled) : note.title) {
                                            linkedNoteIDs.append(note.id)
                                            save(todoID: todo.id)
                                        }
                                    }
                                } label: {
                                    Image(systemName: "plus")
                                }
                                .menuStyle(.borderlessButton)
                            }

                            if linkedNoteIDs.isEmpty {
                                Text(l10n(L10nKeys.Todo.noLinkedNotes))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(linkedNoteIDs, id: \.self) { noteID in
                                    HStack {
                                        Button(noteTitle(noteID)) {
                                            onOpenNote(noteID)
                                        }
                                        .buttonStyle(.plain)
                                        Spacer()
                                        Button {
                                            linkedNoteIDs.removeAll { $0 == noteID }
                                            save(todoID: todo.id)
                                        } label: {
                                            Image(systemName: "xmark")
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }

                        HStack {
                            Spacer()
                            Button(l10n(L10nKeys.common.save)) {
                                save(todoID: todo.id)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(20)
                }
                .onAppear {
                    load(todo)
                }
                .onChange(of: todo.id) { oldID, newID in
                    saveNow(todoID: oldID)
                    if let refreshedTodo = store.todoItems.first(where: { $0.id == newID }) {
                        load(refreshedTodo)
                    } else {
                        load(todo)
                    }
                }
                .onDisappear {
                    saveNow(todoID: todo.id)
                }
                .onChange(of: title) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: notesText) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: hasDueDate) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: dueAt) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: hasReminder) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: reminderAt) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: recurrenceRule) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: isImportant) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
                .onChange(of: listID) { _, _ in
                    scheduleAutosave(todoID: todo.id)
                }
            } else {
                ContentUnavailableView(l10n(L10nKeys.Todo.select), systemImage: "checklist")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppColors.editorBackground(colorScheme))
    }

    private func load(_ todo: TodoItem) {
        autosaveTask?.cancel()
        isLoadingDraft = true
        loadedTodoID = todo.id
        title = todo.title
        notesText = store.loadTodoNotesText(id: todo.id)
        hasDueDate = todo.dueAt != nil
        dueAt = todo.dueAt ?? Date()
        hasReminder = todo.reminderAt != nil
        reminderAt = todo.reminderAt ?? Date().addingTimeInterval(3600)
        recurrenceRule = todo.recurrenceRule.isEmpty ? "none" : todo.recurrenceRule
        isImportant = todo.isImportant
        listID = todo.folderID
        linkedNoteIDs = todo.linkedNoteIDs
        reloadSteps(todoID: todo.id)
        DispatchQueue.main.async {
            isLoadingDraft = false
        }
    }

    private func scheduleAutosave(todoID: UUID) {
        guard !isLoadingDraft, loadedTodoID == todoID else { return }
        autosaveTask?.cancel()
        autosaveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            save(todoID: todoID)
        }
    }

    private func saveNow(todoID: UUID) {
        autosaveTask?.cancel()
        save(todoID: todoID)
    }

    private func save(todoID: UUID) {
        guard loadedTodoID == todoID else { return }
        let effectiveReminderAt = hasReminder ? reminderAt : nil
        let effectiveRecurrence = hasReminder ? recurrenceRule : "none"
        store.updateTodo(
            id: todoID,
            title: title,
            notesText: notesText,
            dueAt: hasDueDate ? dueAt : nil,
            reminderAt: effectiveReminderAt,
            recurrenceRule: effectiveRecurrence,
            isImportant: isImportant,
            listID: listID,
            linkedNoteIDs: linkedNoteIDs
        )

        if let effectiveReminderAt {
            Task {
                await NotificationManager.shared.schedule(
                    todoID: todoID,
                    title: title.isEmpty ? l10n(L10nKeys.Todo.reminderTitle) : title,
                    body: notesText.trimmingCharacters(in: .whitespacesAndNewlines),
                    reminderAt: effectiveReminderAt,
                    recurrence: effectiveRecurrence
                )
            }
        } else {
            Task { @MainActor in
                NotificationManager.shared.cancel(noteID: todoID)
            }
        }
    }

    private func reloadSteps(todoID: UUID) {
        steps = store.steps(for: todoID)
    }

    private func noteTitle(_ id: UUID) -> String {
        store.activeNotes.first(where: { $0.id == id })?.title ?? l10n(L10nKeys.Todo.deletedNote)
    }
}

private extension UUID {
    static let nilValue = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
}
