//! Expands span edges to whole words, following the vendor's snapping rule.

use super::merge::merge_same_label;
use crate::span::Span;

const CONNECTORS: [char; 3] = ['-', '\'', '\u{2019}'];

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

fn char_before(text: &str, pos: usize) -> Option<char> {
    text[..pos].chars().next_back()
}

fn char_at(text: &str, pos: usize) -> Option<char> {
    text[pos..].chars().next()
}

fn snap_one(text: &str, start: usize, end: usize) -> (usize, usize) {
    let n = text.len();
    let mut s = start.min(n);
    let mut e = end.min(n);
    while !text.is_char_boundary(s) {
        s -= 1;
    }
    while !text.is_char_boundary(e) {
        e += 1;
    }
    loop {
        match char_before(text, s) {
            Some(c) if is_word_char(c) => s -= c.len_utf8(),
            Some(c) if CONNECTORS.contains(&c) => {
                let before_connector = s - c.len_utf8();
                match char_before(text, before_connector) {
                    Some(prev) if is_word_char(prev) => s = before_connector,
                    _ => break,
                }
            }
            _ => break,
        }
    }
    loop {
        match char_at(text, e) {
            Some(c) if is_word_char(c) => e += c.len_utf8(),
            Some(c) if CONNECTORS.contains(&c) => {
                let after_connector = e + c.len_utf8();
                match char_at(text, after_connector) {
                    Some(next) if is_word_char(next) => e = after_connector,
                    _ => break,
                }
            }
            _ => break,
        }
    }
    (s, e)
}

/// Snaps every span to word boundaries and merges spans that now overlap.
pub(crate) fn snap_to_words(text: &str, spans: Vec<Span>) -> Vec<Span> {
    let snapped = spans
        .into_iter()
        .map(|span| {
            let (start, end) = snap_one(text, span.start, span.end);
            Span { start, end, ..span }
        })
        .collect();
    merge_same_label(snapped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::label::Label;

    fn span(start: usize, end: usize, label: Label) -> Span {
        Span {
            start,
            end,
            label,
            confidence: 0.9,
        }
    }

    fn snapped(text: &str, start: usize, end: usize) -> &str {
        let (s, e) = snap_one(text, start, end);
        &text[s..e]
    }

    #[test]
    fn partial_word_expands_to_the_word() {
        assert_eq!(snapped("Jan Kowalski mieszka", 6, 9), "Kowalski");
        assert_eq!(snapped("Jan Kowalski mieszka", 4, 12), "Kowalski");
    }

    #[test]
    fn connectors_between_word_chars_are_included_but_dangling_ones_are_not() {
        assert_eq!(snapped("Anne-Marie", 0, 3), "Anne-Marie");
        assert_eq!(snapped("O’Brien said", 2, 4), "O’Brien");
        assert_eq!(snapped("end- next", 0, 2), "end");
        assert_eq!(snapped("x -start", 3, 5), "start");
    }

    #[test]
    fn multibyte_boundaries_stay_on_chars() {
        let text = "Łódź to miasto";
        let (s, e) = snap_one(text, 1, 3);
        assert_eq!(&text[s..e], "Łódź");
        assert!(text.is_char_boundary(s) && text.is_char_boundary(e));
    }

    #[test]
    fn edges_and_spaces_are_respected() {
        assert_eq!(snapped("abc def", 0, 1), "abc");
        assert_eq!(snapped("abc def", 6, 7), "def");
        assert_eq!(snapped("abc def", 3, 4), "");
        assert_eq!(snapped("abc", 9, 12), "");
    }

    #[test]
    fn snapping_merges_spans_that_meet_inside_a_word() {
        let text = "Kowalski";
        let out = snap_to_words(
            text,
            vec![span(0, 3, Label::Surname), span(5, 8, Label::Surname)],
        );
        assert_eq!(out, vec![span(0, 8, Label::Surname)]);
    }
}
