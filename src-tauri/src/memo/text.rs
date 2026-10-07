//! 메모 HTML → 평문.
//!
//! PLAN-A Work 서버(`personal_memo_export.py`)의 두 변환을 그대로 옮겼다.
//!
//! * `search_text` — 검색용 '보이는 글자'. 인라인 서식 경계는 이어 붙이고(A<b>W</b>S = AWS),
//!   그 밖의 태그(문단·줄바꿈·표 칸·이미지)는 공백으로 띄운다.
//! * `plain_text` — 내보내기(txt/csv)용. 줄 구조를 살리고 이미지 수를 센다.
//!
//! 스크립트·스타일 안의 글자는 버린다.

const INLINE_TAGS: &[&str] =
    &["span", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "a", "code", "font", "mark", "small", "sub", "sup", "abbr"];
const BLOCK_TAGS: &[&str] = &["p", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "ul", "ol"];

#[derive(Debug)]
enum Token {
    Start(String),
    End(String),
    Text(String),
}

fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let end = after[1..].find(|c: char| c == ';' || c == '&' || c.is_whitespace() || c == '<').map(|i| i + 1);
        if let Some(end) = end.filter(|&e| after.as_bytes().get(e) == Some(&b';') && e <= 12) {
            let name = &after[1..end];
            let decoded = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ if name.starts_with("#x") || name.starts_with("#X") => u32::from_str_radix(&name[2..], 16).ok().and_then(char::from_u32),
                _ if name.starts_with('#') => name[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(c) = decoded {
                out.push(c);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &after[1..];
    }
    out.push_str(rest);
    out
}

fn tokenize(html: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    let mut skip_until: Option<String> = None;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // 주석
        if html[i..].starts_with("<!--") {
            if skip_until.is_none() && i > text_start {
                tokens.push(Token::Text(decode_entities(&html[text_start..i])));
            }
            let end = html[i + 4..].find("-->").map(|p| i + 4 + p + 3).unwrap_or(bytes.len());
            i = end;
            text_start = i;
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(b' ');
        if !(next.is_ascii_alphabetic() || next == b'/' || next == b'!') {
            i += 1;
            continue;
        }
        // 태그 끝(따옴표 안의 > 는 건너뛴다)
        let mut j = i + 1;
        let mut quote: Option<u8> = None;
        while j < bytes.len() {
            let b = bytes[j];
            match quote {
                Some(q) if b == q => quote = None,
                Some(_) => {}
                None if b == b'"' || b == b'\'' => quote = Some(b),
                None if b == b'>' => break,
                None => {}
            }
            j += 1;
        }
        let inner = &html[i + 1..j.min(bytes.len())];
        let closing = inner.starts_with('/');
        let name: String =
            inner.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
        if let Some(waiting) = &skip_until {
            if closing && &name == waiting {
                skip_until = None;
                tokens.push(Token::End(name));
            }
            i = j + 1;
            text_start = i;
            continue;
        }
        if i > text_start {
            tokens.push(Token::Text(decode_entities(&html[text_start..i])));
        }
        if !name.is_empty() {
            if closing {
                tokens.push(Token::End(name));
            } else {
                if name == "script" || name == "style" {
                    skip_until = Some(name.clone());
                }
                let self_closing = inner.trim_end().ends_with('/');
                tokens.push(Token::Start(name.clone()));
                if self_closing {
                    tokens.push(Token::End(name));
                }
            }
        }
        i = j + 1;
        text_start = i;
    }
    if skip_until.is_none() && text_start < bytes.len() {
        tokens.push(Token::Text(decode_entities(&html[text_start..])));
    }
    tokens
}

/// 검색 판정·미리보기에 쓰는 한 줄 평문(연속 공백 하나로, NBSP 도 공백).
pub fn search_text(html: &str) -> String {
    let mut parts = String::new();
    for token in tokenize(html) {
        match token {
            Token::Start(name) | Token::End(name) => {
                if !INLINE_TAGS.contains(&name.as_str()) {
                    parts.push(' ');
                }
            }
            Token::Text(text) => parts.push_str(&text),
        }
    }
    parts.replace('\u{a0}', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 내보내기용 (평문, 이미지 수). 줄 끝 공백과 연속 빈 줄은 정리한다.
pub fn plain_text(html: &str) -> (String, usize) {
    let mut parts: Vec<String> = Vec::new();
    let mut images = 0;
    let newline = |parts: &mut Vec<String>| {
        if parts.last().map(|p| !p.ends_with('\n')).unwrap_or(false) {
            parts.push("\n".into());
        }
    };
    for token in tokenize(html) {
        match token {
            Token::Start(name) => match name.as_str() {
                "script" | "style" => {}
                "img" => images += 1,
                "br" => parts.push("\n".into()),
                "li" => {
                    newline(&mut parts);
                    parts.push("- ".into());
                }
                "td" | "th" => {
                    if parts.last().map(|p| !p.ends_with('\n') && !p.ends_with("| ")).unwrap_or(false) {
                        parts.push(" | ".into());
                    }
                }
                n if BLOCK_TAGS.contains(&n) => newline(&mut parts),
                _ => {}
            },
            Token::End(name) => {
                if BLOCK_TAGS.contains(&name.as_str()) || name == "li" {
                    newline(&mut parts);
                }
            }
            Token::Text(text) => parts.push(text.replace('\u{a0}', " ")),
        }
    }
    let joined = parts.concat();
    let mut out: Vec<&str> = Vec::new();
    for line in joined.split('\n').map(str::trim_end) {
        if line.is_empty() && out.last().map(|l| l.is_empty()).unwrap_or(true) {
            continue;
        }
        out.push(line);
    }
    while out.last().map(|l| l.is_empty()).unwrap_or(false) {
        out.pop();
    }
    (out.join("\n"), images)
}

/// 본문이 참조하는 로컬 첨부 id(attachment://<uuid>) — 중복 없이 나온 순서대로.
pub fn attachment_ids(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find("attachment://") {
        let tail = &rest[pos + "attachment://".len()..];
        let candidate: String = tail.chars().take(36).collect();
        if crate::util::is_uuid(&candidate) {
            let id = candidate.to_lowercase();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        rest = &tail[tail.len().min(1)..];
    }
    ids
}

/// 문자열을 검색 단어로(소문자, 공백 분리, 최대 8개).
pub fn search_tokens(query: &str) -> Vec<String> {
    query.split_whitespace().map(|t| t.to_lowercase()).filter(|t| !t.is_empty()).take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_text_joins_inline_and_splits_blocks() {
        assert_eq!(search_text("A<strong>W</strong>S"), "AWS");
        assert_eq!(search_text("<p>A</p><p>WS</p>"), "A WS");
        assert_eq!(search_text("<table><tr><td>A</td><td>WS</td></tr></table>"), "A WS");
        assert_eq!(search_text("A<br>WS"), "A WS");
        assert_eq!(search_text("A<img src=\"attachment://x\">WS"), "A WS");
        assert_eq!(search_text("회의&nbsp;준비 &amp; 메일 &#54620;"), "회의 준비 & 메일 한");
        assert_eq!(search_text("<script>alert(1)</script>보이는 글"), "보이는 글");
        assert_eq!(search_text("a < b and c > d"), "a < b and c > d");
    }

    #[test]
    fn plain_text_keeps_lines_and_counts_images() {
        let (text, images) =
            plain_text("<p>첫 줄</p><ul><li>하나</li><li>둘</li></ul><img src=\"x\"><table><tr><td>a</td><td>b</td></tr></table>");
        assert_eq!(text, "첫 줄\n- 하나\n- 둘\na | b");
        assert_eq!(images, 1);
        assert_eq!(plain_text("줄1<br>줄2").0, "줄1\n줄2");
    }

    #[test]
    fn attachment_ids_are_extracted_once() {
        let id = "6f1c2b9e-1111-4222-8333-944455556666";
        let html = format!("<img src=\"attachment://{id}\"><img src=\"attachment://{id}\"><img src=\"attachment://bad\">");
        assert_eq!(attachment_ids(&html), vec![id.to_string()]);
    }
}
