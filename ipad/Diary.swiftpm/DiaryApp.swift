import SwiftUI
import SwiftData
import UIKit
import Combine

@main
struct DiaryApp: App {
    @UIApplicationDelegateAdaptor(DiaryAppDelegate.self) private var appDelegate
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

/// Third-party keyboards see everything typed and, with full access, can send it elsewhere.
final class DiaryAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, shouldAllowExtensionPointIdentifier extensionPointIdentifier: UIApplication.ExtensionPointIdentifier) -> Bool {
        extensionPointIdentifier != .keyboard
    }
}

/// The content view exists only during an authenticated, foreground, unrecorded session.
private struct EncryptionGate: View {
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @Query private var entries: [Entry]
    @Query private var weights: [WeightRecord]
    @State private var isReady = false
    @State private var setupRequired = false
    @State private var password = ""
    @State private var confirmation = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var notice: String?
    @State private var captured = false
    @State private var lastActivity = Date.now
    @State private var generation = 0
    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if isReady && scenePhase == .active && captured {
                CaptureCover()
            } else if isReady && scenePhase == .active {
                VStack(spacing: 0) {
                    HStack {
                        if let notice {
                            Button { self.notice = nil } label: {
                                Text(notice)
                                    .font(.system(.callout, design: .rounded))
                                    .foregroundStyle(Theme.ink)
                                    .multilineTextAlignment(.leading)
                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.peach))
                            }
                            .buttonStyle(.plain)
                            .padding(.leading, 12)
                        }
                        Spacer()
                        Button("鎖定日記", systemImage: "lock.fill") { lock() }
                            .padding(12)
                    }
                    ContentView()
                }
                .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in lastActivity = .now })
            } else {
                ScrollView {
                    VStack(spacing: 16) {
                        Mascot(size: 90)
                        Text(setupRequired ? "設定日記密碼" : "日記已鎖定")
                            .font(.title2.bold())
                        SecureField("日記密碼", text: $password)
                            .textContentType(setupRequired ? .newPassword : .password)
                        if setupRequired {
                            SecureField("再次輸入密碼", text: $confirmation)
                                .textContentType(.newPassword)
                            Text("至少 12 個字元且不容易被猜到，例如用幾個不相關的詞組成一句好記的話。舊日記會在解鎖後安全遷移。")
                        }
                        Text("沒有密碼復原或重設功能。忘記密碼將無法讀取日記；備份時需同時保留資料庫與加密金鑰檔。")
                        Text("切到背景或閒置 5 分鐘會自動鎖定。")
                        if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                        Button(busy ? "處理中…" : (setupRequired ? "建立密碼並加密" : "解鎖")) { unlock() }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy || password.isEmpty)
                    }
                    .textFieldStyle(.roundedBorder)
                    .padding(32)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
                }
                .background(Theme.background.ignoresSafeArea())
            }
        }
        .task {
            refreshSetup()
            refreshCaptured()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { lock() }
            else { refreshSetup(); refreshCaptured() }
        }
        .onReceive(clock) { now in
            if isReady && now.timeIntervalSince(lastActivity) >= 300 { lock() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
            refreshCaptured()
        }
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidChangeNotification)) { _ in
            if isReady { lastActivity = .now }
        }
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidChangeNotification)) { _ in
            if isReady { lastActivity = .now }
        }
    }

    private func refreshSetup() {
        do { setupRequired = try DiaryCrypto.needsSetup() }
        catch { errorMessage = error.localizedDescription }
    }
    /// Screen recording, AirPlay and mirroring hide the diary until capture stops.
    private func refreshCaptured() {
        captured = UIApplication.shared.connectedScenes.contains { ($0 as? UIWindowScene)?.screen.isCaptured == true }
    }
    private func lock() {
        generation += 1
        // Values are already encrypted by the editors. Flush them before releasing the key.
        if isReady {
            do { try context.save() }
            catch { errorMessage = "儲存失敗：\(error.localizedDescription)；請重新解鎖後重試。" }
        }
        isReady = false
        notice = nil
        password = ""; confirmation = ""
        DiaryCrypto.lock()
    }
    private func unlock() {
        guard !busy, scenePhase == .active else { return }
        if setupRequired {
            // Checked before the expensive key derivation and without counting as a failed attempt.
            if let problem = PasswordPolicy.problem(password) { errorMessage = problem; return }
            if password != confirmation { errorMessage = "兩次輸入的密碼不同，請再確認一次。"; return }
        }
        let attempt = generation
        let secret = password
        let hasLegacyRecords = entries.contains { $0.encryptedBody != nil || $0.encryptedMood != nil }
            || weights.contains { $0.encryptedKg != nil }
        let hasSealedRecords = entries.contains { $0.sealedBody != nil || $0.sealedMood != nil }
            || weights.contains { $0.sealedKg != nil }
        password = ""; confirmation = ""; busy = true; errorMessage = nil
        Task {
            do {
                try await Task.detached(priority: .userInitiated) {
                    try DiaryCrypto.unlock(password: secret, hasLegacyRecords: hasLegacyRecords, hasSealedRecords: hasSealedRecords)
                }.value
                guard attempt == generation, scenePhase == .active else {
                    DiaryCrypto.lock(); busy = false; refreshSetup(); return
                }
                let skipped = try migrate()
                // Keep the old key and pending phase while any older record could not be read.
                if skipped == 0 { try DiaryCrypto.finishMigration() }
                notice = skipped == 0 ? nil : "有 \(skipped) 筆記錄無法解密或驗證，已保留原始資料並顯示為「無法解密」。確認不需要後可以刪除。"
                lastActivity = .now
                isReady = true
            } catch {
                context.rollback()
                DiaryCrypto.lock()
                errorMessage = error.localizedDescription
            }
            busy = false
            refreshSetup()
        }
    }
    /// Seals only records that are not yet bound to their id, field and date, and returns how many could not be read.
    /// One damaged record never blocks unlocking; after the migration completes, unbound records are rejected.
    private func migrate() throws -> Int {
        let pendingEntries = entries.filter(\.needsMigration)
        let pendingWeights = weights.filter(\.needsMigration)
        guard try DiaryCrypto.isMigrationPending() else { return pendingEntries.count + pendingWeights.count }
        var skipped = 0
        var stagedEntries: [(Entry, UUID, Data, Data)] = []
        for entry in pendingEntries {
            do {
                let id = entry.uid ?? UUID()
                let body = try olderValue(entry.sealedBody, .entryBody, entry.uid, entry.createdAt, entry.encryptedBody) ?? entry.body
                let moodText = try olderValue(entry.sealedMood, .entryMood, entry.uid, entry.createdAt, entry.encryptedMood) ?? String(entry.mood)
                guard let mood = Int(moodText), (1...5).contains(mood) else { throw DiaryCryptoError.invalidCiphertext }
                let sealedBody = try DiaryCrypto.seal(body, field: .entryBody, id: id, date: entry.createdAt)
                let sealedMood = try DiaryCrypto.seal(String(mood), field: .entryMood, id: id, date: entry.createdAt)
                // Verify before the older columns are cleared.
                guard try DiaryCrypto.open(sealedBody, field: .entryBody, id: id, date: entry.createdAt) == body,
                      try DiaryCrypto.open(sealedMood, field: .entryMood, id: id, date: entry.createdAt) == String(mood)
                else { throw DiaryCryptoError.invalidCiphertext }
                stagedEntries.append((entry, id, sealedBody, sealedMood))
            } catch DiaryCryptoError.locked {
                throw DiaryCryptoError.locked
            } catch {
                skipped += 1
            }
        }
        var stagedWeights: [(WeightRecord, UUID, Data)] = []
        for record in pendingWeights {
            do {
                let id = record.uid ?? UUID()
                let text = try olderValue(record.sealedKg, .weightKg, record.uid, record.date, record.encryptedKg) ?? String(record.kg)
                guard let value = Double(text), value.isFinite, (20...300).contains(value) else { throw DiaryCryptoError.invalidCiphertext }
                let sealed = try DiaryCrypto.seal(String(value), field: .weightKg, id: id, date: record.date)
                guard try DiaryCrypto.open(sealed, field: .weightKg, id: id, date: record.date) == String(value) else { throw DiaryCryptoError.invalidCiphertext }
                stagedWeights.append((record, id, sealed))
            } catch DiaryCryptoError.locked {
                throw DiaryCryptoError.locked
            } catch {
                skipped += 1
            }
        }
        guard !stagedEntries.isEmpty || !stagedWeights.isEmpty else { return skipped }
        let autosave = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = autosave }
        do {
            for (entry, id, body, mood) in stagedEntries {
                entry.uid = id; entry.sealedBody = body; entry.sealedMood = mood
                entry.body = ""; entry.mood = 0; entry.encryptedBody = nil; entry.encryptedMood = nil
            }
            for (record, id, kg) in stagedWeights {
                record.uid = id; record.sealedKg = kg
                record.kg = 0; record.encryptedKg = nil
            }
            try context.save()
        } catch { context.rollback(); throw error }
        return skipped
    }
    /// An existing sealed value, else unbound version 1 ciphertext; nil means the plaintext column holds the value.
    private func olderValue(_ sealed: Data?, _ field: DiaryCrypto.Field, _ uid: UUID?, _ date: Date, _ encrypted: Data?) throws -> String? {
        if let sealed {
            guard let uid else { throw DiaryCryptoError.invalidCiphertext }
            return try DiaryCrypto.open(sealed, field: field, id: uid, date: date)
        }
        return try encrypted.map { try DiaryCrypto.openLegacy($0) }
    }
}

private struct CaptureCover: View {
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 16) {
                Mascot(size: 90)
                Text("偵測到螢幕錄影或畫面鏡像，日記內容已隱藏。")
                    .font(.system(.headline, design: .rounded))
                Text("停止錄影或鏡像後就會恢復。")
                    .font(.system(.subheadline, design: .rounded))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            }
            .foregroundStyle(Theme.ink)
            .multilineTextAlignment(.center)
            .padding(32)
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

