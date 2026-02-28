import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController

    @State private var isChoosing = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(l10n(L10nKeys.Onboarding.welcome))
                .font(.largeTitle)
                .fontWeight(.bold)

            Text(l10n(L10nKeys.Onboarding.description))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text(l10n(L10nKeys.Onboarding.databasePath))
                Text(l10n(L10nKeys.Onboarding.attachmentsPath))
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
                    Text(isChoosing ? l10n(L10nKeys.Onboarding.selecting) : l10n(L10nKeys.Onboarding.selectDirectory))
                        .fontWeight(.semibold)
                }
                .disabled(isChoosing)

                Spacer()
            }

            Text(l10n(L10nKeys.Onboarding.tip))
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
