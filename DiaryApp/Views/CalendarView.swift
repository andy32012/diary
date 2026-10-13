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
            List {
                DatePicker("日期", selection: $date, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                Section("這天的日記") {
                    if dayEntries.isEmpty {
                        Text("這天沒有寫").foregroundStyle(.secondary)
                    }
                    ForEach(dayEntries) { EntryRow(entry: $0) }
                }
            }
            .navigationTitle("月曆")
        }
    }
}
