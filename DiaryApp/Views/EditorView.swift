import SwiftUI

struct EditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Bindable var entry: Entry

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    ForEach(1...5, id: \.self) { value in
                        Text(Mood.emoji(value))
                            .font(.largeTitle)
                            .opacity(entry.mood == value ? 1 : 0.3)
                            .onTapGesture { entry.mood = value }
                    }
                }
                TextEditor(text: $entry.body)
                    .font(.body)
            }
            .padding()
            .navigationTitle(entry.createdAt.formatted(date: .abbreviated, time: .omitted))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("完成") {
                    entry.updatedAt = .now
                    dismiss()
                }
            }
            .onDisappear {
                if entry.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    context.delete(entry)
                }
            }
        }
    }
}
