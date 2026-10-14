import CommonCrypto
import Foundation

/// Password key derivation. Apple frameworks have no memory-hard KDF, so scrypt (RFC 7914) is implemented here.
enum KeyDerivation {
    static func pbkdf2(_ password: [UInt8], salt: [UInt8], rounds: Int, length: Int) throws -> [UInt8] {
        precondition(!password.isEmpty && !salt.isEmpty && length > 0)
        var output = [UInt8](repeating: 0, count: length)
        let status = password.withUnsafeBytes { pw in
            salt.withUnsafeBytes { saltBytes in
                output.withUnsafeMutableBytes { out in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.bindMemory(to: Int8.self).baseAddress!, pw.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress!, saltBytes.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds),
                        out.bindMemory(to: UInt8.self).baseAddress!, length)
                }
            }
        }
        guard status == kCCSuccess else {
            wipe(&output)
            throw DiaryCryptoError.invalidKey
        }
        return output
    }

    static func scrypt(_ password: [UInt8], salt: [UInt8], n: Int, r: Int, p: Int, length: Int) throws -> [UInt8] {
        precondition(n > 1 && n & (n - 1) == 0 && n <= 1 << 30 && r > 0 && p > 0)
        let words = 32 * r
        var b = try pbkdf2(password, salt: salt, rounds: 1, length: p * 128 * r)
        defer { wipe(&b) }
        let v = UnsafeMutablePointer<UInt32>.allocate(capacity: n * words)
        let x = UnsafeMutablePointer<UInt32>.allocate(capacity: words)
        let y = UnsafeMutablePointer<UInt32>.allocate(capacity: words)
        let t = UnsafeMutablePointer<UInt32>.allocate(capacity: 16)
        defer {
            for (pointer, count) in [(v, n * words), (x, words), (y, words), (t, 16)] {
                pointer.update(repeating: 0, count: count)
                pointer.deallocate()
            }
        }
        for chunk in 0..<p {
            let base = chunk * 128 * r
            for i in 0..<words {
                let at = base + 4 * i
                x[i] = UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
            }
            for i in 0..<n {
                (v + i * words).update(from: x, count: words)
                blockMix(x, y, t, r)
            }
            for _ in 0..<n {
                let j = Int(x[(2 * r - 1) * 16] & UInt32(n - 1))
                let row = v + j * words
                for k in 0..<words { x[k] ^= row[k] }
                blockMix(x, y, t, r)
            }
            for i in 0..<words {
                let at = base + 4 * i
                b[at] = UInt8(truncatingIfNeeded: x[i])
                b[at + 1] = UInt8(truncatingIfNeeded: x[i] >> 8)
                b[at + 2] = UInt8(truncatingIfNeeded: x[i] >> 16)
                b[at + 3] = UInt8(truncatingIfNeeded: x[i] >> 24)
            }
        }
        return try pbkdf2(password, salt: b, rounds: 1, length: length)
    }

    static func wipe(_ bytes: inout [UInt8]) {
        bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
    }

    /// BlockMix with Salsa20/8: x holds 2r 64-byte blocks; y and t are scratch space.
    private static func blockMix(_ x: UnsafeMutablePointer<UInt32>, _ y: UnsafeMutablePointer<UInt32>, _ t: UnsafeMutablePointer<UInt32>, _ r: Int) {
        t.update(from: x + (2 * r - 1) * 16, count: 16)
        for i in 0..<(2 * r) {
            let block = x + i * 16
            for k in 0..<16 { t[k] ^= block[k] }
            salsa20_8(t)
            (y + i * 16).update(from: t, count: 16)
        }
        for i in 0..<r {
            (x + i * 16).update(from: y + 2 * i * 16, count: 16)
            (x + (r + i) * 16).update(from: y + (2 * i + 1) * 16, count: 16)
        }
    }

    private static func salsa20_8(_ b: UnsafeMutablePointer<UInt32>) {
        var x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3], x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7]
        var x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11], x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15]
        var s: UInt32
        for _ in 0..<4 {
            // Columns.
            s = x0 &+ x12; x4 ^= s &<< 7 | s &>> 25
            s = x4 &+ x0; x8 ^= s &<< 9 | s &>> 23
            s = x8 &+ x4; x12 ^= s &<< 13 | s &>> 19
            s = x12 &+ x8; x0 ^= s &<< 18 | s &>> 14
            s = x5 &+ x1; x9 ^= s &<< 7 | s &>> 25
            s = x9 &+ x5; x13 ^= s &<< 9 | s &>> 23
            s = x13 &+ x9; x1 ^= s &<< 13 | s &>> 19
            s = x1 &+ x13; x5 ^= s &<< 18 | s &>> 14
            s = x10 &+ x6; x14 ^= s &<< 7 | s &>> 25
            s = x14 &+ x10; x2 ^= s &<< 9 | s &>> 23
            s = x2 &+ x14; x6 ^= s &<< 13 | s &>> 19
            s = x6 &+ x2; x10 ^= s &<< 18 | s &>> 14
            s = x15 &+ x11; x3 ^= s &<< 7 | s &>> 25
            s = x3 &+ x15; x7 ^= s &<< 9 | s &>> 23
            s = x7 &+ x3; x11 ^= s &<< 13 | s &>> 19
            s = x11 &+ x7; x15 ^= s &<< 18 | s &>> 14
            // Rows.
            s = x0 &+ x3; x1 ^= s &<< 7 | s &>> 25
            s = x1 &+ x0; x2 ^= s &<< 9 | s &>> 23
            s = x2 &+ x1; x3 ^= s &<< 13 | s &>> 19
            s = x3 &+ x2; x0 ^= s &<< 18 | s &>> 14
            s = x5 &+ x4; x6 ^= s &<< 7 | s &>> 25
            s = x6 &+ x5; x7 ^= s &<< 9 | s &>> 23
            s = x7 &+ x6; x4 ^= s &<< 13 | s &>> 19
            s = x4 &+ x7; x5 ^= s &<< 18 | s &>> 14
            s = x10 &+ x9; x11 ^= s &<< 7 | s &>> 25
            s = x11 &+ x10; x8 ^= s &<< 9 | s &>> 23
            s = x8 &+ x11; x9 ^= s &<< 13 | s &>> 19
            s = x9 &+ x8; x10 ^= s &<< 18 | s &>> 14
            s = x15 &+ x14; x12 ^= s &<< 7 | s &>> 25
            s = x12 &+ x15; x13 ^= s &<< 9 | s &>> 23
            s = x13 &+ x12; x14 ^= s &<< 13 | s &>> 19
            s = x14 &+ x13; x15 ^= s &<< 18 | s &>> 14
        }
        b[0] = b[0] &+ x0; b[1] = b[1] &+ x1; b[2] = b[2] &+ x2; b[3] = b[3] &+ x3
        b[4] = b[4] &+ x4; b[5] = b[5] &+ x5; b[6] = b[6] &+ x6; b[7] = b[7] &+ x7
        b[8] = b[8] &+ x8; b[9] = b[9] &+ x9; b[10] = b[10] &+ x10; b[11] = b[11] &+ x11
        b[12] = b[12] &+ x12; b[13] = b[13] &+ x13; b[14] = b[14] &+ x14; b[15] = b[15] &+ x15
    }
}
