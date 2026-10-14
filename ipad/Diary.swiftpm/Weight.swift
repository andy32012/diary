import SwiftUI
import SwiftData
import Charts

@Model
final class WeightRecord {
    var date: Date      // 一天一筆，存當天 00:00
    var kg: Double
    var encryptedKg: Data?

    init(date: Date, kg: Double) {
        self.date = Calendar.current.startOfDay(for: date)
        self.kg = kg
        self.encryptedKg = nil
    }

    var weightValue: Double? {
        guard let encryptedKg else { return kg }
        guard let text = try? DiaryCrypto.decrypt(encryptedKg),
              let value = Double(text),
              value.isFinite else { return nil }
        return value
    }

    func encryptWeight(_ value: Double) throws {
        encryptedKg = try DiaryCrypto.encrypt(String(value))
        kg = 0
    }
}

/// 左側：輸入體重＋歷史紀錄
struct WeightPanel: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \WeightRecord.date, order: .reverse) private var records: [WeightRecord]
    @State private var date = Date.now
    @State private var text = ""
    @State private var saves = 0
    @State private var shake = 0
    @State private var encryptionError = ""
    @State private var showEncryptionError = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 12) {
                Text("⚖️")
                    .font(.system(size: 44))
                    .phaseAnimator([0.0, 10.0, -10.0, 0.0]) { view, angle in
                        view.rotationEffect(.degrees(angle))
                    } animation: { _ in .easeInOut(duration: 0.5).delay(1.2) }

                DatePicker("日期", selection: $date, in: ...Date.now, displayedComponents: .date)
                    .labelsHidden()

                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    TextField("0.0", text: $text)
                        .keyboardType(.decimalPad)
                        .focused($focused)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 44, weight: .heavy, design: .rounded))
                        .frame(width: 150)
                        .onSubmit(save)
                    Text("kg").font(.system(.headline, design: .rounded)).foregroundStyle(Theme.ink.opacity(0.6))
                }
                .foregroundStyle(Theme.ink)
                .keyframeAnimator(initialValue: 0.0, trigger: shake) { view, x in
                    view.offset(x: x)
                } keyframes: { _ in
                    KeyframeTrack {
                        CubicKeyframe(-10, duration: 0.08)
                        CubicKeyframe(10, duration: 0.08)
                        CubicKeyframe(-6, duration: 0.08)
                        CubicKeyframe(0, duration: 0.08)
                    }
                }

                Button(action: save) {
                    Label("記錄", systemImage: "heart.fill")
                        .font(.system(.headline, design: .rounded, weight: .heavy))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 28).padding(.vertical, 10)
                        .background(Capsule().fill(LinearGradient(colors: [Theme.pinkDeep, Theme.lavender],
                                                                  startPoint: .leading, endPoint: .trailing)))
                        .shadow(color: Theme.pink.opacity(0.7), radius: 8, y: 4)
                }
                .buttonStyle(.bouncy)
            }
            .padding(18)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.white.opacity(0.85)))
            .overlay { ConfettiBurst(trigger: saves) }
            .sensoryFeedback(.success, trigger: saves)
            .sensoryFeedback(.error, trigger: shake)

            ForEach(Array(records.enumerated()), id: \.element.id) { index, record in
                let previous = index + 1 < records.count ? records[index + 1] : nil
                WeightRow(record: record, previous: previous)
                    .contextMenu {
                        Button("刪除", systemImage: "trash", role: .destructive) {
                            withAnimation(.spring) { context.delete(record) }
                        }
                    }
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.75), value: records.map(\.id))
        .alert("無法安全記錄體重", isPresented: $showEncryptionError) {
            Button("好", role: .cancel) {}
        } message: {
            Text(encryptionError)
        }
    }

    private func save() {
        let value = Double(text.replacingOccurrences(of: ",", with: ".")) ?? 0
        guard (20...300).contains(value) else {
            shake += 1
            return
        }
        let day = Calendar.current.startOfDay(for: date)
        let roundedValue = (value * 10).rounded() / 10
        let record = WeightRecord(date: day, kg: roundedValue)
        do {
            try record.encryptWeight(roundedValue)
        } catch {
            encryptionError = error.localizedDescription
            showEncryptionError = true
            return
        }
        for old in records where old.date == day { context.delete(old) }   // 一天只留一筆
        context.insert(record)
        text = ""
        focused = false
        saves += 1
    }
}

private struct WeightRow: View {
    let record: WeightRecord
    let previous: WeightRecord?

    var body: some View {
        let value = record.weightValue ?? 0
        let previousValue = previous?.weightValue
        HStack(spacing: 12) {
            Text(record.date, format: .dateTime.month().day().weekday())
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(Theme.ink.opacity(0.7))
            Spacer()
            Text(value, format: .number.precision(.fractionLength(1)))
                .font(.system(.title3, design: .rounded, weight: .heavy))
            Text("kg").font(.caption).foregroundStyle(.secondary)
            if let previous {
                let diff = ((value - (previousValue ?? value)) * 10).rounded() / 10
                Text(diff > 0 ? "▲ +\(diff, specifier: "%.1f")" : diff < 0 ? "▼ \(diff, specifier: "%.1f")" : "－ 0.0")
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(diff < 0 ? Theme.mint : diff > 0 ? Theme.peach : Color.gray.opacity(0.2)))
            }
        }
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white.opacity(0.85)))
    }
}

/// 右側：統計與折線圖
struct WeightChartView: View {
    enum Range: Int, CaseIterable, Identifiable {
        case week = 7, month = 30, quarter = 90, all = 0
        var id: Int { rawValue }
        var title: String { self == .all ? "全部" : "\(rawValue) 天" }
    }

    @Query(sort: \WeightRecord.date) private var records: [WeightRecord]
    @State private var range = Range.month
    @State private var drawn = false
    @State private var picked: WeightRecord?

    private var data: [WeightRecord] {
        guard range != .all,
              let from = Calendar.current.date(byAdding: .day, value: -range.rawValue + 1,
                                               to: Calendar.current.startOfDay(for: .now)) else { return records }
        return records.filter { $0.date >= from }
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                Text("體重變化 📈")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.ink)

                stats

                VStack(spacing: 12) {
                    Picker("範圍", selection: $range.animation(.spring)) {
                        ForEach(Range.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 360)
                    .frame(maxWidth: .infinity, alignment: .trailing)

                    if data.count < 2 {
                        VStack(spacing: 14) {
                            Mascot(size: 70)
                            Text(data.isEmpty ? "還沒有體重紀錄，從左邊開始記吧 ⚖️" : "再記一筆就能畫出曲線囉！")
                                .font(.system(.headline, design: .rounded))
                                .foregroundStyle(Theme.ink.opacity(0.7))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        chart
                    }
                }
                .padding(20)
                .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.white.opacity(0.85)))
            }
            .padding(28)
            .frame(maxWidth: 980)
        }
        .onAppear { redraw() }
        .onChange(of: range) { redraw() }
        .onChange(of: records.count) { redraw() }
    }

    private func redraw() {
        drawn = false
        withAnimation(.easeOut(duration: 1.0).delay(0.1)) { drawn = true }
    }

    private var stats: some View {
        let kgs = records.compactMap(\.weightValue)
        let change = kgs.count > 1 ? ((kgs.last! - kgs.first!) * 10).rounded() / 10 : 0
        let items: [(String, String)] = records.isEmpty
            ? [("最新", "—"), ("總變化", "—"), ("最低", "—"), ("最高", "—")]
            : [("最新", String(format: "%.1f kg", kgs.last!)),
               ("總變化", String(format: "%@%.1f kg", change > 0 ? "+" : "", change) + (change < 0 ? " 🎉" : "")),
               ("最低", String(format: "%.1f kg", kgs.min()!)),
               ("最高", String(format: "%.1f kg", kgs.max()!))]
        return HStack(spacing: 14) {
            ForEach(items, id: \.0) { title, value in
                VStack(spacing: 4) {
                    Text(title).font(.system(.caption, design: .rounded, weight: .bold)).opacity(0.6)
                    Text(value)
                        .font(.system(.title2, design: .rounded, weight: .heavy))
                        .contentTransition(.numericText())
                }
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.white.opacity(0.85)))
            }
        }
        .animation(.snappy, value: records.map(\.kg))
    }

    private var chart: some View {
        let kgs = data.compactMap(\.weightValue)
        let pad = max(((kgs.max() ?? 0) - (kgs.min() ?? 0)) * 0.25, 0.5)
        let low = (kgs.min() ?? 0) - pad, high = (kgs.max() ?? 0) + pad

        return Chart(data) { record in
            AreaMark(x: .value("日期", record.date, unit: .day),
                     yStart: .value("下限", low),
                     yEnd: .value("體重", drawn ? (record.weightValue ?? low) : low))
                .foregroundStyle(LinearGradient(colors: [Theme.pink.opacity(0.55), Theme.lavender.opacity(0.05)],
                                                startPoint: .top, endPoint: .bottom))
                .interpolationMethod(.catmullRom)
            LineMark(x: .value("日期", record.date, unit: .day),
                     y: .value("體重", drawn ? (record.weightValue ?? low) : low))
                .foregroundStyle(Theme.pinkDeep)
                .lineStyle(StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)
            PointMark(x: .value("日期", record.date, unit: .day),
                      y: .value("體重", drawn ? record.kg : low))
                .symbol {
                    Circle().fill(.white).overlay(Circle().stroke(Theme.pinkDeep, lineWidth: 3))
                        .frame(width: picked?.id == record.id ? 18 : 12)
                }
            if let picked, picked.id == record.id {
                RuleMark(x: .value("日期", record.date, unit: .day))
                    .foregroundStyle(Theme.pink.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 6]))
                    .annotation(position: .top) {
                        Text(String(format: "%.1f kg", record.weightValue ?? 0))
                            .font(.system(.caption, design: .rounded, weight: .heavy))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Capsule().fill(Theme.ink))
                    }
            }
        }
        .chartYScale(domain: low...high)
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { AxisValueLabel(format: .dateTime.month().day()) } }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard let plot = proxy.plotFrame else { return }
                            let x = value.location.x - geo[plot].origin.x
                            guard let day: Date = proxy.value(atX: x) else { return }
                            let nearest = data.min { abs($0.date.timeIntervalSince(day)) < abs($1.date.timeIntervalSince(day)) }
                            withAnimation(.spring(response: 0.3)) { picked = nearest }
                        }
                        .onEnded { _ in withAnimation(.easeOut.delay(1)) { picked = nil } })
            }
        }
        .sensoryFeedback(.selection, trigger: picked?.id)
        .frame(maxHeight: .infinity)
    }
}
