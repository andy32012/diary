import SwiftUI
import SwiftData

struct DiaryListView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Entry.createdAt, order: .reverse) private var entries: [Entry]
    @State private var search = ""
    @State private var editing: Entry?
    @State private var addTaps = 0

    private var filtered: [Entry] {
        search.isEmpty ? entries : entries.filter { $0.body.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottomTrailing) {
                Theme.background.ignoresSafeArea()
                FloatingBubbles()

                if entries.isEmpty {
                    EmptyState()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 14) {
                            ForEach(filtered) { entry in
                                Button { editing = entry } label: { EntryCard(entry: entry) }
                                    .buttonStyle(.bouncy)
                                    .contextMenu {
                                        Button("刪除", systemImage: "trash", role: .destructive) {
                                            withAnimation(.spring) { context.delete(entry) }
                                        }
                                    }
                                    .scrollTransition { view, phase in
                                        view
                                            .scaleEffect(phase.isIdentity ? 1 : 0.85)
                                            .opacity(phase.isIdentity ? 1 : 0.4)
                                            .rotationEffect(.degrees(phase.value * 3))
                                    }
                                    .transition(.scale.combined(with: .opacity))
                            }
                        }
                        .padding()
                        .padding(.bottom, 90)
                        .animation(.spring(response: 0.45, dampingFraction: 0.7), value: filtered.map(\.id))
                    }
                }

                AddButton(taps: addTaps) {
                    addTaps += 1
                    let entry = Entry()
                    context.insert(entry)
                    editing = entry
                }
                .padding(24)
            }
            .searchable(text: $search, prompt: "搜尋日記")
            .navigationTitle("我的日記 ✿")
            .sheet(item: $editing) { EditorView(entry: $0) }
        }
    }
}

private struct AddButton: View {
    let taps: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "pencil.and.scribble")
                .font(.title.bold())
                .foregroundStyle(.white)
                .symbolEffect(.bounce, value: taps)
                .frame(width: 68, height: 68)
                .background(Circle().fill(LinearGradient(colors: [Theme.pink, Theme.lavender],
                                                         startPoint: .topLeading, endPoint: .bottomTrailing)))
                .shadow(color: Theme.pink.opacity(0.7), radius: 12, y: 6)
        }
        .buttonStyle(.bouncy)
        .phaseAnimator([false, true]) { view, up in
            view.offset(y: up ? -6 : 0)
        } animation: { _ in .easeInOut(duration: 1.2) }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: taps)
    }
}

private struct EmptyState: View {
    var body: some View {
        VStack(spacing: 18) {
            Mascot()
            Text("還沒有日記喔")
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text("點右下角的筆，寫下今天吧 ✎")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .foregroundStyle(Theme.ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EntryCard: View {
    let entry: Entry

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(Mood.emoji(entry.mood))
                .font(.system(size: 34))
                .frame(width: 54, height: 54)
                .background(Circle().fill(Theme.moodColor(entry.mood)))
                .phaseAnimator([0.0, 8.0, -8.0, 0.0]) { view, angle in
                    view.rotationEffect(.degrees(angle))
                } animation: { _ in .easeInOut(duration: 0.6).delay(1.5) }
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.createdAt, format: .dateTime.month().day().weekday())
                    .font(.system(.caption, design: .rounded, weight: .semibold))
                    .foregroundStyle(Theme.ink.opacity(0.6))
                Text(entry.body.isEmpty ? "（空白）" : entry.body)
                    .font(.system(.body, design: .rounded))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.white.opacity(0.85))
                .shadow(color: Theme.moodColor(entry.mood).opacity(0.6), radius: 10, y: 5)
        )
    }
}
