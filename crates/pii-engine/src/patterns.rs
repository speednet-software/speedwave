//! Checksum-validator name registry: maps a policy.json v3 rule's
//! `validator` string to its compiled-in checksum function.

use crate::validators::{validate_iban, validate_luhn, validate_nip, validate_pesel};

/// Resolves a policy.json v3 `validator` name to its checksum function.
/// Returns `None` for any name outside the fixed set (the caller maps that
/// to a semantic policy error).
pub fn validator_by_name(name: &str) -> Option<fn(&str) -> bool> {
    match name {
        "pesel" => Some(validate_pesel),
        "nip" => Some(validate_nip),
        "iban" => Some(validate_iban),
        "luhn" => Some(validate_luhn),
        _ => None,
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    #[test]
    fn known_validator_names_resolve() {
        assert!(validator_by_name("pesel").is_some());
        assert!(validator_by_name("nip").is_some());
        assert!(validator_by_name("iban").is_some());
        assert!(validator_by_name("luhn").is_some());
    }

    #[test]
    fn unknown_validator_name_resolves_to_none() {
        assert!(validator_by_name("bogus").is_none());
        assert!(validator_by_name("").is_none());
        assert!(
            validator_by_name("PESEL").is_none(),
            "lookup is case-sensitive"
        );
    }

    #[test]
    fn resolved_validators_behave_correctly() {
        let pesel = validator_by_name("pesel").expect("pesel resolves");
        assert!(pesel("44051401359"));
        assert!(!pesel("12345678901"));

        let luhn = validator_by_name("luhn").expect("luhn resolves");
        assert!(luhn("4532015112830366"));
        assert!(!luhn("4532015112830367"));

        let nip = validator_by_name("nip").expect("nip resolves");
        assert!(nip("5261040828"));

        let iban = validator_by_name("iban").expect("iban resolves");
        assert!(iban("PL61109010140000071219812874"));
    }
}
