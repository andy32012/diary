import SwiftUI
import SwiftData

struct TimelineView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Entry.createdAt, order: .reverse) private var entries: [Entry]
    @State private var search = ""
    @State private var editing: Entry?

    private var filtered: [Entry] {
        search.isEmpty ? entries : entries.filter { $0.body.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered) { entry in
                    Button { editing = entry } label: { EntryRow(entry: entry) }
                        .buttonStyle(.plain)
                }
                .onDelete { offsets in
                    offsets.map { filtered[$0] }.forEach(context.delete)
                }
            }
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView("還沒有日記", systemImage: "square.and.pencil",
                                           description: Text("點右上角開始寫今天"))
                }
            }
            .searchable(text: $search, prompt: "搜尋日記")
            .navigationTitle("日記")
            .toolbar {
                Button {
                    let entry = Entry()
                    context.insert(entry)
                    editing = entry
                } label: { Image(systemName: "square.and.pencil") }
            }
            .sheet(item: $editing) { EditorView(entry: $0) }
        }
    }
}

struct EntryRow: View {
    let entry: Entry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(Mood.emoji(entry.mood)).font(.title)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.createdAt, format: .dateTime.year().month().day().weekday())
                    .font(.caption).foregroundStyle(.secondary)
                Text(entry.body.isEmpty ? "（空白）" : entry.body)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 4)
    }
}
