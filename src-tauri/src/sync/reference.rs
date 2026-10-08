//! PLAN-A Work 서버의 Push 참조 검사(memo-sync-v1 "Native push validates URL-valued HTML attributes …")를
//! **Mock 서버가 흉내 내기 위한** 규칙. 실제 판정은 서버가 한다 — Desktop 은 이 결과로 본문을 고치지 않는다.
//!
//! * 검사하는 곳: URL 이 쓰이는 HTML 속성(href·src·srcset·poster·action·formaction·background·data·xlink:href·cite)과
//!   `style` 속성·`<style>` 의 CSS `url()`. 본문 **글자**(예: `profile:`, `C:\Users\…` 라는 설명)는 검사하지 않는다.
//! * 값은 HTML entity → URL percent-encoding → ASCII 제어 문자·공백 제거 순으로 풀어서 본다(CSS 는 escape 도 푼다).
//! * 거절: file:·드라이브(`C:\`, `C:/`)·UNC(`\\server`) → `local_path_not_allowed`,
//!   protocol-relative(`//host`)·blob·data·attachment 등 허용하지 않는 scheme → `reference_not_allowed`.
//! * 허용: http·https·mailto·tel(tel 은 서버 sanitizer 가 href 를 지운다)·상대 주소.

pub const LOCAL_PATH_NOT_ALLOWED: &str = "local_path_not_allowed";
pub const REFERENCE_NOT_ALLOWED: &str = "reference_not_allowed";

const URL_ATTRS: &[&str] = &["href", "src", "srcset", "poster", "action", "formaction", "background", "data", "xlink:href", "cite"];
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];

/// HTML 조각 하나를 검사한 결과.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Scan {
    /// 첫 번째 위반의 code(`local_path_not_allowed` | `reference_not_allowed`)
    pub violation: Option<&'static str>,
    /// `<img src>` 값(풀어 쓴 형태) — 서버는 소유한 개인 메모 이미지 주소만 받는다.
    pub image_sources: Vec<String>,
}

pub fn scan(html: &str) -> Scan {
    let mut out = Scan::default();
    let chars: Vec<char> = html.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '<' {
            i += 1;
            continue;
        }
        // 주석은 건너뛴다
        if chars[i..].starts_with(&['<', '!', '-', '-']) {
            i = find(&chars, i + 4, "-->").map(|p| p + 3).unwrap_or(chars.len());
            continue;
        }
        let Some(&next) = chars.get(i + 1) else { break };
        if !next.is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let (tag, attrs, end) = parse_tag(&chars, i + 1);
        for (name, value) in &attrs {
            let name = name.to_ascii_lowercase();
            if name == "style" {
                for url in css_urls(&decode_entities(value)) {
                    note(&mut out, classify(&url));
                }
            } else if name == "srcset" {
                for candidate in decode_entities(value).split(',') {
                    note(&mut out, classify(candidate.split_whitespace().next().unwrap_or_default()));
                }
            } else if URL_ATTRS.contains(&name.as_str()) {
                let decoded = decode_entities(value);
                note(&mut out, classify(&decoded));
                if tag == "img" && name == "src" {
                    out.image_sources.push(normalize(&decoded));
                }
            }
        }
        i = end;
        if tag == "style" {
            let close = find_ci(&chars, i, "</style").unwrap_or(chars.len());
            let css: String = chars[i..close].iter().collect();
            for url in css_urls(&css) {
                note(&mut out, classify(&url));
            }
            i = close;
        }
    }
    out
}

fn note(out: &mut Scan, verdict: Option<&'static str>) {
    if out.violation.is_none() {
        out.violation = verdict;
    }
}

/// `<` 다음부터 태그 이름·속성을 읽는다. (이름 소문자, 속성들, `>` 다음 위치)
fn parse_tag(chars: &[char], start: usize) -> (String, Vec<(String, String)>, usize) {
    let mut i = start;
    let mut tag = String::new();
    while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' && chars[i] != '/' {
        tag.push(chars[i].to_ascii_lowercase());
        i += 1;
    }
    let mut attrs = Vec::new();
    loop {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        if i >= chars.len() {
            return (tag, attrs, i);
        }
        if chars[i] == '>' {
            return (tag, attrs, i + 1);
        }
        let mut name = String::new();
        while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '=' | '>' | '/') {
            name.push(chars[i]);
            i += 1;
        }
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if chars.get(i) == Some(&'=') {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            match chars.get(i) {
                Some(&q) if q == '"' || q == '\'' => {
                    i += 1;
                    while i < chars.len() && chars[i] != q {
                        value.push(chars[i]);
                        i += 1;
                    }
                    i += 1;
                }
                _ => {
                    while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' {
                        value.push(chars[i]);
                        i += 1;
                    }
                }
            }
        }
        if !name.is_empty() {
            attrs.push((name, value));
        } else {
            i += 1; // 이상한 글자 하나 건너뜀
        }
    }
}

fn find(chars: &[char], from: usize, needle: &str) -> Option<usize> {
    let n: Vec<char> = needle.chars().collect();
    (from..chars.len()).find(|&p| chars[p..].starts_with(&n))
}

fn find_ci(chars: &[char], from: usize, needle: &str) -> Option<usize> {
    let n: Vec<char> = needle.chars().collect();
    (from..chars.len().saturating_sub(n.len() - 1)).find(|&p| chars[p..p + n.len()].iter().zip(&n).all(|(a, b)| a.eq_ignore_ascii_case(b)))
}

/// HTML entity(숫자·16진·자주 쓰는 이름)를 푼다. `;` 가 없어도 숫자 entity 는 푼다(브라우저와 같게).
pub fn decode_entities(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '&' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if chars.get(i + 1) == Some(&'#') {
            let hex = matches!(chars.get(i + 2), Some('x') | Some('X'));
            let mut j = i + 2 + hex as usize;
            let mut digits = String::new();
            while j < chars.len() && (if hex { chars[j].is_ascii_hexdigit() } else { chars[j].is_ascii_digit() }) {
                digits.push(chars[j]);
                j += 1;
            }
            if let Some(c) = u32::from_str_radix(&digits, if hex { 16 } else { 10 }).ok().and_then(char::from_u32) {
                out.push(c);
                i = j + (chars.get(j) == Some(&';')) as usize;
                continue;
            }
        } else {
            let mut j = i + 1;
            let mut name = String::new();
            while j < chars.len() && chars[j].is_ascii_alphanumeric() {
                name.push(chars[j]);
                j += 1;
            }
            let named = match name.to_ascii_lowercase().as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "colon" => Some(':'),
                "sol" => Some('/'),
                "bsol" => Some('\\'),
                "tab" => Some('\t'),
                "newline" => Some('\n'),
                "nbsp" => Some('\u{a0}'),
                _ => None,
            };
            if let (Some(c), Some(';')) = (named, chars.get(j)) {
                out.push(c);
                i = j + 1;
                continue;
            }
        }
        out.push('&');
        i += 1;
    }
    out
}

/// %XX 를 푼다(잘못된 % 는 그대로).
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 판정용 형태: percent 를 풀고 ASCII 제어 문자·공백을 모두 지운다(`java\tscript:` 같은 숨김 포함).
fn normalize(value: &str) -> String {
    percent_decode(value).chars().filter(|c| !(c.is_ascii_control() || *c == ' ' || *c == '\u{a0}')).collect()
}

/// CSS escape(`\66 ile:`, `\:`)를 풀고 `url(...)` 안의 값을 꺼낸다.
fn css_urls(css: &str) -> Vec<String> {
    let unescaped = css_unescape(css);
    let lower = unescaped.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("url(") {
        let start = from + pos + 4;
        let end = lower[start..].find(')').map(|e| start + e).unwrap_or(lower.len());
        let raw = unescaped[start..end].trim().trim_matches(|c| c == '"' || c == '\'');
        out.push(raw.to_string());
        from = end.min(lower.len());
        if from >= lower.len() {
            break;
        }
    }
    out
}

fn css_unescape(css: &str) -> String {
    let chars: Vec<char> = css.chars().collect();
    let mut out = String::with_capacity(css.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let mut j = i + 1;
            let mut hex = String::new();
            while j < chars.len() && hex.len() < 6 && chars[j].is_ascii_hexdigit() {
                hex.push(chars[j]);
                j += 1;
            }
            if !hex.is_empty() {
                if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    out.push(c);
                }
                if j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                i = j;
            } else {
                out.push(chars[i + 1]);
                i += 2;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 값 하나의 판정. None = 허용.
pub fn classify(raw: &str) -> Option<&'static str> {
    let value = normalize(&decode_entities(raw));
    let lower = value.to_ascii_lowercase();
    let b = lower.as_bytes();
    if lower.is_empty() {
        return None;
    }
    if lower.starts_with("file:") {
        return Some(LOCAL_PATH_NOT_ALLOWED);
    }
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\') {
        return Some(LOCAL_PATH_NOT_ALLOWED); // C: · C:\ · C:/
    }
    if b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\') {
        // \\server\share(UNC) / //host(protocol-relative)
        return Some(if b[0] == b'\\' || b[1] == b'\\' { LOCAL_PATH_NOT_ALLOWED } else { REFERENCE_NOT_ALLOWED });
    }
    if let Some(colon) = lower.find(':') {
        let scheme = &lower[..colon];
        let is_scheme = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        let before_path = !lower[..colon].contains(['/', '?', '#']);
        if is_scheme && before_path && !ALLOWED_SCHEMES.contains(&scheme) {
            return Some(REFERENCE_NOT_ALLOWED);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(html: &str) -> Option<&'static str> {
        scan(html).violation
    }

    /// PLAN_A_WORK_SYNC_HANDOFF.md §1-4 의 12개 사례 + memo-sync-v1.md 의 entity·percent·CSS escape·protocol-relative.
    #[test]
    fn follows_the_url_position_policy() {
        let allowed = [
            r#"<p><a href="https://example.com/docs">문서</a></p>"#,
            r#"<p><a href="http://intranet/wiki">위키</a> http://intranet/wiki 참고</p>"#,
            "<p>profile: 설정 확인</p>",
            "<p>10:30/11:00 회의, 비율 3:1</p>",
            r#"<img src="/api/personal-memos/images/ab12.png/download">"#,
            r"<p>경로는 C:\Users\me\a.png 입니다 \\fileserver\share 도 글자일 뿐</p>",
            r#"<a href="mailto:me@example.com">메일</a> <a href="tel:0101234">전화</a> <a href="./rel">상대</a>"#,
            r#"<table><tr><td style="width: 120px; color:#333">표</td></tr></table>"#,
            "<p>data:image 라는 글자, attachment:// 라는 글자</p>",
        ];
        for html in allowed {
            assert_eq!(verdict(html), None, "{html}");
        }
        let local = [
            r#"<img src="file:///C:/Users/me/a.png">"#,
            r#"<img src="C:\Users\me\a.png">"#,
            r#"<a href="C:/Users/me/a.docx">a</a>"#,
            r#"<a href="\\fileserver\share\a.xlsx">a</a>"#,
            r#"<a href="file&#58;///C:/a.txt">a</a>"#,
            r#"<a href="FILE:///x">a</a>"#,
            r#"<a href="  &#x09;file:///x">a</a>"#,
            r#"<a href="fi%6Ce:///x">a</a>"#,
            r#"<p style="background:url('file:///C:/a.png')">x</p>"#,
            r#"<p style="background:url(\66 ile:///C:/a.png)">x</p>"#,
            r#"<img srcset="/api/personal-memos/images/a.png/download 1x, C:\a.png 2x">"#,
            r#"<a href=C:\x>unquoted</a>"#,
        ];
        for html in local {
            assert_eq!(verdict(html), Some(LOCAL_PATH_NOT_ALLOWED), "{html}");
        }
        let reference = [
            r#"<a href="//evil.example/x">a</a>"#,
            r#"<img src="blob:https://x/1">"#,
            r#"<img src="data:image/png;base64,AAAA">"#,
            r#"<img src="attachment://6f1c0000-0000-0000-0000-000000000000">"#,
            r#"<a href="javascript:alert(1)">a</a>"#,
            r#"<a href="java&#x09;script:alert(1)">a</a>"#,
            r#"<style>p{background:url(//cdn.example/a.png)}</style>"#,
        ];
        for html in reference {
            assert_eq!(verdict(html), Some(REFERENCE_NOT_ALLOWED), "{html}");
        }
    }

    #[test]
    fn collects_image_sources_for_the_ownership_check() {
        let s = scan(r#"<p>a<img src="/api/personal-memos/images/a.png/download"><img alt=x src='https://cdn.example/b.png'></p>"#);
        assert_eq!(s.violation, None);
        assert_eq!(s.image_sources, vec!["/api/personal-memos/images/a.png/download", "https://cdn.example/b.png"]);
    }
}
