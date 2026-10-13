import SwiftUI

struct EditorView: View {
    @Bindable var entry: Entry
    let onDone: () -> Void
    @State private var burst = 0
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Theme.moodColor(entry.mood).opacity(0.35)
                .ignoresSafeArea()
                .animation(.easeInOut(duration: 0.5), value: entry.mood)

            VStack(alignment: .leading, spacing: 20) {
                MoodPicker(mood: $entry.mood)

                TextEditor(text: $entry.body)
                    .font(.system(.title3, design: .rounded))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.white.opacity(0.85)))
                    .overlay(alignment: .topLeading) {
                        if entry.body.isEmpty {
                            Text("今天發生了什麼事呢？")
                                .font(.system(.title3, design: .rounded))
                                .foregroundStyle(.secondary)
                                .padding(24)
                                .allowsHitTesting(false)
                        }
                    }

                Text("\(entry.body.count) 字")
                    .font(.system(.callout, design: .rounded))
                    .foregroundStyle(Theme.ink.opacity(0.6))
                    .contentTransition(.numericText())
                    .animation(.snappy, value: entry.body.count)
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
            .keyboardShortcut(.return, modifiers: .command)
            .sensoryFeedback(.success, trigger: burst)
        }
        .onAppear { if entry.isBlank { focused = true } }
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
        .sensoryFeedback(.selection, trigger: mood)
    }
}
