//! Span de-duplication across overlapping windows and same-label merging.

use std::collections::HashMap;

use super::bioes::RawSpan;
use crate::span::Span;

/// Keeps one entry per `(start, end, label)` at its best score, in first-seen order.
pub(crate) fn dedupe_best(spans: Vec<(RawSpan, f32)>) -> Vec<(RawSpan, f32)> {
    let mut index: HashMap<RawSpan, usize> = HashMap::new();
    let mut out: Vec<(RawSpan, f32)> = Vec::new();
    for (span, score) in spans {
        match index.get(&span) {
            Some(&at) => {
                if score > out[at].1 {
                    out[at].1 = score;
                }
            }
            None => {
                index.insert(span, out.len());
                out.push((span, score));
            }
        }
    }
    out
}

fn ordering(a: &Span, b: &Span) -> std::cmp::Ordering {
    a.start
        .cmp(&b.start)
        .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
        .then_with(|| a.label.as_str().cmp(b.label.as_str()))
}

/// Merges overlapping or touching spans of the same label; drops later spans that overlap a different label.
pub(crate) fn merge_same_label(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(ordering);
    let mut out: Vec<Span> = Vec::new();
    for span in spans {
        match out.last_mut() {
            Some(last) if last.label == span.label && span.start <= last.end => {
                last.end = last.end.max(span.end);
                last.confidence = last.confidence.max(span.confidence);
            }
            Some(last) if span.start < last.end => {}
            _ => out.push(span),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::label::Label;

    fn raw(start: usize, end: usize, label: Label) -> RawSpan {
        RawSpan { start, end, label }
    }

    fn span(start: usize, end: usize, label: Label, confidence: f32) -> Span {
        Span {
            start,
            end,
            label,
            confidence,
        }
    }

    #[test]
    fn dedupe_keeps_best_score_and_first_seen_order() {
        let out = dedupe_best(vec![
            (raw(0, 3, Label::City), 0.5),
            (raw(4, 8, Label::Phone), 0.9),
            (raw(0, 3, Label::City), 0.8),
            (raw(0, 3, Label::State), 0.7),
        ]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], (raw(0, 3, Label::City), 0.8));
        assert_eq!(out[1], (raw(4, 8, Label::Phone), 0.9));
        assert_eq!(out[2], (raw(0, 3, Label::State), 0.7));
    }

    #[test]
    fn same_label_overlaps_merge_and_keep_best_confidence() {
        let out = merge_same_label(vec![
            span(3, 6, Label::Url, 0.7),
            span(0, 4, Label::Url, 0.9),
        ]);
        assert_eq!(out, vec![span(0, 6, Label::Url, 0.9)]);
        let touching = merge_same_label(vec![
            span(0, 2, Label::Url, 0.6),
            span(2, 4, Label::Url, 0.8),
        ]);
        assert_eq!(touching, vec![span(0, 4, Label::Url, 0.8)]);
    }

    #[test]
    fn different_label_overlap_keeps_the_earlier_longer_span() {
        let out = merge_same_label(vec![
            span(2, 4, Label::City, 0.9),
            span(0, 5, Label::State, 0.6),
        ]);
        assert_eq!(out, vec![span(0, 5, Label::State, 0.6)]);
        let disjoint = merge_same_label(vec![
            span(5, 7, Label::City, 0.9),
            span(0, 2, Label::State, 0.6),
        ]);
        assert_eq!(
            disjoint,
            vec![span(0, 2, Label::State, 0.6), span(5, 7, Label::City, 0.9)]
        );
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert!(merge_same_label(vec![]).is_empty());
        assert!(dedupe_best(vec![]).is_empty());
    }
}
