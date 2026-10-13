import SwiftUI

struct EditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Bindable var entry: Entry
    @State private var burst = 0

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.moodColor(entry.mood).opacity(0.35)
                    .ignoresSafeArea()
                    .animation(.easeInOut(duration: 0.5), value: entry.mood)

                VStack(alignment: .leading, spacing: 18) {
                    MoodPicker(mood: $entry.mood)

                    TextEditor(text: $entry.body)
                        .font(.system(.body, design: .rounded))
                        .scrollContentBackground(.hidden)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.white.opacity(0.85)))
                        .overlay(alignment: .topLeading) {
                            if entry.body.isEmpty {
                                Text("今天發生了什麼事呢？")
                                    .foregroundStyle(.secondary)
                                    .padding(20)
                                    .allowsHitTesting(false)
                            }
                        }

                    Text("\(entry.body.count) 字")
                        .font(.system(.caption, design: .rounded))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                        .contentTransition(.numericText())
                        .animation(.snappy, value: entry.body.count)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .padding()

                ConfettiBurst(trigger: burst)
            }
            .navigationTitle(entry.createdAt.formatted(date: .abbreviated, time: .omitted))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button {
                    entry.updatedAt = .now
                    burst += 1
                    Task {
                        try? await Task.sleep(for: .seconds(0.7))
                        dismiss()
                    }
                } label: {
                    Label("完成", systemImage: "heart.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.system(.body, design: .rounded, weight: .bold))
                }
                .tint(Theme.pink)
                .sensoryFeedback(.success, trigger: burst)
            }
            .onDisappear {
                if entry.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    context.delete(entry)
                }
            }
        }
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
                    Text(Mood.emoji(value))
                        .font(.system(size: 36))
                        .scaleEffect(selected ? 1.35 : 0.9)
                        .offset(y: selected ? -6 : 0)
                        .rotationEffect(.degrees(selected ? 360 : 0))
                        .grayscale(selected ? 0 : 0.6)
                        .frame(maxWidth: .infinity, minHeight: 64)
                        .background {
                            if selected {
                                Circle()
                                    .fill(Theme.moodColor(value))
                                    .frame(width: 58, height: 58)
                                    .transition(.scale)
                            }
                        }
                }
                .buttonStyle(.bouncy)
            }
        }
        .sensoryFeedback(.selection, trigger: mood)
    }
}
