//! BIOES tag sequence to entity spans, ported from the vendor decoder.

use crate::label::{Label, Tag};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct RawSpan {
    pub start: usize,
    pub end: usize,
    pub label: Label,
}

/// Decodes per-token tags into spans; `offsets[i]` are the byte offsets of token `i`.
pub(crate) fn bioes_to_spans(tags: &[Tag], offsets: &[(usize, usize)]) -> Vec<RawSpan> {
    let mut out = Vec::new();
    let mut open: Option<RawSpan> = None;
    let close = |open: &mut Option<RawSpan>, out: &mut Vec<RawSpan>| {
        if let Some(span) = open.take() {
            if span.end > span.start {
                out.push(span);
            }
        }
    };
    for (tag, &(start, end)) in tags.iter().zip(offsets) {
        if end <= start {
            continue;
        }
        match *tag {
            Tag::Outside => close(&mut open, &mut out),
            Tag::Single(label) => {
                close(&mut open, &mut out);
                out.push(RawSpan { start, end, label });
            }
            Tag::Begin(label) => {
                close(&mut open, &mut out);
                open = Some(RawSpan { start, end, label });
            }
            Tag::Inside(label) => match open {
                Some(ref mut span) if span.label == label => span.end = end,
                _ => {
                    close(&mut open, &mut out);
                    open = Some(RawSpan { start, end, label });
                }
            },
            Tag::End(label) => match open {
                Some(ref mut span) if span.label == label => {
                    span.end = end;
                    close(&mut open, &mut out);
                }
                _ => {
                    close(&mut open, &mut out);
                    out.push(RawSpan { start, end, label });
                }
            },
        }
    }
    close(&mut open, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offsets(n: usize) -> Vec<(usize, usize)> {
        (0..n).map(|i| (i * 2, i * 2 + 1)).collect()
    }

    #[test]
    fn begin_inside_end_forms_one_span() {
        let tags = [
            Tag::Begin(Label::Ssn),
            Tag::Inside(Label::Ssn),
            Tag::End(Label::Ssn),
        ];
        assert_eq!(
            bioes_to_spans(&tags, &offsets(3)),
            vec![RawSpan {
                start: 0,
                end: 5,
                label: Label::Ssn
            }]
        );
    }

    #[test]
    fn single_and_outside_tokens() {
        let tags = [Tag::Outside, Tag::Single(Label::Email), Tag::Outside];
        assert_eq!(
            bioes_to_spans(&tags, &offsets(3)),
            vec![RawSpan {
                start: 2,
                end: 3,
                label: Label::Email
            }]
        );
    }

    #[test]
    fn inside_without_begin_opens_and_label_change_closes() {
        let tags = [
            Tag::Inside(Label::City),
            Tag::Inside(Label::State),
            Tag::End(Label::State),
        ];
        assert_eq!(
            bioes_to_spans(&tags, &offsets(3)),
            vec![
                RawSpan {
                    start: 0,
                    end: 1,
                    label: Label::City
                },
                RawSpan {
                    start: 2,
                    end: 5,
                    label: Label::State
                },
            ]
        );
    }

    #[test]
    fn end_without_begin_is_a_single_token_span_and_trailing_open_span_closes() {
        let tags = [
            Tag::End(Label::Phone),
            Tag::Begin(Label::Url),
            Tag::Inside(Label::Url),
        ];
        assert_eq!(
            bioes_to_spans(&tags, &offsets(3)),
            vec![
                RawSpan {
                    start: 0,
                    end: 1,
                    label: Label::Phone
                },
                RawSpan {
                    start: 2,
                    end: 5,
                    label: Label::Url
                },
            ]
        );
    }

    #[test]
    fn empty_offsets_are_skipped_and_lengths_may_differ() {
        let tags = [
            Tag::Begin(Label::Ssn),
            Tag::Inside(Label::Ssn),
            Tag::End(Label::Ssn),
            Tag::Outside,
        ];
        let offsets = [(0, 0), (1, 2), (2, 3)];
        assert_eq!(
            bioes_to_spans(&tags, &offsets),
            vec![RawSpan {
                start: 1,
                end: 3,
                label: Label::Ssn
            }]
        );
        assert!(bioes_to_spans(&[], &[]).is_empty());
    }
}
