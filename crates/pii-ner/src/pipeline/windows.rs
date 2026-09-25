//! Sliding-window slicing of a token sequence into fixed model inputs.

use std::ops::Range;

use super::tokenize::Token;
use crate::model::BertConfig;
use crate::span::{MAX_CONTENT, SEQ_LEN, WINDOW_STEP};

/// Token index ranges of consecutive windows over `n_tokens` tokens.
pub(crate) fn window_ranges(n_tokens: usize) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    if n_tokens == 0 {
        return ranges;
    }
    let mut start = 0;
    loop {
        let end = (start + MAX_CONTENT).min(n_tokens);
        ranges.push(start..end);
        if end == n_tokens {
            return ranges;
        }
        start += WINDOW_STEP;
    }
}

/// One padded model input: ids, attention mask and how many positions are real.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Window {
    pub ids: Vec<i32>,
    pub mask: Vec<i32>,
    pub real_len: usize,
}

pub(crate) fn encode_window(chunk: &[Token], cfg: &BertConfig) -> Window {
    let real_len = chunk.len() + 2;
    let mut ids = Vec::with_capacity(SEQ_LEN);
    ids.push(cfg.cls_id);
    ids.extend(
        chunk
            .iter()
            .map(|t| i32::try_from(t.id).unwrap_or(cfg.pad_id)),
    );
    ids.push(cfg.sep_id);
    ids.resize(SEQ_LEN, cfg.pad_id);
    let mut mask = vec![1; real_len];
    mask.resize(SEQ_LEN, 0);
    Window {
        ids,
        mask,
        real_len,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(n: usize) -> Vec<Token> {
        (0..n)
            .map(|i| Token {
                id: 10 + i as u32,
                start: i,
                end: i + 1,
            })
            .collect()
    }

    #[test]
    fn window_ranges_cover_and_overlap() {
        assert!(window_ranges(0).is_empty());
        assert_eq!(window_ranges(1), vec![0..1]);
        assert_eq!(window_ranges(254), vec![0..254]);
        assert_eq!(window_ranges(255), vec![0..254, 190..255]);
        assert_eq!(window_ranges(444), vec![0..254, 190..444]);
        assert_eq!(window_ranges(445).len(), 3);
        for ranges in [window_ranges(1000), window_ranges(507)] {
            assert!(ranges
                .iter()
                .all(|r| r.len() <= MAX_CONTENT && !r.is_empty()));
            for pair in ranges.windows(2) {
                assert_eq!(pair[0].end - pair[1].start, 64);
            }
        }
    }

    #[test]
    fn encode_window_adds_specials_and_pads() {
        let cfg = crate::model::build::test_support::tiny_config(16, 5);
        let window = encode_window(&tokens(3), &cfg);
        assert_eq!(window.real_len, 5);
        assert_eq!(&window.ids[..5], &[0, 10, 11, 12, 2]);
        assert!(window.ids[5..].iter().all(|&id| id == 1));
        assert_eq!(window.ids.len(), SEQ_LEN);
        assert_eq!(window.mask.iter().sum::<i32>(), 5);
        assert_eq!(window.mask.len(), SEQ_LEN);
    }

    #[test]
    fn full_window_leaves_no_padding() {
        let cfg = crate::model::build::test_support::tiny_config(16, 5);
        let window = encode_window(&tokens(MAX_CONTENT), &cfg);
        assert_eq!(window.real_len, SEQ_LEN);
        assert_eq!(window.ids[SEQ_LEN - 1], 2);
        assert!(window.mask.iter().all(|&m| m == 1));
    }
}
