import SwiftUI
import SwiftData
import UIKit
import Combine

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

/// The content view exists only during an authenticated, foreground session.
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
    @State private var lastActivity = Date.now
    @State private var generation = 0
    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if isReady && scenePhase == .active {
                VStack(spacing: 0) {
                    HStack {
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
                            Text("至少 12 個字元，建議使用密碼管理器產生長密碼。舊日記會在解鎖後安全遷移。")
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
        .task { refreshSetup() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { lock() }
            else { refreshSetup() }
        }
        .onReceive(clock) { now in
            if isReady && now.timeIntervalSince(lastActivity) >= 300 { lock() }
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
    private func lock() {
        generation += 1
        // Values are already encrypted by the editors. Flush them before releasing the key.
        if isReady {
            do { try context.save() }
            catch { errorMessage = "儲存失敗：\(error.localizedDescription)；請重新解鎖後重試。" }
        }
        isReady = false
        password = ""; confirmation = ""
        DiaryCrypto.lock()
    }
    private func unlock() {
        guard !busy, scenePhase == .active else { return }
        if setupRequired && (password.count < 12 || password != confirmation) {
            errorMessage = "請使用至少 12 個字元，並確認兩次密碼相同。"
            return
        }
        let attempt = generation
        let secret = password
        let hasEncryptedRecords = entries.contains { $0.encryptedBody != nil || $0.encryptedMood != nil }
            || weights.contains { $0.encryptedKg != nil }
        password = ""; confirmation = ""; busy = true; errorMessage = nil
        Task {
            do {
                try await Task.detached(priority: .userInitiated) {
                    try DiaryCrypto.unlock(password: secret, hasEncryptedRecords: hasEncryptedRecords)
                }.value
                guard attempt == generation, scenePhase == .active else {
                    DiaryCrypto.lock(); busy = false; refreshSetup(); return
                }
                try migrate()
                try DiaryCrypto.finishMigration()
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
    private func migrate() throws {
        // Stage and validate everything before modifying SwiftData objects.
        let stagedEntries: [(Entry, Data, Data)]
        let stagedWeights: [(WeightRecord, Data)]
        do {
            stagedEntries = try entries.map { entry -> (Entry, Data, Data) in
                let body = try entry.encryptedBody.map { try DiaryCrypto.decrypt($0) } ?? entry.body
                let moodText = try entry.encryptedMood.map { try DiaryCrypto.decrypt($0) } ?? String(entry.mood)
                guard let mood = Int(moodText), (1...5).contains(mood) else { throw DiaryCryptoError.invalidCiphertext }
                return (entry, try DiaryCrypto.encrypt(body), try DiaryCrypto.encrypt(String(mood)))
            }
            stagedWeights = try weights.map { record -> (WeightRecord, Data) in
                let text = try record.encryptedKg.map { try DiaryCrypto.decrypt($0) } ?? String(record.kg)
                guard let value = Double(text), value.isFinite, (20...300).contains(value) else { throw DiaryCryptoError.invalidCiphertext }
                return (record, try DiaryCrypto.encrypt(String(value)))
            }
        } catch DiaryCryptoError.locked {
            throw DiaryCryptoError.locked
        } catch {
            // The password already unwrapped the key, so this is a damaged or mismatched record, not a wrong password.
            throw DiaryCryptoError.unreadableRecord
        }
        let autosave = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = autosave }
        do {
            for (entry, body, mood) in stagedEntries {
                entry.encryptedBody = body; entry.encryptedMood = mood
                entry.body = ""; entry.mood = 0
            }
            for (record, kg) in stagedWeights { record.encryptedKg = kg; record.kg = 0 }
            try context.save()
        } catch { context.rollback(); throw error }
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

