import Foundation
import SwiftData

@Model
final class Entry {
    var createdAt: Date
    var updatedAt: Date

    // Plaintext and unbound (version 1) columns are only read by the migration and cleared afterwards.
    var body: String
    var mood: Int
    var encryptedBody: Data?
    var encryptedMood: Data?
    // Sealed values are bound to uid, field and createdAt and padded to hide the text length.
    var uid: UUID?
    var sealedBody: Data?
    var sealedMood: Data?

    init(body: String = "", mood: Int = 3, createdAt: Date = .now) {
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.body = body
        self.mood = mood
        self.encryptedBody = nil
        self.encryptedMood = nil
        self.uid = UUID()
        self.sealedBody = nil
        self.sealedMood = nil
    }

    var needsMigration: Bool { uid == nil || sealedBody == nil || sealedMood == nil }

    var bodyText: String? {
        guard let uid, let sealedBody else { return nil }
        return try? DiaryCrypto.open(sealedBody, field: .entryBody, id: uid, date: createdAt)
    }

    var moodValue: Int? {
        guard let uid, let sealedMood,
              let text = try? DiaryCrypto.open(sealedMood, field: .entryMood, id: uid, date: createdAt),
              let value = Int(text),
              (1...5).contains(value) else { return nil }
        return value
    }

    func encryptBody(_ value: String) throws {
        guard let uid else { throw DiaryCryptoError.invalidCiphertext }
        sealedBody = try DiaryCrypto.seal(value, field: .entryBody, id: uid, date: createdAt)
        body = ""
        encryptedBody = nil
    }

    func encryptMood(_ value: Int) throws {
        guard let uid else { throw DiaryCryptoError.invalidCiphertext }
        let normalizedValue = min(max(value, 1), 5)
        sealedMood = try DiaryCrypto.seal(String(normalizedValue), field: .entryMood, id: uid, date: createdAt)
        mood = 0
        encryptedMood = nil
    }

    var isBlank: Bool {
        guard let bodyText else { return false }
        return bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum Mood {
    static let emojis = ["😢", "🙁", "😐", "🙂", "😄"]
    static let names = ["難過", "不太好", "普通", "不錯", "超開心"]

    static func emoji(_ value: Int) -> String { emojis[clamp(value)] }
    static func name(_ value: Int) -> String { names[clamp(value)] }
    private static func clamp(_ value: Int) -> Int { min(max(value, 1), 5) - 1 }
}
