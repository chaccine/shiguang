//! 极简 JSON（仅整数数字）读写，用于本地状态文件与 evidence manifest。

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn obj(entries: Vec<(&str, Json)>) -> Json {
        Json::Obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
    pub fn str<S: Into<String>>(s: S) -> Json {
        Json::Str(s.into())
    }
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn dump(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    pub fn pretty(&self) -> String {
        let mut out = String::new();
        self.write_pretty(&mut out, 0);
        out.push('\n');
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => out.push_str(&n.to_string()),
            Json::Str(s) => write_str(out, s),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    fn write_pretty(&self, out: &mut String, depth: usize) {
        let pad = |out: &mut String, n: usize| {
            out.push('\n');
            for _ in 0..n {
                out.push_str("  ");
            }
        };
        match self {
            Json::Arr(items) if !items.is_empty() => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    item.write_pretty(out, depth + 1);
                }
                pad(out, depth);
                out.push(']');
            }
            Json::Obj(entries) if !entries.is_empty() => {
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    write_str(out, k);
                    out.push_str(": ");
                    v.write_pretty(out, depth + 1);
                }
                pad(out, depth);
                out.push('}');
            }
            other => other.write(out),
        }
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn parse(input: &str) -> Result<Json, String> {
    let mut p = Parser {
        bytes: input.as_bytes(),
        pos: 0,
    };
    let value = p.value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(format!("JSON 末尾存在多余内容（byte {}）", p.pos));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\n' | b'\r' | b'\t') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) -> Result<u8, String> {
        let b = self
            .peek()
            .ok_or_else(|| "JSON 意外结束".to_string())?;
        self.pos += 1;
        Ok(b)
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        let b = self.bump()?;
        if b != expected {
            return Err(format!(
                "JSON 期望 '{}'，实际 '{}'（byte {}）",
                expected as char, b as char, self.pos - 1
            ));
        }
        Ok(())
    }

    fn literal(&mut self, text: &str) -> Result<(), String> {
        if self.bytes[self.pos..].starts_with(text.as_bytes()) {
            self.pos += text.len();
            Ok(())
        } else {
            Err(format!("JSON 无法识别字面量（byte {}）", self.pos))
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => {
                self.literal("true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(Json::Bool(false))
            }
            Some(b'n') => {
                self.literal("null")?;
                Ok(Json::Null)
            }
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            _ => Err(format!("JSON 非预期字符（byte {}）", self.pos)),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key_pos = self.pos;
            let key = self.string()?;
            if entries.iter().any(|(existing, _)| existing == &key) {
                return Err(format!("JSON 对象存在重复键 {key}（byte {key_pos}）"));
            }
            self.skip_ws();
            self.expect(b':')?;
            let value = self.value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.bump()? {
                b',' => continue,
                b'}' => break,
                _ => return Err(format!("JSON 对象缺少 ',' 或 '}}'（byte {}）", self.pos)),
            }
        }
        Ok(Json::Obj(entries))
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.bump()? {
                b',' => continue,
                b']' => break,
                _ => return Err(format!("JSON 数组缺少 ',' 或 ']'（byte {}）", self.pos)),
            }
        }
        Ok(Json::Arr(items))
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "JSON 数字编码错误".to_string())?;
        if text.is_empty() || text == "-" {
            return Err("JSON 数字为空".to_string());
        }
        text.parse::<i64>()
            .map(Json::Num)
            .map_err(|_| format!("JSON 仅支持 64 位整数：{text}"))
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let b = self.bump()?;
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let esc = self.bump()?;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xd800..=0xdbff).contains(&cp) {
                                if self.bump()? != b'\\' || self.bump()? != b'u' {
                                    return Err("JSON 高代理项缺少低代理项".to_string());
                                }
                                let low = self.hex4()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err("JSON 低代理项无效".to_string());
                                }
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                            }
                            out.push(
                                char::from_u32(cp)
                                    .ok_or_else(|| "JSON Unicode 转义无效".to_string())?,
                            );
                        }
                        _ => return Err("JSON 非法转义".to_string()),
                    }
                }
                0x00..=0x1f => return Err("JSON 字符串含未转义控制字符".to_string()),
                _ => {
                    let start = self.pos - 1;
                    let rest = std::str::from_utf8(&self.bytes[start..])
                        .map_err(|_| "JSON 字符串不是有效 UTF-8".to_string())?;
                    let ch = rest
                        .chars()
                        .next()
                        .ok_or_else(|| "JSON 字符串截断".to_string())?;
                    out.push(ch);
                    self.pos = start + ch.len_utf8();
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let b = self.bump()?;
            let digit = match b {
                b'0'..=b'9' => (b - b'0') as u32,
                b'a'..=b'f' => (b - b'a' + 10) as u32,
                b'A'..=b'F' => (b - b'A' + 10) as u32,
                _ => return Err("JSON Unicode 转义含非十六进制字符".to_string()),
            };
            value = value * 16 + digit;
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let value = Json::obj(vec![
            ("a", Json::Num(1)),
            ("b", Json::str("x\"y\n中")),
            ("c", Json::Arr(vec![Json::Null, Json::Bool(true)])),
        ]);
        let text = value.dump();
        assert_eq!(parse(&text).unwrap(), value);
    }

    #[test]
    fn pretty_is_valid() {
        let value = Json::obj(vec![("k", Json::Arr(vec![Json::Num(1), Json::Num(-2)]))]);
        let pretty = value.pretty();
        assert!(pretty.contains("\n"));
        assert_eq!(parse(&pretty).unwrap(), value);
    }

    #[test]
    fn rejects_floats_and_trailing_garbage() {
        assert!(parse("1.5").is_err());
        assert!(parse("{} x").is_err());
        assert!(parse("{\"a\":}").is_err());
    }

    #[test]
    fn rejects_duplicate_keys() {
        let err = parse("{\"a\":1,\"a\":2}").unwrap_err();
        assert!(err.contains("重复键"), "{err}");
        assert!(err.contains('a'), "{err}");
        assert!(err.contains("byte"), "{err}");
        // 嵌套对象同样拒绝
        assert!(parse("{\"a\":{\"b\":1,\"b\":2}}").is_err());
        // 不同键不受影响
        assert!(parse("{\"a\":1,\"b\":2}").is_ok());
    }
}
