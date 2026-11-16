use globset::{GlobBuilder, GlobMatcher};
use oxc::diagnostics::OxcDiagnostic;
use oxc_ast::ast::Comment;
use oxc_span::Span;
use std::path::Path;

#[derive(Default)]
pub struct Directives {
    ignored_lines: Vec<Span>,
    pub inputs: Vec<GlobMatcher>,
}

pub fn is_directive(comment: &Comment, source: &str) -> bool {
    comment
        .content_span()
        .source_text(source)
        .trim()
        .starts_with("sovra-")
}

impl Directives {
    pub fn parse(comments: &[Comment], source: &str) -> (Self, Vec<OxcDiagnostic>) {
        let mut directives = Self::default();
        let mut errors = Vec::new();
        for comment in comments
            .iter()
            .filter(|comment| is_directive(comment, source))
        {
            let text = comment.content_span().source_text(source).trim();
            let text = text
                .split_once(" -- ")
                .map_or(text, |(directive, _)| directive)
                .trim();
            let (name, argument) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
            let argument = argument.trim();
            let error = match name {
                "sovra-ignore-next-line" if argument.is_empty() => {
                    if let Some(line) = next_line(source, comment.span.end as usize) {
                        directives.ignored_lines.push(line);
                    }
                    None
                }
                "sovra-depends-on" if !argument.is_empty() => {
                    if Path::new(argument).is_absolute()
                        || argument.starts_with('!')
                        || argument.contains(':')
                    {
                        Some("sovra-depends-on expects a relative file path or glob, without negation".to_string())
                    } else {
                        match GlobBuilder::new(argument.trim_start_matches("./"))
                            .literal_separator(true)
                            .backslash_escape(true)
                            .build()
                        {
                            Ok(glob) => {
                                directives.inputs.push(glob.compile_matcher());
                                None
                            }
                            Err(error) => Some(format!("Invalid sovra-depends-on glob: {error}")),
                        }
                    }
                }
                "sovra-depends-on" => {
                    Some("sovra-depends-on requires a file path or glob".to_string())
                }
                "sovra-ignore-next-line" => Some(
                    "sovra-ignore-next-line takes no arguments; use ` -- ` for a reason"
                        .to_string(),
                ),
                _ => Some(format!("Unknown Sovra directive: {name}")),
            };
            if let Some(message) = error {
                errors.push(OxcDiagnostic::error(message).with_label(comment.span));
            }
        }
        (directives, errors)
    }

    pub fn ignores(&self, span: Span) -> bool {
        self.ignored_lines
            .iter()
            .any(|line| line.start <= span.start && span.start < line.end)
    }
}

/// Source spans use UTF-8 byte offsets; CRLF is one physical line ending.
fn next_line(source: &str, after: usize) -> Option<Span> {
    let is_newline = ['\n', '\r', '\u{2028}', '\u{2029}'];
    let end = after + source[after..].find(is_newline)?;
    let mut start = end + source[end..].chars().next()?.len_utf8();
    if source[end..].starts_with("\r\n") {
        start += 1;
    }
    let end = source[start..]
        .find(is_newline)
        .map_or(source.len(), |length| start + length);
    Some(Span::new(start as u32, end as u32))
}
