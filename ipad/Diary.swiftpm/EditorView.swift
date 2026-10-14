import SwiftUI

struct EditorView: View {
    @Bindable var entry: Entry
    let onDone: () -> Void
    @State private var burst = 0
    @State private var draft = ""
    @State private var selectedMood = 3
    @State private var bodyEncryptionFailed = false
    @State private var moodEncryptionFailed = false
    @State private var showEncryptionError = false
    @State private var encryptionError = ""
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Theme.moodColor(selectedMood).opacity(0.35)
                .ignoresSafeArea()
                .animation(.easeInOut(duration: 0.5), value: selectedMood)

            VStack(alignment: .leading, spacing: 20) {
                MoodPicker(mood: $selectedMood)
                    .onChange(of: selectedMood) { _, value in
                        do {
                            try entry.encryptMood(value)
                            moodEncryptionFailed = false
                        } catch {
                            reportEncryptionFailure(error)
                            moodEncryptionFailed = true
                        }
                    }

                TextEditor(text: $draft)
                    .font(.system(.title3, design: .rounded))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.white.opacity(0.85)))
                    .overlay(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text("今天發生了什麼事呢？")
                                .font(.system(.title3, design: .rounded))
                                .foregroundStyle(.secondary)
                                .padding(24)
                                .allowsHitTesting(false)
                        }
                    }
                    .onChange(of: draft) { _, value in
                        do {
                            try entry.encryptBody(value)
                            bodyEncryptionFailed = false
                        } catch {
                            reportEncryptionFailure(error)
                            bodyEncryptionFailed = true
                        }
                    }

                Text("\(draft.count) 字")
                    .font(.system(.callout, design: .rounded))
                    .foregroundStyle(Theme.ink.opacity(0.6))
                    .contentTransition(.numericText())
                    .animation(.snappy, value: draft.count)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(28)
            .frame(maxWidth: 820)

            ConfettiBurst(trigger: burst)
        }
        .navigationTitle(entry.createdAt.formatted(date: .complete, time: .omitted))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button {
                entry.updatedAt = .now
                focused = false
                burst += 1
                Task {
                    try? await Task.sleep(for: .seconds(0.8))
                    onDone()
                }
            } label: {
                Label("完成", systemImage: "heart.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.system(.body, design: .rounded, weight: .bold))
            }
            .disabled(bodyEncryptionFailed || moodEncryptionFailed)
            .keyboardShortcut(.return, modifiers: .command)
            .sensoryFeedback(.success, trigger: burst)
        }
        .sensoryFeedback(.selection, trigger: selectedMood)
        .onAppear {
            guard let body = entry.bodyText, let mood = entry.moodValue else {
                encryptionError = "無法解密這篇日記。原始資料仍保留，請重新解鎖，或檢查備份中的加密金鑰檔。"
                showEncryptionError = true
                bodyEncryptionFailed = true
                moodEncryptionFailed = true
                return
            }
            draft = body
            selectedMood = mood
            if entry.isBlank { focused = true }
        }
        .alert("無法安全儲存", isPresented: $showEncryptionError) {
            Button("好", role: .cancel) {}
        } message: {
            Text(encryptionError)
        }
    }

    private func reportEncryptionFailure(_ error: Error) {
        encryptionError = error.localizedDescription
        showEncryptionError = true
    }
}

/// 點了會跳起來、放大、轉一圈的心情選擇器
struct MoodPicker: View {
    @Binding var mood: Int

    var body: some View {
        HStack(spacing: 0) {
            ForEach(1...5, id: \.self) { value in
                let selected = mood == value
                Button {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.45)) { mood = value }
                } label: {
                    VStack(spacing: 6) {
                        Text(Mood.emoji(value))
                            .font(.system(size: 44))
                            .scaleEffect(selected ? 1.3 : 0.9)
                            .offset(y: selected ? -6 : 0)
                            .rotationEffect(.degrees(selected ? 360 : 0))
                            .grayscale(selected ? 0 : 0.6)
                            .frame(width: 76, height: 76)
                            .background {
                                if selected {
                                    Circle().fill(Theme.moodColor(value)).transition(.scale)
                                }
                            }
                        Text(Mood.name(value))
                            .font(.system(.caption, design: .rounded, weight: .semibold))
                            .foregroundStyle(Theme.ink.opacity(selected ? 1 : 0.4))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bouncy)
            }
        }
    }
}

