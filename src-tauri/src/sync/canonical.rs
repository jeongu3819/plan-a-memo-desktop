//! 내용 비교용 HTML 정규형 — **비교(digest)에만 쓴다.** 저장·전송 본문은 바꾸지 않는다.
//!
//! 서버는 Push 본문을 sanitizer 로 다시 직렬화해 저장한다. Staging 에서 실제로 본 차이:
//! `style="width: 572px; height: auto;"` → `style="width: 572px; height: auto"`.
//! 이런 표현 차이로 같은 메모를 '내용이 다르다' 고 판단하지 않도록, 뜻이 같은 것이 확실한 표현만 맞춘다.
//!
//! 맞추는 것: 태그·속성 이름 대소문자, 속성 순서·따옴표, void 태그의 `/`, 숫자·이름 entity 표기, CRLF, 주석,
//!           `style` 의 끝 `;`·공백·속성 이름 대소문자, 빈 `style`/`class`.
//! 맞추지 않는 것: 글자, 공백 개수·NBSP(본문은 pre-wrap 으로 그려져 보이는 차이다), 줄바꿈·빈 문단, 태그 구조,
//!           서식 태그(`b` ≠ `strong`), 속성 값, 이미지 주소 — 애매하면 다른 내용으로 두어 비교 화면으로 보낸다.

use crate::memo::text::decode_entities;

pub fn canonical_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if html[i..].starts_with("<!--") {
            push_text(&mut out, &html[text_start..i]);
            i = html[i + 4..].find("-->").map(|p| i + 4 + p + 3).unwrap_or(bytes.len());
            text_start = i;
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(b' ');
        if !(next.is_ascii_alphabetic() || next == b'/') {
            i += 1; // 태그가 아닌 '<' 는 글자
            continue;
        }
        let Some(end) = tag_end(bytes, i + 1) else { break }; // 닫히지 않은 태그 — 뒤는 글자로 둔다
        push_text(&mut out, &html[text_start..i]);
        push_tag(&mut out, &html[i + 1..end]);
        i = end + 1;
        text_start = i;
    }
    push_text(&mut out, &html[text_start..]);
    out
}

/// 따옴표 안의 `>` 를 건너뛰고 태그 끝 위치를 찾는다.
fn tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (offset, &b) in bytes[from..].iter().enumerate() {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return Some(from + offset),
            None => {}
        }
    }
    None
}

fn push_text(out: &mut String, raw: &str) {
    for c in decode_entities(raw).replace("\r\n", "\n").chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

fn push_tag(out: &mut String, inner: &str) {
    if let Some(closing) = inner.strip_prefix('/') {
        out.push_str("</");
        out.push_str(&closing.trim().to_ascii_lowercase());
        out.push('>');
        return;
    }
    let name_end = inner.find(|c: char| c.is_ascii_whitespace() || c == '/').unwrap_or(inner.len());
    out.push('<');
    out.push_str(&inner[..name_end].to_ascii_lowercase());
    let mut attributes = parse_attributes(&inner[name_end..]);
    attributes.sort_by(|a, b| a.0.cmp(&b.0)); // 안정 정렬 — 같은 이름은 먼저 쓴 값이 앞(HTML 도 첫 값을 쓴다)
    attributes.dedup_by(|later, first| later.0 == first.0);
    for (name, value) in attributes {
        let value = if name == "style" { canonical_style(&value) } else { value };
        if value.is_empty() && matches!(name.as_str(), "style" | "class") {
            continue;
        }
        out.push(' ');
        out.push_str(&name);
        out.push_str("=\"");
        out.push_str(&value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;"));
        out.push('"');
    }
    out.push('>'); // '/' 는 읽지 않으므로 `<br/>` 와 `<br>` 가 같아진다.
}

/// `name`, `name=value`, `name="value"`, `name='value'` — 값은 entity 를 풀어 돌려준다.
fn parse_attributes(raw: &str) -> Vec<(String, String)> {
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() {
            return out;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b'/' {
            i += 1;
        }
        let name = raw[start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let (from, to) = match bytes.get(i) {
                Some(&q) if q == b'"' || q == b'\'' => {
                    let from = i + 1;
                    let to = bytes[from..].iter().position(|&b| b == q).map(|p| from + p).unwrap_or(bytes.len());
                    i = (to + 1).min(bytes.len());
                    (from, to)
                }
                _ => {
                    let from = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    (from, i)
                }
            };
            value = decode_entities(&raw[from..to]).replace("\r\n", "\n");
        }
        if name.is_empty() {
            i += 1; // '=' 로 시작하는 깨진 속성 — 건너뛴다(같은 입력이면 같은 결과)
            continue;
        }
        out.push((name, value));
    }
}

/// `width: 572px; height: auto;` → `width:572px;height:auto`. 선언 순서·값(대소문자 포함)은 그대로 둔다.
fn canonical_style(value: &str) -> String {
    let mut declarations = Vec::new();
    for declaration in split_outside_quotes(value, ';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        match declaration.split_once(':') {
            Some((name, value)) => declarations.push(format!("{}:{}", name.trim().to_ascii_lowercase(), css_value(value))),
            None => declarations.push(declaration.to_string()),
        }
    }
    declarations.join(";")
}

/// CSS 값의 공백만 맞춘다 — 연속 공백 하나로, 쉼표·괄호 옆 공백 제거. 따옴표 안은 그대로.
fn css_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut quote: Option<char> = None;
    let mut pending_space = false;
    for c in value.trim().chars() {
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        if c.is_ascii_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !matches!(c, ',' | ')') && !out.ends_with([',', '(']) {
            out.push(' ');
        }
        pending_space = false;
        if c == '"' || c == '\'' {
            quote = Some(c);
        }
        out.push(c);
    }
    out
}

fn split_outside_quotes(value: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut quote, mut depth, mut start) = (None, 0i32, 0);
    for (index, c) in value.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '(' => depth += 1,
            None if c == ')' => depth -= 1,
            None if c == separator && depth <= 0 => {
                parts.push(&value[start..index]);
                start = index + c.len_utf8();
            }
            None => {}
        }
    }
    parts.push(&value[start..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::canonical_html as canon;

    fn same(a: &str, b: &str) {
        assert_eq!(canon(a), canon(b), "같은 내용이어야 한다:\n  {a}\n  {b}");
    }

    fn different(a: &str, b: &str) {
        assert_ne!(canon(a), canon(b), "다른 내용이어야 한다:\n  {a}\n  {b}");
    }

    #[test]
    fn staging_sanitizer_output_is_the_same_content() {
        // 실제 Staging 비교 화면에 저장돼 있던 두 본문(이미지 id 만 바꿈) — 이 차이 하나로 충돌창이 떴다.
        same(
            "경로에서 내용 업데이트<br>-&gt; 내용 입력<div><img src=\"attachment://265c8b19\" alt=\"붙여넣은 이미지\" style=\"width: 572px; height: auto;\"><br></div>",
            "경로에서 내용 업데이트<br>-&gt; 내용 입력<div><img src=\"attachment://265c8b19\" alt=\"붙여넣은 이미지\" style=\"width: 572px; height: auto\"><br></div>",
        );
        same("<span style=\"color: rgb(1, 2, 3);\">글</span>", "<span style=\"color:rgb(1,2,3)\">글</span>");
    }

    #[test]
    fn serialization_differences_are_ignored() {
        same("<a href=\"x\" rel=\"y\">글</a>", "<a rel='y' href=x>글</a>");
        same("<BR>", "<br/>");
        same("한<br />줄", "한<br>줄");
        same("A&amp;B &#60;c&#x3E; &quot;", "A&#38;B &lt;c&gt; \"");
        same("a\r\nb", "a\nb");
        same("글<!--StartFragment-->자", "글자");
        same("<p style=\"\" class=\"\">글</p>", "<p>글</p>");
        same("<p style=\"COLOR : red ;; \">글</p>", "<p style=\"color:red\">글</p>");
        same("<a title=\"a&amp;b\">글</a>", "<a title=\"a&#38;b\">글</a>");
        same("<img alt=\"그림\" src=\"/a/download\" style=\"width: 572px; height: auto;\">", "<img src=/a/download style='width: 572px; height: auto' alt=그림 />");
        same("한&nbsp;칸", "한\u{a0}칸");
        same("<a href=\"/a?x=1&amp;y=2\">글</a>", "<a href=\"/a?x=1&#38;y=2\">글</a>");
    }

    #[test]
    fn real_differences_stay_different() {
        different("글자", "글 자");
        different("한 칸", "한  칸"); // 본문은 pre-wrap — 공백 개수가 보인다
        different("한 칸", "한\u{a0}칸");
        different("한<br>줄", "한줄");
        different("<p><br></p>", "<p></p>");
        different("<b>글</b>", "글");
        different("<b>글</b>", "<strong>글</strong>");
        different("<span style=\"color: red\">글</span>", "<span style=\"color: blue\">글</span>");
        different("<span style=\"color: red\">글</span>", "글");
        different("<img src=\"/a/download\" style=\"width: 10px\">", "<img src=\"/b/download\" style=\"width: 10px\">");
        different("<img src=\"/a/download\" style=\"width: 10px\">", "<img src=\"/a/download\" style=\"width: 20px\">");
        different("<img src=\"/a/download\">", "");
        different("<ol><li>글</li></ol>", "<ul><li>글</li></ul>");
        different("<span style=\"font-family: 'A  B'\">글</span>", "<span style=\"font-family: 'A B'\">글</span>");
        different("<span data-text-size=\"18\">글</span>", "<span data-text-size=\"normal\">글</span>");
        different("<img src=\"/a/download\" alt=\"첫째\">", "<img src=\"/a/download\" alt=\"둘째\">");
        different("<a href=\"/a\">글</a>", "<a href=\"/b\">글</a>");
        different("<span style=\"color: red\">글</span>", "<span style=\"color: red; font-weight: 700\">글</span>");
        different("<p>하나</p><p>둘</p>", "<p>둘</p><p>하나</p>");
        different("<u>글</u>", "<s>글</s>");
    }

    #[test]
    fn broken_html_is_handled_without_panic_and_stays_stable() {
        for broken in ["<", "a < b", "<img src=\"x", "<a href=", "</", "<!-- 열림", "<p =x>글", "한글<\u{d55c}", "&#xZZ;", "<br/"] {
            assert_eq!(canon(broken), canon(broken));
        }
        same("a < b", "a &lt; b");
    }
}
