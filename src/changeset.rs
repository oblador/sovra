use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangedEntry {
    File(PathBuf),
    Package(String),
}

pub fn parse_changed_entry(entry: &str, current_dir: &Path) -> ChangedEntry {
    if let Some(rest) = entry.strip_prefix("npm:") {
        assert!(
            !rest.is_empty(),
            "Invalid changeset entry '{entry}': missing package name after 'npm:'",
        );
        return ChangedEntry::Package(rest.to_string());
    }
    let path_part = entry.strip_prefix("file:").unwrap_or(entry);
    assert!(
        !path_part.is_empty(),
        "Invalid changeset entry '{entry}': empty path",
    );
    ChangedEntry::File(current_dir.join(path_part))
}

/// Returns the path segments after the last `node_modules` (or other module
/// folder) in `path`, or `None` if the path is not inside one.
pub fn node_modules_segments(path: &Path, module_paths: &HashSet<&str>) -> Option<Vec<String>> {
    let segments: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let last_nm = segments.iter().rposition(|s| module_paths.contains(*s))?;
    let after: Vec<String> = segments[last_nm + 1..]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if after.is_empty() {
        None
    } else {
        Some(after)
    }
}

/// True if any prefix of `segments` (joined with `/`) is in `changed_packages`.
/// Matching is segment-aware: `"lodash"` matches `["lodash", ...]` but not
/// `["lodash-utils", ...]`.
pub fn matches_changed_package(segments: &[String], changed_packages: &HashSet<String>) -> bool {
    for end in 1..=segments.len() {
        if changed_packages.contains(&segments[..end].join("/")) {
            return true;
        }
    }
    false
}

/// If `specifier` is a bare module specifier (Node ESM sense — no relative
/// prefix, no absolute path, no URL scheme), returns its `/`-separated
/// segments. Used as a fallback when the resolver can't find a module on disk
/// (e.g. `node_modules` not installed yet).
pub fn bare_specifier_segments(specifier: &str) -> Option<Vec<String>> {
    if specifier.is_empty() {
        return None;
    }
    if specifier.starts_with('.') || specifier.starts_with('/') {
        return None;
    }
    // Per Node spec, bare specifiers contain no `:` — this catches `node:fs`,
    // `https://...`, `file:///...`, etc.
    if specifier.contains(':') {
        return None;
    }
    let segments: Vec<String> = specifier.split('/').map(String::from).collect();
    if segments.iter().any(|s| s.is_empty()) {
        return None;
    }
    Some(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> PathBuf {
        PathBuf::from("/proj")
    }

    fn mods() -> HashSet<&'static str> {
        HashSet::from(["node_modules"])
    }

    fn segs(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    fn pkgs(parts: &[&str]) -> HashSet<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    // ---- parse_changed_entry: file paths -----------------------------------

    #[test]
    fn parse_plain_file_path() {
        assert_eq!(
            parse_changed_entry("src/foo.ts", &cwd()),
            ChangedEntry::File(PathBuf::from("/proj/src/foo.ts")),
        );
    }

    #[test]
    fn parse_file_prefix() {
        assert_eq!(
            parse_changed_entry("file:src/foo.ts", &cwd()),
            ChangedEntry::File(PathBuf::from("/proj/src/foo.ts")),
        );
    }

    #[test]
    fn parse_relative_file() {
        assert_eq!(
            parse_changed_entry("./src/foo.ts", &cwd()),
            ChangedEntry::File(PathBuf::from("/proj/./src/foo.ts")),
        );
    }

    #[test]
    #[should_panic(expected = "Invalid changeset entry")]
    fn parse_empty_entry_panics() {
        parse_changed_entry("", &cwd());
    }

    #[test]
    #[should_panic(expected = "Invalid changeset entry")]
    fn parse_empty_file_prefix_panics() {
        parse_changed_entry("file:", &cwd());
    }

    // ---- parse_changed_entry: npm packages --------------------------------

    #[test]
    fn parse_npm_plain_package() {
        assert_eq!(
            parse_changed_entry("npm:lodash", &cwd()),
            ChangedEntry::Package("lodash".to_string()),
        );
    }

    #[test]
    fn parse_npm_scoped_package() {
        assert_eq!(
            parse_changed_entry("npm:@scope/foo", &cwd()),
            ChangedEntry::Package("@scope/foo".to_string()),
        );
    }

    #[test]
    fn parse_npm_scope_alone_is_package() {
        // `@scope` is just a package name from sovra's perspective — match by
        // segment prefix means it'll catch every `@scope/...` import.
        assert_eq!(
            parse_changed_entry("npm:@scope", &cwd()),
            ChangedEntry::Package("@scope".to_string()),
        );
    }

    #[test]
    fn parse_npm_subpath_accepted() {
        // A name like `lodash/fp` is a valid changeset entry — matching is
        // segment-prefix based, so this will match imports of `lodash/fp` and
        // anything under it, but not `lodash` alone.
        assert_eq!(
            parse_changed_entry("npm:lodash/fp", &cwd()),
            ChangedEntry::Package("lodash/fp".to_string()),
        );
    }

    #[test]
    fn parse_npm_scoped_subpath_accepted() {
        assert_eq!(
            parse_changed_entry("npm:@scope/foo/sub", &cwd()),
            ChangedEntry::Package("@scope/foo/sub".to_string()),
        );
    }

    #[test]
    #[should_panic(expected = "Invalid changeset entry")]
    fn parse_npm_empty_panics() {
        parse_changed_entry("npm:", &cwd());
    }

    // ---- node_modules_segments --------------------------------------------

    #[test]
    fn segments_simple() {
        let p = PathBuf::from("/proj/node_modules/lodash/index.js");
        assert_eq!(
            node_modules_segments(&p, &mods()),
            Some(segs(&["lodash", "index.js"])),
        );
    }

    #[test]
    fn segments_scoped() {
        let p = PathBuf::from("/proj/node_modules/@scope/foo/dist/cjs/index.js");
        assert_eq!(
            node_modules_segments(&p, &mods()),
            Some(segs(&["@scope", "foo", "dist", "cjs", "index.js"])),
        );
    }

    #[test]
    fn segments_uses_last_node_modules() {
        let p = PathBuf::from("/proj/node_modules/foo/node_modules/bar/index.js");
        assert_eq!(
            node_modules_segments(&p, &mods()),
            Some(segs(&["bar", "index.js"])),
        );
    }

    #[test]
    fn segments_pnpm_style() {
        let p = PathBuf::from("/proj/node_modules/.pnpm/lodash@4.0.0/node_modules/lodash/index.js");
        assert_eq!(
            node_modules_segments(&p, &mods()),
            Some(segs(&["lodash", "index.js"])),
        );
    }

    #[test]
    fn segments_outside_node_modules() {
        let p = PathBuf::from("/proj/src/lodash/index.js");
        assert_eq!(node_modules_segments(&p, &mods()), None);
    }

    #[test]
    fn segments_custom_module_dir() {
        let p = PathBuf::from("/proj/bower_components/jquery/index.js");
        let custom = HashSet::from(["bower_components"]);
        assert_eq!(
            node_modules_segments(&p, &custom),
            Some(segs(&["jquery", "index.js"])),
        );
    }

    // ---- matches_changed_package ------------------------------------------

    #[test]
    fn match_unscoped_package() {
        assert!(matches_changed_package(
            &segs(&["lodash", "index.js"]),
            &pkgs(&["lodash"])
        ));
    }

    #[test]
    fn match_unscoped_via_deep_import() {
        assert!(matches_changed_package(
            &segs(&["lodash", "fp", "index.js"]),
            &pkgs(&["lodash"])
        ));
    }

    #[test]
    fn match_scoped_package() {
        assert!(matches_changed_package(
            &segs(&["@scope", "foo", "index.js"]),
            &pkgs(&["@scope/foo"])
        ));
    }

    #[test]
    fn match_scope_alone_treated_as_prefix() {
        // `@scope` as an entry catches every `@scope/...` package.
        assert!(matches_changed_package(
            &segs(&["@scope", "foo", "index.js"]),
            &pkgs(&["@scope"])
        ));
        assert!(matches_changed_package(
            &segs(&["@scope", "bar", "dist", "x.js"]),
            &pkgs(&["@scope"])
        ));
    }

    #[test]
    fn no_match_other_scope() {
        assert!(!matches_changed_package(
            &segs(&["@other", "foo", "index.js"]),
            &pkgs(&["@scope"])
        ));
    }

    #[test]
    fn no_match_substring_only() {
        // `lodash` must not match `lodash-utils` — segment boundaries matter.
        assert!(!matches_changed_package(
            &segs(&["lodash-utils", "index.js"]),
            &pkgs(&["lodash"])
        ));
    }

    #[test]
    fn match_subpath_entry() {
        // npm:lodash/fp matches `lodash/fp/...` but not `lodash` alone.
        assert!(matches_changed_package(
            &segs(&["lodash", "fp", "index.js"]),
            &pkgs(&["lodash/fp"])
        ));
        assert!(!matches_changed_package(
            &segs(&["lodash", "index.js"]),
            &pkgs(&["lodash/fp"])
        ));
    }

    // ---- bare_specifier_segments ------------------------------------------

    #[test]
    fn bare_unscoped() {
        assert_eq!(bare_specifier_segments("lodash"), Some(segs(&["lodash"])),);
    }

    #[test]
    fn bare_unscoped_subpath() {
        assert_eq!(
            bare_specifier_segments("lodash/fp"),
            Some(segs(&["lodash", "fp"])),
        );
    }

    #[test]
    fn bare_scoped() {
        assert_eq!(
            bare_specifier_segments("@scope/foo"),
            Some(segs(&["@scope", "foo"])),
        );
    }

    #[test]
    fn bare_scoped_subpath() {
        assert_eq!(
            bare_specifier_segments("@scope/foo/sub"),
            Some(segs(&["@scope", "foo", "sub"])),
        );
    }

    #[test]
    fn bare_rejects_relative() {
        assert_eq!(bare_specifier_segments("./foo"), None);
        assert_eq!(bare_specifier_segments("../foo"), None);
    }

    #[test]
    fn bare_rejects_absolute() {
        assert_eq!(bare_specifier_segments("/foo/bar"), None);
    }

    #[test]
    fn bare_rejects_url_scheme() {
        assert_eq!(bare_specifier_segments("node:fs"), None);
        assert_eq!(bare_specifier_segments("https://example.com/x"), None);
        assert_eq!(bare_specifier_segments("file:///x"), None);
    }

    #[test]
    fn bare_rejects_empty() {
        assert_eq!(bare_specifier_segments(""), None);
    }

    #[test]
    fn bare_rejects_empty_segment() {
        assert_eq!(bare_specifier_segments("lodash//fp"), None);
        assert_eq!(bare_specifier_segments("lodash/"), None);
    }
}
