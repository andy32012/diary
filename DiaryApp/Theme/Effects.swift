import SwiftUI

/// 背景慢慢飄動的小泡泡
struct FloatingBubbles: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                for i in 0..<10 {
                    let seed = Double(i) * 1.7
                    let x = (sin(t * 0.15 + seed) * 0.4 + 0.5) * size.width
                    let y = size.height - (t * 12 + seed * 90).truncatingRemainder(dividingBy: size.height + 80) + 40
                    let r = 14 + 10 * sin(seed)
                    let color = Theme.moodColors[i % Theme.moodColors.count].opacity(0.35)
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r * 2, height: r * 2)), with: .color(color))
                }
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

/// 存檔時噴出的愛心與星星
struct ConfettiBurst: View {
    let trigger: Int
    private let symbols = ["heart.fill", "star.fill", "sparkle", "heart.fill", "star.fill"]

    var body: some View {
        ZStack {
            ForEach(0..<14, id: \.self) { i in
                Particle(index: i, symbol: symbols[i % symbols.count], trigger: trigger)
            }
        }
        .allowsHitTesting(false)
    }

    private struct Particle: View {
        let index: Int
        let symbol: String
        let trigger: Int
        @State private var fly = false

        var body: some View {
            let angle = Double(index) / 14 * 2 * .pi
            let distance: CGFloat = 110 + CGFloat(index % 3) * 30
            Image(systemName: symbol)
                .font(.system(size: 18 + CGFloat(index % 3) * 4))
                .foregroundStyle(Theme.moodColors[index % 5].opacity(0.95))
                .offset(x: fly ? cos(angle) * distance : 0, y: fly ? sin(angle) * distance : 0)
                .scaleEffect(fly ? 1 : 0.1)
                .rotationEffect(.degrees(fly ? 180 : 0))
                .opacity(fly ? 0 : (trigger == 0 ? 0 : 1))
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
            RoundedRectangle(cornerRadius: size * 0.22)
                .fill(LinearGradient(colors: [Theme.pink, Theme.peach], startPoint: .top, endPoint: .bottom))
                .frame(width: size, height: size * 1.1)
                .shadow(color: Theme.pink.opacity(0.6), radius: 10, y: 6)
            VStack(spacing: size * 0.08) {
                HStack(spacing: size * 0.22) {
                    eye
                    eye
                }
                HStack(spacing: size * 0.35) {
                    Circle().fill(.pink.opacity(0.45)).frame(width: size * 0.14)
                    Circle().fill(.pink.opacity(0.45)).frame(width: size * 0.14)
                }
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
        Capsule()
            .fill(Theme.ink)
            .frame(width: size * 0.1, height: blink ? size * 0.02 : size * 0.14)
    }
}
