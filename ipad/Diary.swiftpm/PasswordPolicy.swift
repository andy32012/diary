import Foundation

/// Rejects easily guessed passwords for a new diary. Keep the rules and constants identical to windows/app/password-policy.js.
enum PasswordPolicy {
    static let minLength = 12
    static let minBits = 45.0
    private static let analyzed = 64
    private static let wordBits = 8.0
    private static let yearBits = 7.0
    private static let dayBits = 8.5
    private static let wordList: [String] = [
        "password", "passwd", "pass", "qwerty", "asdf", "zxcv", "qazwsx", "iloveyou", "love", "loveyou", "admin",
        "welcome", "letmein", "login", "monkey", "dragon", "sunshine", "princess", "football", "baseball", "soccer",
        "master", "hello", "freedom", "whatever", "trustno", "superman", "batman", "starwars", "shadow", "michael",
        "jennifer", "jordan", "hunter", "charlie", "secret", "diary", "mydiary", "test", "guest", "root", "user",
        "changeme", "default", "google", "apple", "iphone", "ipad", "windows", "computer", "internet", "taiwan",
        "japan", "tokyo", "sakura", "kitty", "angel", "baby", "cutie", "honey", "woaini", "wodemima", "mima", "nihao",
        "aini", "baobei", "laopo", "laogong", "abc", "abcd", "日記", "日记", "密碼", "密码", "我愛你", "我爱你", "寶貝", "宝贝", "老婆",
        "老公",
    ]
    private static let words = wordList.map { Array($0.unicodeScalars) }
    private static let leet: [Unicode.Scalar: Unicode.Scalar] = ["0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"]
    private static let shifted: [Unicode.Scalar: Unicode.Scalar] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
    ]
    private static let keys: [Unicode.Scalar: (row: Int, column: Int)] = {
        var keys: [Unicode.Scalar: (row: Int, column: Int)] = [:]
        for (row, line) in ["1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"].enumerated() {
            for (column, key) in line.unicodeScalars.enumerated() { keys[key] = (row, column) }
        }
        return keys
    }()

    /// A message for a password that should not protect a new diary, or nil.
    static func problem(_ password: String) -> String? {
        if password.unicodeScalars.count < minLength { return "請使用至少 12 個字元的長密碼。" }
        if estimateBits(password) < minBits {
            return "這個密碼太容易被猜到（例如連續數字、鍵盤連打、常見單字或年份）。建議用 4 個以上不相關的詞組成一句好記的話。"
        }
        return nil
    }

    /// Cheapest way to describe the password, in bits, from common guessing patterns.
    static func estimateBits(_ password: String) -> Double {
        let chars = Array(password.unicodeScalars.prefix(analyzed))
        let n = chars.count
        let plain = chars.map(lower)
        let leetChars = plain.map { leet[$0] ?? $0 }
        var best = [Double](repeating: .infinity, count: n + 1)
        best[0] = 0
        for i in 0..<n {
            let base = best[i]
            relax(&best, i + 1, base + charBits(chars[i]))
            for word in words where i + word.count <= n {
                let end = i + word.count
                let cased = chars[i..<end].contains(where: isUpper) ? 1.0 : 0.0
                if plain[i..<end].elementsEqual(word) {
                    relax(&best, end, base + wordBits + cased)
                } else if leetChars[i..<end].elementsEqual(word) {
                    relax(&best, end, base + wordBits + cased + 1)
                }
            }
            var run = i + 1
            while run < n && predictable(chars[run - 1], chars[run]) { run += 1 }
            if run >= i + 3 {
                for end in (i + 3)...run { relax(&best, end, base + charBits(chars[i]) + 1 + log2(Double(end - i))) }
            }
            if i + 4 <= n && chars[i..<(i + 4)].allSatisfy(isDigit) {
                let digits = chars[i..<(i + 4)].map { Int($0.value) - 48 }
                let month = digits[0] * 10 + digits[1], day = digits[2] * 10 + digits[3]
                if (digits[0] == 1 && digits[1] == 9) || (digits[0] == 2 && digits[1] == 0) { relax(&best, i + 4, base + yearBits) }
                if (1...12).contains(month) && (1...31).contains(day) { relax(&best, i + 4, base + dayBits) }
            }
        }
        return best[n]
    }

    private static func relax(_ best: inout [Double], _ index: Int, _ bits: Double) {
        if bits < best[index] { best[index] = bits }
    }
    private static func isDigit(_ c: Unicode.Scalar) -> Bool { c.value >= 48 && c.value <= 57 }
    private static func isUpper(_ c: Unicode.Scalar) -> Bool { c.value >= 65 && c.value <= 90 }
    private static func lower(_ c: Unicode.Scalar) -> Unicode.Scalar { isUpper(c) ? Unicode.Scalar(UInt8(c.value + 32)) : c }
    private static func charBits(_ c: Unicode.Scalar) -> Double {
        if isDigit(c) { return log2(10) }
        if isUpper(c) || (c.value >= 97 && c.value <= 122) { return log2(26) }
        if c.value >= 0x20 && c.value <= 0x7e { return log2(33) }
        return 8
    }
    private static func adjacentKeys(_ a: Unicode.Scalar, _ b: Unicode.Scalar) -> Bool {
        guard let p = keys[shifted[a] ?? lower(a)], let q = keys[shifted[b] ?? lower(b)] else { return false }
        let dr = q.row - p.row, dc = q.column - p.column
        return (dr == 0 && abs(dc) == 1) || (dr == -1 && (dc == 0 || dc == 1)) || (dr == 1 && (dc == 0 || dc == -1))
    }
    /// Repeats, alphabet/number sequences (9→0 wraps) and keyboard neighbours.
    private static func predictable(_ a: Unicode.Scalar, _ b: Unicode.Scalar) -> Bool {
        let x = lower(a), y = lower(b)
        if x == y { return true }
        if isDigit(x) && isDigit(y) && ((x == "9" && y == "0") || (x == "0" && y == "9")) { return true }
        if abs(Int(x.value) - Int(y.value)) == 1 { return true }
        return adjacentKeys(a, b)
    }
}
