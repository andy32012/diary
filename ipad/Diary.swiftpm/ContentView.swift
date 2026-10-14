import SwiftUI
import SwiftData

/// iPad 版面：左邊日記列表／月曆，右邊寫日記
struct ContentView: View {
    enum Mode: String, CaseIterable { case list = "日記", calendar = "月曆", weight = "體重" }

    @Environment(\.modelContext) private var context
    @Query(sort: \Entry.createdAt, order: .reverse) private var entries: [Entry]
    @State private var selection: Entry?
    @State private var search = ""
    @State private var mode = Mode.list
    @State private var day = Date.now
    @State private var addTaps = 0
    @State private var encryptionError = ""
    @State private var showEncryptionError = false

    private var shown: [Entry] {
        switch mode {
        case .list:
            search.isEmpty ? entries : entries.filter { $0.bodyText?.localizedCaseInsensitiveContains(search) == true }
        case .calendar:
            entries.filter { Calendar.current.isDate($0.createdAt, inSameDayAs: day) }
        case .weight:
            []
        }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            if mode == .weight {
                WeightChartView()
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else if let selection {
                EditorView(entry: selection) { self.selection = nil }
                    .id(selection.id)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                EmptyDetail()
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.8), value: selection?.id)
        .animation(.spring(response: 0.45, dampingFraction: 0.8), value: mode)
        .onChange(of: mode) { if mode == .weight { selection = nil } }
        .onChange(of: selection) { old, _ in
            if let old, old.isBlank { context.delete(old) }
        }
        .alert("無法安全建立日記", isPresented: $showEncryptionError) {
            Button("好", role: .cancel) {}
        } message: {
            Text(encryptionError)
        }
    }

    private var sidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            Theme.background.ignoresSafeArea()
            FloatingBubbles()

            ScrollView {
                VStack(spacing: 14) {
                    Picker("模式", selection: $mode.animation(.spring)) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    .pickerStyle(.segmented)

                    if mode == .calendar {
                        DatePicker("日期", selection: $day, displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .padding(8)
                            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.white.opacity(0.85)))
                            .transition(.push(from: .top).combined(with: .opacity))
                    }

                    if mode == .weight {
                        WeightPanel()
                            .transition(.push(from: .trailing).combined(with: .opacity))
                    } else if shown.isEmpty {
                        VStack(spacing: 12) {
                            Mascot(size: mode == .list ? 90 : 60)
                            Text(mode == .list ? "還沒有日記喔\n點右下角的筆寫下今天吧 ✎" : "這天沒有寫日記")
                                .multilineTextAlignment(.center)
                                .font(.system(.subheadline, design: .rounded))
                                .foregroundStyle(Theme.ink.opacity(0.7))
                        }
                        .padding(.top, 40)
                    }

                    ForEach(shown) { entry in
                        Button { selection = entry } label: {
                            EntryCard(entry: entry, selected: selection?.id == entry.id)
                        }
                        .buttonStyle(.bouncy)
                        .contextMenu {
                            Button("刪除", systemImage: "trash", role: .destructive) {
                                if selection?.id == entry.id { selection = nil }
                                withAnimation(.spring) { context.delete(entry) }
                            }
                        }
                        .scrollTransition { view, phase in
                            view
                                .scaleEffect(phase.isIdentity ? 1 : 0.85)
                                .opacity(phase.isIdentity ? 1 : 0.4)
                        }
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .padding()
                .padding(.bottom, 90)
                .animation(.spring(response: 0.45, dampingFraction: 0.75), value: shown.map(\.id))
                .animation(.spring(response: 0.4, dampingFraction: 0.75), value: day)
            }

            if mode != .weight {
                AddButton(taps: addTaps) {
                    addTaps += 1
                    let entry = Entry(createdAt: mode == .calendar ? day : .now)
                    do {
                        try entry.encryptBody("")
                        try entry.encryptMood(3)
                        context.insert(entry)
                        selection = entry
                    } catch {
                        encryptionError = error.localizedDescription
                        showEncryptionError = true
                    }
                }
                .padding(24)
                .transition(.scale.combined(with: .opacity))
            }
        }
        .searchable(text: $search, prompt: "搜尋日記")
        .navigationTitle("我的日記 ✿")
        .navigationSplitViewColumnWidth(min: 320, ideal: 380)
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
        .keyboardShortcut("n", modifiers: .command)
        .phaseAnimator([false, true]) { view, up in
            view.offset(y: up ? -6 : 0)
        } animation: { _ in .easeInOut(duration: 1.2) }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: taps)
    }
}

private struct EmptyDetail: View {
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 20) {
                Mascot(size: 130)
                Text("選一篇日記，或寫一篇新的吧")
                    .font(.system(.title3, design: .rounded, weight: .semibold))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            }
        }
    }
}

struct EntryCard: View {
    let entry: Entry
    var selected = false

    var body: some View {
        let mood = entry.moodValue ?? 3
        HStack(alignment: .top, spacing: 14) {
            Text(Mood.emoji(mood))
                .font(.system(size: 34))
                .frame(width: 54, height: 54)
                .background(Circle().fill(Theme.moodColor(mood)))
                .phaseAnimator([0.0, 8.0, -8.0, 0.0]) { view, angle in
                    view.rotationEffect(.degrees(angle))
                } animation: { _ in .easeInOut(duration: 0.6).delay(1.5) }
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.createdAt, format: .dateTime.month().day().weekday())
                    .font(.system(.caption, design: .rounded, weight: .semibold))
                    .foregroundStyle(Theme.ink.opacity(0.6))
                Text(entry.isBlank ? "（新的日記）" : (entry.bodyText ?? "（無法解密）"))
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
                .fill(.white.opacity(selected ? 1 : 0.85))
                .shadow(color: Theme.moodColor(mood).opacity(0.6), radius: 10, y: 5)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Theme.pinkDeep, lineWidth: selected ? 3 : 0)
        )
        .scaleEffect(selected ? 1.02 : 1)
        .animation(.spring(response: 0.35, dampingFraction: 0.6), value: selected)
    }
}
