//! Entity labels of the Redact model and their BIOES tag encoding.

use std::fmt;
use std::str::FromStr;

use crate::error::LoadError;

/// A PII category the model can emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Label {
    /// US social security number.
    Ssn,
    /// Payment card number.
    CreditCard,
    /// E-mail address.
    Email,
    /// URL.
    Url,
    /// IPv4 or IPv6 address.
    IpAddress,
    /// Given name.
    GivenName,
    /// Family name.
    Surname,
    /// Phone number.
    Phone,
    /// Tax identifier.
    TaxId,
    /// Bank account or IBAN.
    BankAccount,
    /// Bank routing number.
    RoutingNumber,
    /// National or government identifier.
    GovernmentId,
    /// Passport number.
    Passport,
    /// Driver's license number.
    DriversLicense,
    /// Building number of a street address.
    BuildingNumber,
    /// Street name.
    StreetName,
    /// Apartment, floor or unit designator.
    SecondaryAddress,
    /// City.
    City,
    /// State or region.
    State,
    /// Postal code.
    ZipCode,
    /// Device IMEI.
    Imei,
    /// Organisation name.
    Org,
}

const LABELS: &[(Label, &str)] = &[
    (Label::Ssn, "SSN"),
    (Label::CreditCard, "CREDIT_CARD"),
    (Label::Email, "EMAIL"),
    (Label::Url, "URL"),
    (Label::IpAddress, "IP_ADDRESS"),
    (Label::GivenName, "GIVEN_NAME"),
    (Label::Surname, "SURNAME"),
    (Label::Phone, "PHONE"),
    (Label::TaxId, "TAX_ID"),
    (Label::BankAccount, "BANK_ACCOUNT"),
    (Label::RoutingNumber, "ROUTING_NUMBER"),
    (Label::GovernmentId, "GOVERNMENT_ID"),
    (Label::Passport, "PASSPORT"),
    (Label::DriversLicense, "DRIVERS_LICENSE"),
    (Label::BuildingNumber, "BUILDING_NUMBER"),
    (Label::StreetName, "STREET_NAME"),
    (Label::SecondaryAddress, "SECONDARY_ADDRESS"),
    (Label::City, "CITY"),
    (Label::State, "STATE"),
    (Label::ZipCode, "ZIP_CODE"),
    (Label::Imei, "IMEI"),
    (Label::Org, "ORG"),
];

impl Label {
    /// Every label the model can emit, in catalogue order.
    pub fn all() -> impl Iterator<Item = Label> {
        LABELS.iter().map(|(label, _)| *label)
    }

    /// The wire name of the label, e.g. `GIVEN_NAME`.
    pub fn as_str(self) -> &'static str {
        LABELS
            .iter()
            .find(|(label, _)| *label == self)
            .map(|(_, name)| *name)
            .unwrap_or("ORG")
    }

    /// Labels that name a person; used by name-aware post-processing.
    pub fn is_name_family(self) -> bool {
        matches!(self, Label::GivenName | Label::Surname)
    }
}

impl fmt::Display for Label {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A label name the model does not know.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown label {0:?}")]
pub struct LabelParseError(pub String);

impl FromStr for Label {
    type Err = LabelParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        LABELS
            .iter()
            .find(|(_, name)| *name == s)
            .map(|(label, _)| *label)
            .ok_or_else(|| LabelParseError(s.to_string()))
    }
}

/// One BIOES tag as the classifier emits it per token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tag {
    Outside,
    Begin(Label),
    Inside(Label),
    End(Label),
    Single(Label),
}

impl Tag {
    pub(crate) fn label(self) -> Option<Label> {
        match self {
            Tag::Outside => None,
            Tag::Begin(l) | Tag::Inside(l) | Tag::End(l) | Tag::Single(l) => Some(l),
        }
    }
}

impl FromStr for Tag {
    type Err = LabelParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s == "O" {
            return Ok(Tag::Outside);
        }
        let (prefix, name) = s
            .split_once('-')
            .ok_or_else(|| LabelParseError(s.to_string()))?;
        let label: Label = name.parse()?;
        match prefix {
            "B" => Ok(Tag::Begin(label)),
            "I" => Ok(Tag::Inside(label)),
            "E" => Ok(Tag::End(label)),
            "S" => Ok(Tag::Single(label)),
            _ => Err(LabelParseError(s.to_string())),
        }
    }
}

/// The classifier's output classes, indexed by class id.
#[derive(Debug, Clone)]
pub(crate) struct LabelSet {
    tags: Vec<Tag>,
}

impl LabelSet {
    pub(crate) fn from_names(names: &[String]) -> Result<Self, LoadError> {
        if names.first().map(String::as_str) != Some("O") {
            return Err(LoadError::Labels("class 0 must be O".to_string()));
        }
        let tags = names
            .iter()
            .map(|name| name.parse::<Tag>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| LoadError::Labels(e.to_string()))?;
        Ok(Self { tags })
    }

    pub(crate) fn tag(&self, class: usize) -> Option<Tag> {
        self.tags.get(class).copied()
    }

    pub(crate) fn len(&self) -> usize {
        self.tags.len()
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn every_label_round_trips_through_its_name() {
        for label in Label::all() {
            assert_eq!(label.as_str().parse::<Label>().unwrap(), label);
            let json = serde_json::to_string(&label).unwrap();
            assert_eq!(json, format!("\"{}\"", label.as_str()));
        }
        assert_eq!(Label::all().count(), 22);
    }

    #[test]
    fn tags_parse_all_prefixes_and_reject_garbage() {
        assert_eq!("O".parse::<Tag>().unwrap(), Tag::Outside);
        assert_eq!("B-SSN".parse::<Tag>().unwrap(), Tag::Begin(Label::Ssn));
        assert_eq!(
            "I-GIVEN_NAME".parse::<Tag>().unwrap(),
            Tag::Inside(Label::GivenName)
        );
        assert_eq!("E-CITY".parse::<Tag>().unwrap(), Tag::End(Label::City));
        assert_eq!("S-URL".parse::<Tag>().unwrap(), Tag::Single(Label::Url));
        for bad in ["X-FOO", "B-", "b-ssn", "SSN", ""] {
            assert!(bad.parse::<Tag>().is_err(), "{bad}");
        }
    }

    #[test]
    fn label_set_requires_outside_first() {
        let names: Vec<String> = ["O", "B-SSN", "S-ORG"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let set = LabelSet::from_names(&names).unwrap();
        assert_eq!(set.len(), 3);
        assert_eq!(set.tag(2), Some(Tag::Single(Label::Org)));
        assert_eq!(set.tag(3), None);
        let bad: Vec<String> = ["B-SSN".to_string()];
        assert!(matches!(
            LabelSet::from_names(&bad),
            Err(LoadError::Labels(_))
        ));
    }

    #[test]
    fn name_family_covers_given_and_surname_only() {
        assert!(Label::GivenName.is_name_family());
        assert!(Label::Surname.is_name_family());
        assert!(!Label::Org.is_name_family());
        assert!(!Label::Email.is_name_family());
    }
}
