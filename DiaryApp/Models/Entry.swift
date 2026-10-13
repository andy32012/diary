import Foundation
import SwiftData

@Model
final class Entry {
    var createdAt: Date
    var updatedAt: Date
    var body: String
    var mood: Int   // 1...5
    var tags: [String]

    init(body: String = "", mood: Int = 3, tags: [String] = [], createdAt: Date = .now) {
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.body = body
        self.mood = mood
        self.tags = tags
    }
}

enum Mood {
    static let emojis = ["😢", "🙁", "😐", "🙂", "😄"]
    static func emoji(_ value: Int) -> String {
        emojis[min(max(value, 1), 5) - 1]
    }
}
