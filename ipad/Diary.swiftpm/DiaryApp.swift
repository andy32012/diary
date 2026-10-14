import SwiftUI
import SwiftData

@main
struct DiaryApp: App {
    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                EncryptionGate()
                if showSplash {
                    SplashView()
                        .transition(.scale(scale: 1.3).combined(with: .opacity))
                        .zIndex(1)
                }
            }
            .tint(Theme.pinkDeep)
            .task {
                try? await Task.sleep(for: .seconds(1.6))
                withAnimation(.easeInOut(duration: 0.5)) { showSplash = false }
            }
        }
        .modelContainer(for: [Entry.self, WeightRecord.self])
    }
}

/// Encrypt existing SwiftData rows before exposing diary content to the UI.
private struct EncryptionGate: View {
    @Environment(\.modelContext) private var context
    @Query private var entries: [Entry]
    @Query private var weights: [WeightRecord]
    @State private var isReady = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isReady {
                ContentView()
            } else if let errorMessage {
                VStack(spacing: 16) {
                    Mascot(size: 90)
                    Text("無法安全開啟日記")
                        .font(.system(.title3, design: .rounded, weight: .bold))
                        .foregroundStyle(Theme.ink)
                    Text(errorMessage)
                        .font(.system(.callout, design: .rounded))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                        .multilineTextAlignment(.center)
                    Button("重試") {
                        self.errorMessage = nil
                        migrate()
                    }
                    .buttonStyle(.bouncy)
                }
                .padding(32)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background.ignoresSafeArea())
            } else {
                ProgressView("正在保護日記資料…")
                    .tint(Theme.pinkDeep)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.background.ignoresSafeArea())
            }
        }
        .task {
            if !isReady && errorMessage == nil {
                migrate()
            }
        }
    }

    private func migrate() {
        do {
            _ = try DiaryCrypto.encrypt("")

            for entry in entries {
                if let encryptedBody = entry.encryptedBody {
                    _ = try DiaryCrypto.decrypt(encryptedBody)
                    entry.body = ""
                } else {
                    try entry.encryptBody(entry.body)
                }

                if let encryptedMood = entry.encryptedMood {
                    let text = try DiaryCrypto.decrypt(encryptedMood)
                    guard let value = Int(text), (1...5).contains(value) else {
                        throw DiaryCryptoError.invalidCiphertext
                    }
                    entry.mood = 0
                } else {
                    try entry.encryptMood(entry.mood)
                }
            }

            for record in weights {
                if let encryptedKg = record.encryptedKg {
                    let text = try DiaryCrypto.decrypt(encryptedKg)
                    guard let value = Double(text), value.isFinite else {
                        throw DiaryCryptoError.invalidCiphertext
                    }
                    record.kg = 0
                } else {
                    try record.encryptWeight(record.kg)
                }
            }

            try context.save()
            isReady = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// 開場：吉祥物轉著彈出來打招呼
struct SplashView: View {
    @State private var show = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 24) {
                Mascot(size: 140)
                    .scaleEffect(show ? 1 : 0.2)
                    .rotationEffect(.degrees(show ? 0 : -30))
                Text("今天過得好嗎？")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.ink)
                    .opacity(show ? 1 : 0)
                    .offset(y: show ? 0 : 20)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.5)) { show = true }
        }
    }
}
