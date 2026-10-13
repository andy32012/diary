import SwiftUI

enum Theme {
    static let pink = Color(red: 1.00, green: 0.71, blue: 0.78)
    static let pinkDeep = Color(red: 1.00, green: 0.56, blue: 0.67)
    static let peach = Color(red: 1.00, green: 0.85, blue: 0.73)
    static let mint = Color(red: 0.74, green: 0.93, blue: 0.85)
    static let sky = Color(red: 0.75, green: 0.86, blue: 1.00)
    static let lavender = Color(red: 0.82, green: 0.78, blue: 0.98)
    static let cream = Color(red: 1.00, green: 0.98, blue: 0.94)
    static let ink = Color(red: 0.36, green: 0.29, blue: 0.35)

    static let moodColors: [Color] = [lavender, sky, peach, mint, pink]

    static func moodColor(_ mood: Int) -> Color {
        moodColors[min(max(mood, 1), 5) - 1]
    }

    static let background = LinearGradient(colors: [cream, pink.opacity(0.35), lavender.opacity(0.35)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
}

/// 按下去縮一下再「啵」彈回來
struct BouncyButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.45), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == BouncyButtonStyle {
    static var bouncy: BouncyButtonStyle { BouncyButtonStyle() }
}

/// 背景慢慢往上飄的小泡泡
struct FloatingBubbles: View {
    var body: some View {
        SwiftUI.TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                for i in 0..<14 {
                    let seed = Double(i) * 1.7
                    let x = (sin(t * 0.15 + seed) * 0.45 + 0.5) * size.width
                    let travel = size.height + 120
                    let y = size.height + 60 - (t * 14 + seed * 140).truncatingRemainder(dividingBy: travel)
                    let r = 16 + 12 * abs(sin(seed))
                    let color = Theme.moodColors[i % Theme.moodColors.count].opacity(0.35)
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r * 2, height: r * 2)), with: .color(color))
                }
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

/// 存檔時噴出一圈愛心與星星
struct ConfettiBurst: View {
    let trigger: Int
    private let symbols = ["heart.fill", "star.fill", "sparkle"]

    var body: some View {
        ZStack {
            ForEach(0..<18, id: \.self) { i in
                Particle(index: i, count: 18, symbol: symbols[i % symbols.count], trigger: trigger)
            }
        }
        .allowsHitTesting(false)
    }

    private struct Particle: View {
        let index: Int
        let count: Int
        let symbol: String
        let trigger: Int
        @State private var fly = false

        var body: some View {
            let angle = Double(index) / Double(count) * 2 * .pi
            let distance: CGFloat = 140 + CGFloat(index % 3) * 40
            Image(systemName: symbol)
                .font(.system(size: 22 + CGFloat(index % 3) * 6))
                .foregroundStyle(Theme.moodColors[index % 5])
                .offset(x: fly ? cos(angle) * distance : 0, y: fly ? sin(angle) * distance : 0)
                .scaleEffect(fly ? 1 : 0.1)
                .rotationEffect(.degrees(fly ? 180 : 0))
                .opacity(fly || trigger == 0 ? 0 : 1)
                .onChange(of: trigger) {
                    fly = false
                    withAnimation(.easeOut(duration: 0.9)) { fly = true }
                }
        }
    }
}

/// 會呼吸、眨眼、偶爾跳一下的小日記本吉祥物
struct Mascot: View {
    var size: CGFloat = 90
    @State private var blink = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(LinearGradient(colors: [Theme.pink, Theme.peach], startPoint: .top, endPoint: .bottom))
                .frame(width: size, height: size * 1.1)
                .shadow(color: Theme.pink.opacity(0.6), radius: 10, y: 6)
            VStack(spacing: size * 0.08) {
                HStack(spacing: size * 0.22) { eye; eye }
                HStack(spacing: size * 0.35) { cheek; cheek }
                Capsule().fill(Theme.ink).frame(width: size * 0.16, height: size * 0.06)
            }
        }
        .phaseAnimator([0, 1, 2]) { view, phase in
            view
                .scaleEffect(x: phase == 1 ? 1.06 : 1, y: phase == 1 ? 0.94 : 1, anchor: .bottom)
                .offset(y: phase == 2 ? -size * 0.15 : 0)
        } animation: { phase in
            phase == 2 ? .spring(response: 0.35, dampingFraction: 0.5) : .easeInOut(duration: 0.8)
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.6))
                withAnimation(.easeInOut(duration: 0.08)) { blink = true }
                try? await Task.sleep(for: .seconds(0.12))
                withAnimation(.easeInOut(duration: 0.08)) { blink = false }
            }
        }
    }

    private var eye: some View {
        Capsule().fill(Theme.ink)
            .frame(width: size * 0.1, height: blink ? size * 0.02 : size * 0.14)
    }

    private var cheek: some View {
        Circle().fill(Color.pink.opacity(0.45)).frame(width: size * 0.14, height: size * 0.14)
    }
}
