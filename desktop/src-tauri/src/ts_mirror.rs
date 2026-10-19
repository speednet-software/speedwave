use serde::Serialize;

#[expect(
    clippy::expect_used,
    reason = "test support: an unreadable interface is a broken TS source"
)]
pub(crate) fn ts_interface_fields(src: &'static str, name: &str) -> Vec<&'static str> {
    let marker = format!("export interface {name} {{");
    let idx = src
        .find(&marker)
        .unwrap_or_else(|| panic!("the TS source must declare `{marker}`"));
    let body = src[idx + marker.len()..]
        .split("\n}")
        .next()
        .expect("interface must be closed");
    let mut fields: Vec<&str> = body
        .lines()
        .filter_map(|l| l.split(':').next())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
        .collect();
    fields.sort_unstable();
    fields
}

#[expect(
    clippy::expect_used,
    reason = "test support: a sample that is not a JSON object is a broken fixture"
)]
pub(crate) fn rust_fields<T: Serialize>(sample: &T) -> Vec<String> {
    let json = serde_json::to_value(sample).expect("sample serializes");
    let mut keys: Vec<String> = json
        .as_object()
        .expect("sample is an object")
        .keys()
        .cloned()
        .collect();
    keys.sort_unstable();
    keys
}
