import SwiftUI

struct TodoListManagementView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    @State private var showingAddListAlert = false
    @State private var newListName = ""
    @State private var editingList: TodoList?
    @State private var editName = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(l10n(L10nKeys.Todo.listManagement))
                    .font(.title2)
                    .fontWeight(.semibold)
                Spacer()
                Button(l10n(L10nKeys.common.done)) {
                    dismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .padding()

            HStack {
                Button {
                    showingAddListAlert = true
                } label: {
                    Label(l10n(L10nKeys.Todo.newList), systemImage: "plus")
                }

                Spacer()

                Text(l10n(L10nKeys.Folder.dragToSort))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()

            List {
                ForEach(store.todoLists) { list in
                    HStack {
                        Image(systemName: "checklist")
                            .foregroundStyle(ThemeManager.shared.accentColor)

                        Text(list.name)

                        Spacer()

                        Text("\(store.todoItems(in: list.id).count)")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Menu {
                            Button {
                                editingList = list
                                editName = list.name
                            } label: {
                                Label(l10n(L10nKeys.common.rename), systemImage: "pencil")
                            }

                            Divider()

                            Button(role: .destructive) {
                                store.deleteTodoList(id: list.id)
                            } label: {
                                Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(.secondary)
                        }
                        .menuStyle(.borderlessButton)
                    }
                    .padding(.vertical, 4)
                }
                .onMove { fromOffsets, toOffset in
                    store.reorderTodoLists(fromOffsets: fromOffsets, toOffset: toOffset)
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 450)
        .background(AppColors.sidebarBackground(colorScheme))
        .alert(l10n(L10nKeys.Todo.newListTitle), isPresented: $showingAddListAlert) {
            TextField(l10n(L10nKeys.Todo.listName), text: $newListName)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {
                newListName = ""
            }
            Button(l10n(L10nKeys.common.create)) {
                let trimmed = newListName.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    store.addTodoList(name: trimmed)
                    newListName = ""
                }
            }
        } message: {
            Text(l10n(L10nKeys.Todo.listNamePrompt))
        }
        .alert(l10n(L10nKeys.common.rename), isPresented: .constant(editingList != nil)) {
            TextField(l10n(L10nKeys.Todo.listName), text: $editName)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {
                editingList = nil
            }
            Button(l10n(L10nKeys.common.save)) {
                let trimmed = editName.trimmingCharacters(in: .whitespacesAndNewlines)
                if let list = editingList, !trimmed.isEmpty {
                    store.updateTodoList(id: list.id, name: trimmed)
                }
                editingList = nil
            }
        } message: {
            Text(l10n(L10nKeys.common.rename))
        }
    }
}
