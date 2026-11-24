use super::layout::{validate_file_name, ProjectPayload, SecretFile, Slot};
use base64::Engine;
use std::fmt::Write;

const MOUNT_PART: &str = r#"set -eu
umask 077
root=$1
exec 9>"$root.lock"
flock 9
if ! mountpoint -q "$root"; then
  mkdir -p "$root"
  mount -t tmpfs -o mode=0700,size=16m,nosuid,nodev,noexec tmpfs "$root"
fi
"#;

const WRITE_PART: &str = r#"set -eu
LC_ALL=C
export LC_ALL
umask 077
root=$1
owner=@OWNER@
nl='
'
fail() {
  echo "speedwave-secrets: $1" >&2
  exit 1
}
valid() {
  case $1 in
    ''|.|..|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}
chown_if_root() {
  if [ "$(id -u)" = 0 ]; then
    chown "$@"
  fi
}
ensure_dir() {
  if [ -L "$1" ]; then
    fail "unexpected symlink"
  fi
  [ -d "$1" ] || mkdir "$1"
}
ensure_slot() {
  case $1 in
    */*) ;;
    *) fail "bad slot" ;;
  esac
  svc=${1%%/*}
  pur=${1#*/}
  valid "$svc" && valid "$pur" || fail "bad slot"
  ensure_dir "$pdir/$svc"
  ensure_dir "$pdir/$svc/$pur"
  slot_dir=$pdir/$svc/$pur
  chown_if_root "$owner" "$slot_dir"
  chmod 0700 "$slot_dir"
}
write_file() {
  ensure_slot "$1"
  valid "$2" || fail "bad file name"
  target=$slot_dir/$2
  [ ! -d "$target" ] || fail "file name is a directory"
  tmp=$slot_dir/.tmp.$$
  printf '%s' "$3" | base64 -d > "$tmp" || {
    rm -f "$tmp"
    fail "bad content encoding"
  }
  chmod 0400 "$tmp"
  chown_if_root "$owner" "$tmp"
  mv -f "$tmp" "$target"
}
IFS=' ' read -r mode project || fail "empty input"
case $mode in
  sync|put) ;;
  *) fail "bad mode" ;;
esac
valid "$project" || fail "bad project"
[ -d "$root" ] || fail "missing root"
pdir=$root/$project
ensure_dir "$pdir"
keep=$nl
while IFS=' ' read -r kind slot name data; do
  case $kind in
    D)
      [ "$mode" = sync ] || fail "bad line"
      ensure_slot "$slot"
      ;;
    K)
      [ "$mode" = sync ] || fail "bad line"
      valid "$name" || fail "bad file name"
      keep="$keep$slot $name$nl"
      ;;
    F)
      write_file "$slot" "$name" "$data"
      keep="$keep$slot $name$nl"
      ;;
    *) fail "bad line" ;;
  esac
done
if [ "$mode" = sync ]; then
  for sdir in "$pdir"/*/; do
    [ -d "$sdir" ] || continue
    svc=${sdir%/}
    svc=${svc##*/}
    for udir in "$sdir"*/; do
      [ -d "$udir" ] || continue
      pur=${udir%/}
      pur=${pur##*/}
      find "$udir" -maxdepth 1 -type f | while IFS= read -r path; do
        case $keep in
          *"$nl$svc/$pur ${path##*/}$nl"*) ;;
          *) rm -f "$path" ;;
        esac
      done
    done
  done
fi
"#;

fn write_part() -> String {
    WRITE_PART.replace("@OWNER@", crate::consts::CONTAINER_USER_UNPRIVILEGED)
}

pub(crate) fn production_script() -> String {
    format!("{MOUNT_PART}{}", write_part())
}

pub(crate) fn encode_sync(project: &str, payload: &ProjectPayload) -> anyhow::Result<Vec<u8>> {
    crate::validation::validate_project_name(project)?;
    let mut frame = format!("sync {project}\n");
    for slot_files in &payload.slots {
        let id = slot_files.slot.frame_id();
        writeln!(frame, "D {id}")?;
        for name in &slot_files.keep {
            validate_file_name(name)?;
            writeln!(frame, "K {id} {name}")?;
        }
        for file in &slot_files.files {
            push_file_line(&mut frame, &id, file)?;
        }
    }
    Ok(frame.into_bytes())
}

pub(crate) fn encode_put(project: &str, slot: &Slot, file: &SecretFile) -> anyhow::Result<Vec<u8>> {
    crate::validation::validate_project_name(project)?;
    let mut frame = format!("put {project}\n");
    push_file_line(&mut frame, &slot.frame_id(), file)?;
    Ok(frame.into_bytes())
}

fn push_file_line(frame: &mut String, slot_id: &str, file: &SecretFile) -> anyhow::Result<()> {
    validate_file_name(&file.name)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&file.content);
    if encoded.is_empty() {
        writeln!(frame, "F {slot_id} {}", file.name)?;
    } else {
        writeln!(frame, "F {slot_id} {} {encoded}", file.name)?;
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;
    use crate::secrets_tmpfs::layout::{SlotFiles, PURPOSE_POLICY, PURPOSE_TOKENS};

    #[derive(Debug, PartialEq, Eq)]
    struct DecodedLine {
        kind: char,
        slot: String,
        name: Option<String>,
        content: Option<Vec<u8>>,
    }

    fn decode(frame: &[u8]) -> (String, String, Vec<DecodedLine>) {
        let text = std::str::from_utf8(frame).unwrap();
        assert!(text.ends_with('\n'));
        let mut lines = text.lines();
        let (mode, project) = lines.next().unwrap().split_once(' ').unwrap();
        let decoded = lines
            .map(|line| {
                let mut fields = line.splitn(4, ' ');
                let kind = fields.next().unwrap().chars().next().unwrap();
                let slot = fields.next().unwrap().to_string();
                let name = fields.next().map(String::from);
                let content = (kind == 'F').then(|| {
                    base64::engine::general_purpose::STANDARD
                        .decode(fields.next().unwrap_or(""))
                        .unwrap()
                });
                DecodedLine {
                    kind,
                    slot,
                    name,
                    content,
                }
            })
            .collect();
        (mode.to_string(), project.to_string(), decoded)
    }

    fn slot(service: &str, purpose: &str) -> Slot {
        Slot::new(service, purpose).unwrap()
    }

    #[test]
    fn sync_frame_round_trips_every_slot_file_and_keep_name() {
        let binary: Vec<u8> = (0..=255u8).collect();
        let mut tokens = SlotFiles::new(
            slot("mcp-slack", PURPOSE_TOKENS),
            vec![
                SecretFile::new("access_token", "tok-value-1"),
                SecretFile::new("blob", binary.clone()),
                SecretFile::new("empty", Vec::new()),
            ],
        );
        tokens.keep.push("refresh_status".to_string());
        let payload = ProjectPayload {
            slots: vec![
                tokens,
                SlotFiles::new(slot("mcp-hub", PURPOSE_POLICY), Vec::new()),
            ],
        };

        let (mode, project, lines) = decode(&encode_sync("acme", &payload).unwrap());

        assert_eq!((mode.as_str(), project.as_str()), ("sync", "acme"));
        let summary: Vec<(char, &str, Option<&str>)> = lines
            .iter()
            .map(|l| (l.kind, l.slot.as_str(), l.name.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ('D', "mcp-slack/tokens", None),
                ('K', "mcp-slack/tokens", Some("refresh_status")),
                ('F', "mcp-slack/tokens", Some("access_token")),
                ('F', "mcp-slack/tokens", Some("blob")),
                ('F', "mcp-slack/tokens", Some("empty")),
                ('D', "mcp-hub/policy", None),
            ]
        );
        assert_eq!(lines[2].content.as_deref(), Some(&b"tok-value-1"[..]));
        assert_eq!(lines[3].content.as_deref(), Some(&binary[..]));
        assert_eq!(lines[4].content.as_deref(), Some(&b""[..]));
    }

    #[test]
    fn put_frame_carries_one_file_and_no_directory_or_keep_lines() {
        let frame = encode_put(
            "acme",
            &slot("mcp-slack", PURPOSE_TOKENS),
            &SecretFile::new("access_token", "fresh"),
        )
        .unwrap();

        let (mode, project, lines) = decode(&frame);

        assert_eq!((mode.as_str(), project.as_str()), ("put", "acme"));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind, 'F');
        assert_eq!(lines[0].content.as_deref(), Some(&b"fresh"[..]));
    }

    #[test]
    fn encoding_rejects_a_bad_project_file_name_or_keep_name() {
        let good = slot("mcp-slack", PURPOSE_TOKENS);
        assert!(encode_put("Bad Project", &good, &SecretFile::new("a", "b")).is_err());
        assert!(encode_put("acme", &good, &SecretFile::new("../a", "b")).is_err());
        assert!(encode_put("acme", &good, &SecretFile::new("a b", "b")).is_err());

        let mut files = SlotFiles::new(good, Vec::new());
        files.keep.push("x/y".to_string());
        let payload = ProjectPayload { slots: vec![files] };
        assert!(encode_sync("acme", &payload).is_err());
    }

    #[test]
    fn frame_contains_no_value_in_clear_text() {
        let frame = encode_put(
            "acme",
            &slot("claude", "secrets"),
            &SecretFile::new("anthropic-api-key", "sk-ant-very-secret"),
        )
        .unwrap();
        assert!(!String::from_utf8(frame)
            .unwrap()
            .contains("sk-ant-very-secret"));
    }

    #[cfg(unix)]
    mod receiver {
        use super::*;
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Output, Stdio};

        fn run(root: &Path, frame: &[u8]) -> Output {
            let mut child = Command::new("sh")
                .arg("-c")
                .arg(write_part())
                .arg("sh")
                .arg(root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let _ = stdin.write_all(frame);
            drop(stdin);
            child.wait_with_output().unwrap()
        }

        fn fixture() -> (tempfile::TempDir, PathBuf) {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("root");
            std::fs::create_dir(&root).unwrap();
            (tmp, root)
        }

        fn sync(root: &Path, slots: Vec<SlotFiles>) -> Output {
            run(
                root,
                &encode_sync("acme", &ProjectPayload { slots }).unwrap(),
            )
        }

        fn files_under(dir: &Path) -> Vec<PathBuf> {
            let mut found = Vec::new();
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    found.extend(files_under(&path));
                } else {
                    found.push(path);
                }
            }
            found.sort();
            found
        }

        fn tokens(files: Vec<SecretFile>) -> SlotFiles {
            SlotFiles::new(slot("mcp-slack", PURPOSE_TOKENS), files)
        }

        #[test]
        fn sync_writes_files_read_only_and_creates_empty_slots() {
            let (_tmp, root) = fixture();

            let out = sync(
                &root,
                vec![
                    tokens(vec![
                        SecretFile::new("access_token", "tok-value-1"),
                        SecretFile::new("empty", Vec::new()),
                    ]),
                    SlotFiles::new(slot("mcp-hub", PURPOSE_POLICY), Vec::new()),
                ],
            );

            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let slot_dir = root.join("acme/mcp-slack/tokens");
            assert_eq!(
                std::fs::read_to_string(slot_dir.join("access_token")).unwrap(),
                "tok-value-1"
            );
            assert_eq!(std::fs::metadata(slot_dir.join("empty")).unwrap().len(), 0);
            let mode = std::fs::metadata(slot_dir.join("access_token"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o400);
            let slot_mode = std::fs::metadata(&slot_dir).unwrap().permissions().mode();
            assert_eq!(slot_mode & 0o777, 0o700);
            assert!(root.join("acme/mcp-hub/policy").is_dir());
        }

        #[test]
        fn sync_replaces_changed_files_and_prunes_the_rest_except_kept_names() {
            let (_tmp, root) = fixture();
            let first = sync(
                &root,
                vec![
                    tokens(vec![
                        SecretFile::new("access_token", "old"),
                        SecretFile::new("stale", "gone-soon"),
                        SecretFile::new("refresh_status", "ok"),
                    ]),
                    SlotFiles::new(
                        slot("mcp-hub", PURPOSE_POLICY),
                        vec![SecretFile::new("policy.json", "{}")],
                    ),
                ],
            );
            assert!(first.status.success());

            let mut second = tokens(vec![SecretFile::new("access_token", "new")]);
            second.keep.push("refresh_status".to_string());
            let out = sync(
                &root,
                vec![
                    second,
                    SlotFiles::new(slot("mcp-hub", PURPOSE_POLICY), Vec::new()),
                ],
            );

            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let slot_dir = root.join("acme/mcp-slack/tokens");
            assert_eq!(
                std::fs::read_to_string(slot_dir.join("access_token")).unwrap(),
                "new"
            );
            assert!(!slot_dir.join("stale").exists());
            assert_eq!(
                std::fs::read_to_string(slot_dir.join("refresh_status")).unwrap(),
                "ok"
            );
            assert!(!root.join("acme/mcp-hub/policy/policy.json").exists());
            assert!(root.join("acme/mcp-hub/policy").is_dir());
        }

        #[test]
        fn put_writes_one_file_and_prunes_nothing() {
            let (_tmp, root) = fixture();
            let first = sync(
                &root,
                vec![tokens(vec![SecretFile::new("other", "keep-me")])],
            );
            assert!(first.status.success());

            let frame = encode_put(
                "acme",
                &slot("mcp-slack", PURPOSE_TOKENS),
                &SecretFile::new("access_token", "fresh"),
            )
            .unwrap();
            let out = run(&root, &frame);

            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let slot_dir = root.join("acme/mcp-slack/tokens");
            assert_eq!(
                std::fs::read_to_string(slot_dir.join("access_token")).unwrap(),
                "fresh"
            );
            assert_eq!(
                std::fs::read_to_string(slot_dir.join("other")).unwrap(),
                "keep-me"
            );
        }

        #[test]
        fn a_traversing_component_is_rejected_and_nothing_is_written() {
            let b64 = base64::engine::general_purpose::STANDARD.encode("payload");
            for frame in [
                format!("sync acme\nF mcp-slack/tokens .. {b64}\n"),
                format!("sync acme\nF mcp-slack/tokens ../evil {b64}\n"),
                format!("sync acme\nF ../tokens evil {b64}\n"),
                format!("sync acme\nF mcp-slack/.. evil {b64}\n"),
                "sync acme\nD mcp-slack/../..\n".to_string(),
                "sync ..\nD mcp-slack/tokens\n".to_string(),
                format!("put acme/../x\nF mcp-slack/tokens evil {b64}\n"),
                format!("put acme\nF mcp-slack/tokens evil;rm {b64}\n"),
                format!("put acme\nF mcp-slack evil {b64}\n"),
            ] {
                let (tmp, root) = fixture();

                let out = run(&root, frame.as_bytes());

                assert!(!out.status.success(), "accepted {frame:?}");
                assert!(files_under(tmp.path()).is_empty(), "wrote for {frame:?}");
                assert!(!String::from_utf8_lossy(&out.stdout).contains("payload"));
            }
        }

        #[test]
        fn a_missing_root_and_an_unknown_mode_fail() {
            let (tmp, root) = fixture();
            let missing = tmp.path().join("absent");
            assert!(!run(&missing, b"sync acme\n").status.success());
            assert!(!run(&root, b"drop acme\n").status.success());
            assert!(!run(&root, b"put acme\nD mcp-slack/tokens\n")
                .status
                .success());
        }
    }
}
