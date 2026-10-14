import CryptoKit
import Foundation
import Security

enum DiaryCryptoError: LocalizedError {
    case keychain(OSStatus), invalidKey, invalidCiphertext, invalidUTF8, locked, password, weakPassword(String), missingKey, missingEnvelope
    var errorDescription: String? {
        switch self {
        case .keychain(let status): "無法讀取安全金鑰（\(status)）。"
        case .invalidKey: "日記金鑰格式錯誤。"
        case .invalidCiphertext: "密碼錯誤或加密資料損壞。"
        case .invalidUTF8: "日記資料格式錯誤。"
        case .locked: "日記已鎖定。"
        case .password: "請使用至少 12 個字元的長密碼，最多 1024 UTF-8 位元組。"
        case .weakPassword(let message): message
        case .missingKey: "找不到舊日記金鑰。已停止遷移，原始資料仍保留。"
        case .missingEnvelope: "找不到加密金鑰檔。請從同時包含資料庫與金鑰檔的完整備份還原；原始資料仍保留。"
        }
    }
}

/// Password wraps a random data key. Neither the password nor the unwrapped key is persisted.
enum DiaryCrypto {
    /// Each value is bound to its record, field and date, so ciphertext cannot be moved to another place.
    enum Field: String { case entryBody = "entry.body", entryMood = "entry.mood", weightKg = "weight.kg" }

    private static let state = KeyState()
    private static let pbkdf2Rounds = 600_000
    private static let scryptN = 1 << 17, scryptR = 8, scryptP = 1
    private static let v2AAD = Data("diary:key-envelope:v2:pbkdf2-sha256:600000".utf8)
    private static let migrationAAD = Data("diary:migration-key:v2".utf8)
    private static let pendingPhase = "pending", completePhase = "complete"
    /// Version 2 used PBKDF2. Version 3 uses scrypt; `phase` stays pending until older records are migrated.
    private struct Envelope: Codable {
        let version: Int
        let iterations: Int?
        let phase: String?
        let salt: Data
        let wrappedKey: Data
        let wrappedLegacyKey: Data?
    }
    private struct Pending {
        let wrapping: SymmetricKey
        let salt: Data
    }
    private final class KeyState: @unchecked Sendable {
        let mutex = NSLock()
        var key: SymmetricKey?
        var legacy: SymmetricKey?
        var pending: Pending?
        var generation = 0
        var failures = 0
        var retryAt = Date.distantPast
    }
    private static func envelopeURL() throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return folder.appendingPathComponent("diary-password-key-v2.json")
    }
    private static func envelopeAAD(_ phase: String, salt: Data) -> Data {
        Data("diary:key-envelope:v3:scrypt:N=131072:r=8:p=1:\(phase)".utf8) + salt
    }
    private static func fieldAAD(_ field: Field, id: UUID, date: Date) -> Data {
        Data("diary:field:v3:\(field.rawValue):\(id.uuidString):\(date.timeIntervalSinceReferenceDate.bitPattern)".utf8)
    }
    static func needsSetup() throws -> Bool {
        !FileManager.default.fileExists(atPath: try envelopeURL().path)
    }
    static func lock() {
        state.mutex.lock(); defer { state.mutex.unlock() }
        state.generation += 1
        state.key = nil; state.legacy = nil; state.pending = nil
    }
    private static func currentKey() throws -> SymmetricKey {
        state.mutex.lock(); defer { state.mutex.unlock() }
        guard let key = state.key else { throw DiaryCryptoError.locked }
        return key
    }
    /// True until every older record has been re-encrypted with record binding.
    static func isMigrationPending() throws -> Bool {
        state.mutex.lock(); defer { state.mutex.unlock() }
        guard state.key != nil else { throw DiaryCryptoError.locked }
        return state.pending != nil
    }

    static func seal(_ text: String, field: Field, id: UUID, date: Date) throws -> Data {
        var plain = padded(text, field: field)
        defer { plain.resetBytes(in: 0..<plain.count) }
        let box = try AES.GCM.seal(plain, using: currentKey(), authenticating: fieldAAD(field, id: id, date: date))
        guard let data = box.combined else { throw DiaryCryptoError.invalidCiphertext }
        return data
    }
    static func open(_ ciphertext: Data, field: Field, id: UUID, date: Date) throws -> String {
        let box = try AES.GCM.SealedBox(combined: ciphertext)
        var plain = try AES.GCM.open(box, using: currentKey(), authenticating: fieldAAD(field, id: id, date: date))
        defer { plain.resetBytes(in: 0..<plain.count) }
        return try unpadded(plain)
    }
    /// Unbound version 1 ciphertext. Only accepted while the migration is pending.
    static func openLegacy(_ ciphertext: Data) throws -> String {
        state.mutex.lock()
        let key = state.key, legacy = state.legacy, migrating = state.pending != nil
        state.mutex.unlock()
        guard let key else { throw DiaryCryptoError.locked }
        guard migrating else { throw DiaryCryptoError.invalidCiphertext }
        let box = try AES.GCM.SealedBox(combined: ciphertext)
        var plain: Data
        do { plain = try AES.GCM.open(box, using: key) }
        catch {
            guard let legacy else { throw error }
            plain = try AES.GCM.open(box, using: legacy)
        }
        defer { plain.resetBytes(in: 0..<plain.count) }
        guard let text = String(data: plain, encoding: .utf8) else { throw DiaryCryptoError.invalidUTF8 }
        return text
    }
    /// Length-prefixed and zero-padded so ciphertext size does not reveal the text length.
    private static func padded(_ text: String, field: Field) -> Data {
        var bytes = Array(text.utf8)
        defer { KeyDerivation.wipe(&bytes) }
        var size = field == .entryBody ? 1024 : 32
        while size < bytes.count + 4 { size *= 2 }
        var out = [UInt8](repeating: 0, count: size)
        defer { KeyDerivation.wipe(&out) }
        let count = bytes.count
        out[0] = UInt8(truncatingIfNeeded: count >> 24)
        out[1] = UInt8(truncatingIfNeeded: count >> 16)
        out[2] = UInt8(truncatingIfNeeded: count >> 8)
        out[3] = UInt8(truncatingIfNeeded: count)
        out.replaceSubrange(4..<(4 + count), with: bytes)
        return Data(out)
    }
    private static func unpadded(_ plain: Data) throws -> String {
        var bytes = [UInt8](plain)
        defer { KeyDerivation.wipe(&bytes) }
        guard bytes.count >= 4 else { throw DiaryCryptoError.invalidCiphertext }
        let count = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
        guard count <= bytes.count - 4 else { throw DiaryCryptoError.invalidCiphertext }
        guard let text = String(bytes: bytes[4..<(4 + count)], encoding: .utf8) else { throw DiaryCryptoError.invalidUTF8 }
        return text
    }

    private static func wrappingKey(_ secret: [UInt8], salt: Data) throws -> SymmetricKey {
        var bytes = try KeyDerivation.scrypt(secret, salt: Array(salt), n: scryptN, r: scryptR, p: scryptP, length: 32)
        defer { KeyDerivation.wipe(&bytes) }
        return SymmetricKey(data: bytes)
    }
    private static func randomSalt() throws -> Data {
        var salt = Data(count: 16)
        let status = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard status == errSecSuccess else { throw DiaryCryptoError.keychain(status) }
        return salt
    }
    /// Wraps the data key with scrypt, verifies it and replaces the envelope unless the diary was locked meanwhile.
    private static func writeEnvelope(_ raw: Data, phase: String, salt: Data, wrapping: SymmetricKey, wrappedLegacy: Data?, generation: Int) throws {
        let aad = envelopeAAD(phase, salt: salt)
        guard let combined = try AES.GCM.seal(raw, using: wrapping, authenticating: aad).combined else { throw DiaryCryptoError.invalidCiphertext }
        var verified = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: wrapping, authenticating: aad)
        defer { verified.resetBytes(in: 0..<verified.count) }
        guard verified == raw else { throw DiaryCryptoError.invalidKey }
        let encoded = try JSONEncoder().encode(Envelope(version: 3, iterations: nil, phase: phase, salt: salt, wrappedKey: combined, wrappedLegacyKey: wrappedLegacy))
        let url = try envelopeURL()
        state.mutex.lock()
        defer { state.mutex.unlock() }
        guard generation == state.generation else { throw DiaryCryptoError.locked }
        try encoded.write(to: url, options: [.atomic, .completeFileProtection])
    }
    private static func writePending(_ raw: Data, secret: [UInt8], wrappedLegacy: Data?, generation: Int) throws -> Pending {
        let salt = try randomSalt()
        let wrapping = try wrappingKey(secret, salt: salt)
        try writeEnvelope(raw, phase: pendingPhase, salt: salt, wrapping: wrapping, wrappedLegacy: wrappedLegacy, generation: generation)
        return Pending(wrapping: wrapping, salt: salt)
    }

    private static var legacyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.hixuanye.diary",
         kSecAttrAccount as String: "local-data-encryption-key-v1"]
    }
    private static func legacyKey(hasEncryptedRecords: Bool) throws -> SymmetricKey? {
        var query = legacyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else { throw DiaryCryptoError.invalidKey }
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else { throw DiaryCryptoError.keychain(status) }
        guard !hasEncryptedRecords else { throw DiaryCryptoError.missingKey }
        return nil
    }
    // Called on a worker task; the generation check prevents backgrounding from re-unlocking.
    static func unlock(password: String, hasLegacyRecords: Bool, hasSealedRecords: Bool) throws {
        state.mutex.lock()
        let generation = state.generation
        let allowed = Date() >= state.retryAt
        state.mutex.unlock()
        guard allowed else { throw NSError(domain: "Diary", code: 1, userInfo: [NSLocalizedDescriptionKey: "嘗試過於頻繁，請稍後再試（最長 30 秒）。"]) }
        do {
            guard !password.isEmpty, password.utf8.count <= 1024 else { throw DiaryCryptoError.password }
            var secret = Array(password.utf8)
            defer { KeyDerivation.wipe(&secret) }
            let url = try envelopeURL()
            let key: SymmetricKey
            var legacy: SymmetricKey?
            var migration: Pending?
            if FileManager.default.fileExists(atPath: url.path) {
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard (values.fileSize ?? Int.max) <= 4096 else { throw DiaryCryptoError.invalidCiphertext }
                let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
                guard envelope.salt.count == 16, envelope.wrappedKey.count == 60 else { throw DiaryCryptoError.invalidCiphertext }
                let box = try AES.GCM.SealedBox(combined: envelope.wrappedKey)
                var raw: Data
                if envelope.version == 2, envelope.phase == nil, envelope.iterations == pbkdf2Rounds {
                    var derived = try KeyDerivation.pbkdf2(secret, salt: Array(envelope.salt), rounds: pbkdf2Rounds, length: 32)
                    defer { KeyDerivation.wipe(&derived) }
                    raw = try AES.GCM.open(box, using: SymmetricKey(data: derived), authenticating: v2AAD + envelope.salt)
                } else if envelope.version == 3, let phase = envelope.phase,
                          phase == pendingPhase || (phase == completePhase && envelope.wrappedLegacyKey == nil) {
                    let wrapping = try wrappingKey(secret, salt: envelope.salt)
                    raw = try AES.GCM.open(box, using: wrapping, authenticating: envelopeAAD(phase, salt: envelope.salt))
                    if phase == pendingPhase { migration = Pending(wrapping: wrapping, salt: envelope.salt) }
                } else {
                    throw DiaryCryptoError.invalidCiphertext
                }
                defer { raw.resetBytes(in: 0..<raw.count) }
                guard raw.count == 32 else { throw DiaryCryptoError.invalidKey }
                key = SymmetricKey(data: raw)
                if let wrappedLegacy = envelope.wrappedLegacyKey {
                    var old = try AES.GCM.open(AES.GCM.SealedBox(combined: wrappedLegacy), using: key, authenticating: migrationAAD)
                    defer { old.resetBytes(in: 0..<old.count) }
                    guard old.count == 32 else { throw DiaryCryptoError.invalidKey }
                    legacy = SymmetricKey(data: old)
                }
                if envelope.version == 2 {
                    // Re-wrap the same data key with scrypt; the records are then migrated like a new setup.
                    migration = try writePending(raw, secret: secret, wrappedLegacy: envelope.wrappedLegacyKey, generation: generation)
                }
            } else {
                guard !hasSealedRecords else { throw DiaryCryptoError.missingEnvelope }
                if let problem = PasswordPolicy.problem(password) { throw DiaryCryptoError.weakPassword(problem) }
                legacy = try legacyKey(hasEncryptedRecords: hasLegacyRecords)
                key = SymmetricKey(size: .bits256)
                var raw = key.withUnsafeBytes { Data($0) }
                defer { raw.resetBytes(in: 0..<raw.count) }
                var wrappedLegacy: Data?
                if let legacy {
                    var old = legacy.withUnsafeBytes { Data($0) }
                    defer { old.resetBytes(in: 0..<old.count) }
                    wrappedLegacy = try AES.GCM.seal(old, using: key, authenticating: migrationAAD).combined
                    guard wrappedLegacy != nil else { throw DiaryCryptoError.invalidKey }
                }
                // Keep the legacy Keychain key until the database migration is committed.
                migration = try writePending(raw, secret: secret, wrappedLegacy: wrappedLegacy, generation: generation)
            }
            state.mutex.lock(); defer { state.mutex.unlock() }
            guard generation == state.generation else { throw DiaryCryptoError.locked }
            state.key = key; state.legacy = legacy; state.pending = migration
            state.failures = 0; state.retryAt = .distantPast
        } catch {
            state.mutex.lock()
            state.failures += 1
            state.retryAt = Date().addingTimeInterval(min(30, pow(2, Double(min(state.failures - 1, 5)))))
            state.mutex.unlock()
            if error is CryptoKitError { throw DiaryCryptoError.invalidCiphertext }
            throw error
        }
    }
    /// Only call after every record is re-encrypted and ModelContext.save succeeds.
    static func finishMigration() throws {
        state.mutex.lock()
        let key = state.key, migration = state.pending, generation = state.generation
        state.mutex.unlock()
        guard let key else { throw DiaryCryptoError.locked }
        guard let migration else { return }
        let status = SecItemDelete(legacyQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DiaryCryptoError.keychain(status) }
        var raw = key.withUnsafeBytes { Data($0) }
        defer { raw.resetBytes(in: 0..<raw.count) }
        // From now on unbound or plaintext records are rejected instead of migrated.
        try writeEnvelope(raw, phase: completePhase, salt: migration.salt, wrapping: migration.wrapping, wrappedLegacy: nil, generation: generation)
        state.mutex.lock(); state.legacy = nil; state.pending = nil; state.mutex.unlock()
    }
}
