import SwiftUI
import SwiftData

struct CalendarView: View {
    @Query(sort: \Entry.createdAt, order: .reverse) private var entries: [Entry]
    @State private var date = Date.now

    private var dayEntries: [Entry] {
        entries.filter { Calendar.current.isDate($0.createdAt, inSameDayAs: date) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 16) {
                        DatePicker("日期", selection: $date, displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .tint(Theme.pink)
                            .padding(8)
                            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.white.opacity(0.85)))

                        Group {
                            if dayEntries.isEmpty {
                                VStack(spacing: 10) {
                                    Mascot(size: 60)
                                    Text("這天沒有寫日記")
                                        .font(.system(.subheadline, design: .rounded))
                                        .foregroundStyle(Theme.ink.opacity(0.7))
                                }
                                .padding(.top, 10)
                            } else {
                                ForEach(dayEntries) { EntryCard(entry: $0) }
                            }
                        }
                        .id(Calendar.current.startOfDay(for: date))
                        .transition(.push(from: .bottom).combined(with: .opacity))
                    }
                    .padding()
                    .animation(.spring(response: 0.4, dampingFraction: 0.75), value: date)
                }
            }
            .navigationTitle("月曆")
        }
    }
}
