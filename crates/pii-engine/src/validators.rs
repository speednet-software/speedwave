//! Checksum validators for PII categories whose value pattern alone is not
//! selective enough (TS counterpart: `mcp-servers/policies/src/validators.ts`).

/// PESEL (Polish national id) checksum validation.
pub(crate) fn validate_pesel(value: &str) -> bool {
    let digits: Vec<u32> = match value.chars().map(|c| c.to_digit(10)).collect() {
        Some(d) => d,
        None => return false,
    };
    if digits.len() != 11 {
        return false;
    }
    let weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
    let sum: u32 = digits[..10]
        .iter()
        .zip(weights.iter())
        .map(|(d, w)| d * w)
        .sum();
    let checksum = (10 - sum % 10) % 10;
    checksum == digits[10]
}

/// NIP (Polish tax id) checksum validation.
pub(crate) fn validate_nip(value: &str) -> bool {
    let digits: Vec<u32> = match value.chars().map(|c| c.to_digit(10)).collect() {
        Some(d) => d,
        None => return false,
    };
    if digits.len() != 10 {
        return false;
    }
    let weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    let sum: u32 = digits[..9]
        .iter()
        .zip(weights.iter())
        .map(|(d, w)| d * w)
        .sum();
    // A sum%11 of 10 has no single-digit representation, so it never matches (mirrors TS).
    sum % 11 == digits[9]
}

/// Luhn algorithm, used for payment-card validation.
pub(crate) fn validate_luhn(value: &str) -> bool {
    let digits: Vec<u32> = value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .map(|c| c.to_digit(10).unwrap_or(0))
        .collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let mut sum = 0u32;
    let mut is_even = false;
    for &d in digits.iter().rev() {
        let mut digit = d;
        if is_even {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        is_even = !is_even;
    }
    sum.is_multiple_of(10)
}

/// IBAN mod-97 check. Operates on chars (not bytes) so a non-ASCII byte in
/// the input can never split a multi-byte char and panic on slicing.
pub(crate) fn validate_iban(value: &str) -> bool {
    let cleaned: Vec<char> = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if cleaned.len() < 15 || cleaned.len() > 34 {
        return false;
    }
    let rearranged = cleaned[4..].iter().chain(cleaned[..4].iter());

    let mut remainder: u64 = 0;
    for &ch in rearranged {
        if ch.is_ascii_uppercase() {
            let value = ch as u64 - 'A' as u64 + 10;
            for digit_char in value.to_string().chars() {
                let digit = digit_char.to_digit(10).unwrap_or(0) as u64;
                remainder = (remainder * 10 + digit) % 97;
            }
        } else if let Some(digit) = ch.to_digit(10) {
            remainder = (remainder * 10 + digit as u64) % 97;
        } else {
            return false;
        }
    }
    remainder == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pesel_valid_checksum_passes() {
        assert!(validate_pesel("44051401359"));
    }

    #[test]
    fn pesel_invalid_checksum_fails() {
        assert!(!validate_pesel("12345678901"));
    }

    #[test]
    fn pesel_wrong_length_fails() {
        assert!(!validate_pesel("1234567890"));
        assert!(!validate_pesel(""));
    }

    #[test]
    fn pesel_non_digit_chars_fail_without_panicking() {
        assert!(!validate_pesel("abcdefghijk"));
        assert!(!validate_pesel("4405140135ż"));
    }

    #[test]
    fn nip_valid_checksum_passes() {
        assert!(validate_nip("5261040828"));
    }

    #[test]
    fn nip_invalid_checksum_fails() {
        assert!(!validate_nip("1234567890"));
    }

    #[test]
    fn nip_wrong_length_fails() {
        assert!(!validate_nip("123456789"));
    }

    #[test]
    fn luhn_valid_card_passes() {
        assert!(validate_luhn("4532015112830366"));
        assert!(validate_luhn("4532-0151-1283-0366"));
    }

    #[test]
    fn luhn_invalid_checksum_fails() {
        assert!(!validate_luhn("4532015112830367"));
    }

    #[test]
    fn luhn_wrong_length_fails() {
        assert!(!validate_luhn("123456789012"));
        assert!(!validate_luhn("12345678901234567890"));
    }

    #[test]
    fn iban_valid_polish_iban_passes() {
        assert!(validate_iban("PL61109010140000071219812874"));
    }

    #[test]
    fn iban_accepts_spaces_and_lowercase() {
        assert!(validate_iban("pl61 1090 1014 0000 0712 1981 2874"));
    }

    #[test]
    fn iban_invalid_checksum_fails() {
        assert!(!validate_iban("PL99109010140000071219812874"));
    }

    #[test]
    fn iban_too_short_fails() {
        assert!(!validate_iban("PL6110901"));
    }

    #[test]
    fn iban_too_long_fails() {
        assert!(!validate_iban("PL6110901012345678901234567890123456789"));
    }

    #[test]
    fn iban_non_ascii_input_fails_without_panicking() {
        assert!(!validate_iban("PLżółć10901014000007121981"));
    }
}
