//! Tokenizer wrapper producing ids with validated UTF-8 byte offsets.

use std::path::Path;

use crate::error::{DetectError, LoadError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Token {
    pub id: u32,
    pub start: usize,
    pub end: usize,
}

pub(crate) struct TokenizerWrapper(tokenizers::Tokenizer);

impl TokenizerWrapper {
    pub(crate) fn from_file(path: &Path) -> Result<Self, LoadError> {
        tokenizers::Tokenizer::from_file(path)
            .map(Self)
            .map_err(|e| LoadError::Tokenizer(e.to_string()))
    }

    /// Encodes without special tokens; every offset is checked to be a char boundary of `text`.
    pub(crate) fn encode(&self, text: &str) -> Result<Vec<Token>, DetectError> {
        let encoding = self
            .0
            .encode(text, false)
            .map_err(|e| DetectError::Tokenizer(e.to_string()))?;
        encoding
            .get_ids()
            .iter()
            .zip(encoding.get_offsets())
            .enumerate()
            .map(|(token, (&id, &(start, end)))| {
                let valid = start <= end
                    && end <= text.len()
                    && text.is_char_boundary(start)
                    && text.is_char_boundary(end);
                if valid {
                    Ok(Token { id, start, end })
                } else {
                    Err(DetectError::Offsets { token, start, end })
                }
            })
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    /// A WordLevel tokenizer over a handful of words; offsets are byte offsets into the input.
    pub(crate) const TINY_TOKENIZER_JSON: &str = r#"{
  "version": "1.0",
  "truncation": null,
  "padding": null,
  "added_tokens": [],
  "normalizer": null,
  "pre_tokenizer": {"type": "Whitespace"},
  "post_processor": null,
  "decoder": null,
  "model": {
    "type": "WordLevel",
    "vocab": {"<s>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3, "anna": 4, "kowalski": 5, "mieszka": 6, "w": 7, "łodzi": 8, "a": 9, "b": 10, "c": 11},
    "unk_token": "<unk>"
  }
}"#;
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::test_support::TINY_TOKENIZER_JSON;
    use super::*;

    fn tokenizer() -> TokenizerWrapper {
        TokenizerWrapper(tokenizers::Tokenizer::from_bytes(TINY_TOKENIZER_JSON.as_bytes()).unwrap())
    }

    #[test]
    fn offsets_are_bytes_and_unknown_words_map_to_unk() {
        let tokens = tokenizer().encode("anna w łodzi zzz").unwrap();
        let ids: Vec<u32> = tokens.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![4, 7, 8, 3]);
        assert_eq!((tokens[2].start, tokens[2].end), (7, 13));
        assert_eq!("anna w łodzi zzz"[7..13].to_string(), "łodzi");
    }

    #[test]
    fn empty_text_encodes_to_nothing() {
        assert!(tokenizer().encode("").unwrap().is_empty());
    }

    #[test]
    fn missing_file_is_a_load_error() {
        assert!(matches!(
            TokenizerWrapper::from_file(Path::new("/nope/tokenizer.json")),
            Err(LoadError::Tokenizer(_))
        ));
    }
}
