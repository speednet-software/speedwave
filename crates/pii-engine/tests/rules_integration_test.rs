#[test]
fn rules_yaml_is_valid_and_loadable() {
    let yaml_content = include_str!("../../mcp-servers/policies/rules.yaml");

    // Basic validation: YAML must parse and have the expected structure
    assert!(yaml_content.contains("version: 3"), "version must be 3");
    assert!(yaml_content.contains("rules:"), "must have rules section");

    // Count expected rules
    let email_count = yaml_content.matches("id: EMAIL").count();
    let phone_count = yaml_content.matches("id: PHONE_PL").count();
    let pesel_count = yaml_content.matches("id: PESEL").count();
    let nip_count = yaml_content.matches("id: NIP").count();
    let iban_count = yaml_content.matches("id: IBAN").count();
    let card_count = yaml_content.matches("id: CARD").count();
    let api_key_count = yaml_content.matches("id: API_KEY").count();

    assert_eq!(email_count, 1, "EMAIL rule must appear exactly once");
    assert_eq!(phone_count, 1, "PHONE_PL rule must appear exactly once");
    assert_eq!(pesel_count, 1, "PESEL rule must appear exactly once");
    assert_eq!(nip_count, 1, "NIP rule must appear exactly once");
    assert_eq!(iban_count, 1, "IBAN rule must appear exactly once");
    assert_eq!(card_count, 1, "CARD rule must appear exactly once");
    assert_eq!(api_key_count, 1, "API_KEY rule must appear exactly once");

    // Verify validators are referenced correctly
    assert!(
        yaml_content.contains("validator: pesel"),
        "PESEL must have validator"
    );
    assert!(
        yaml_content.contains("validator: nip"),
        "NIP must have validator"
    );
    assert!(
        yaml_content.contains("validator: iban"),
        "IBAN must have validator"
    );
    assert!(
        yaml_content.contains("validator: luhn"),
        "CARD must have validator"
    );
}
