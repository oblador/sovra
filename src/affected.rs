use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
};

use oxc_resolver::{ResolveError, Resolver};
use oxc_span::SourceType;
use rayon::prelude::*;

use crate::changeset::{
    bare_specifier_segments, matches_changed_package, node_modules_segments, parse_changed_entry,
    ChangedEntry,
};
use crate::imports;

pub struct AffectedReturn {
    pub errors: Vec<String>,
    pub files: Vec<String>,
}

fn extend_affected(
    affected: &mut HashSet<PathBuf>,
    import: &PathBuf,
    dependents_map: &HashMap<PathBuf, HashSet<PathBuf>>,
) {
    affected.insert(import.clone());
    match dependents_map.get(import) {
        None => return,
        Some(dependents) => {
            for dependent in dependents.iter() {
                if affected.contains(dependent) {
                    continue;
                }
                extend_affected(affected, dependent, dependents_map);
            }
        }
    }
}

enum ScanEdge {
    /// Resolved to a regular file; `is_in_node_modules` is precomputed to
    /// avoid touching `module_paths` again during the (sequential) merge.
    Resolved {
        import: PathBuf,
        is_in_node_modules: bool,
    },
    /// Resolve failed but the bare specifier matched a changed npm
    /// package — the importing file should be marked affected.
    NpmFallbackMatched,
    /// Resolve failed and didn't match any changeset entry; surface it.
    UnresolvedError(String),
}

struct FileScan {
    absolute_path: PathBuf,
    parser_errors: Vec<String>,
    edges: Vec<ScanEdge>,
}

fn scan_file(
    absolute_path: PathBuf,
    resolver: &Resolver,
    current_dir: &Path,
    module_paths: &HashSet<&str>,
    changed_packages: &HashSet<String>,
    ignore_type_imports: bool,
) -> FileScan {
    let mut parser_errors = Vec::new();
    let mut edges = Vec::new();

    let Ok(source_type) = SourceType::from_path(absolute_path.clone()) else {
        return FileScan {
            absolute_path,
            parser_errors,
            edges,
        };
    };
    let Ok(source_text) = fs::read_to_string(&absolute_path) else {
        parser_errors.push(format!("Cannot read file: {absolute_path:?}"));
        return FileScan {
            absolute_path,
            parser_errors,
            edges,
        };
    };

    let result = imports::collect_imports(
        source_type,
        source_text.as_str(),
        Some(&absolute_path),
        ignore_type_imports,
    );
    parser_errors.extend(result.errors);

    let Some(parent_path) = absolute_path.parent() else {
        return FileScan {
            absolute_path,
            parser_errors,
            edges,
        };
    };

    edges.reserve(result.imports_paths.len());
    for import_path in result.imports_paths.iter() {
        match resolver.resolve(parent_path, import_path.as_str()) {
            Err(ResolveError::Builtin { .. }) => {} // Skip builtins
            Err(e) => {
                // Fallback: if the resolver couldn't find the module on
                // disk (e.g. `node_modules` not installed), match the raw
                // specifier against the npm changeset.
                let matched = !changed_packages.is_empty()
                    && bare_specifier_segments(import_path.as_str())
                        .is_some_and(|s| matches_changed_package(&s, changed_packages));
                if matched {
                    edges.push(ScanEdge::NpmFallbackMatched);
                } else {
                    let relative_path = absolute_path
                        .strip_prefix(current_dir)
                        .unwrap_or(&absolute_path)
                        .to_str()
                        .unwrap_or("unknown file");
                    edges.push(ScanEdge::UnresolvedError(format!("[{relative_path}]\n{e}")));
                }
            }
            Ok(resolution) => {
                let import = current_dir.join(resolution.path());
                let is_in_node_modules = import
                    .components()
                    .any(|c| module_paths.contains(c.to_owned().as_os_str().to_str().unwrap()));
                edges.push(ScanEdge::Resolved {
                    import,
                    is_in_node_modules,
                });
            }
        }
    }
    FileScan {
        absolute_path,
        parser_errors,
        edges,
    }
}

pub fn collect_affected(
    test_files: Vec<&str>,
    changes: Vec<&str>,
    resolver: Resolver,
    ignore_type_imports: bool,
) -> AffectedReturn {
    let current_dir = env::current_dir().unwrap();
    let module_paths: HashSet<&str> =
        HashSet::from_iter(resolver.options().modules.iter().map(|m| m.as_str()));

    let mut affected: HashSet<PathBuf> = HashSet::new();
    let mut changed_packages: HashSet<String> = HashSet::new();
    for entry in changes {
        match parse_changed_entry(entry, &current_dir) {
            ChangedEntry::File(p) => {
                affected.insert(p);
            }
            ChangedEntry::Package(name) => {
                changed_packages.insert(name);
            }
        }
    }
    let mut errors: Vec<String> = Vec::new();

    let test_files_path_map: HashMap<&str, PathBuf> = HashMap::from_iter(
        test_files
            .iter()
            .map(|p: &&str| (*p, current_dir.join(p).to_path_buf()))
            .collect::<Vec<_>>(),
    );
    let mut frontier: Vec<PathBuf> = test_files_path_map
        .values()
        .cloned()
        .filter(|p| !affected.contains(p))
        .collect();
    let mut dependents_map: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();

    while !frontier.is_empty() {
        let mut to_scan: Vec<PathBuf> = Vec::with_capacity(frontier.len());
        for path in frontier.drain(..) {
            if affected.contains(&path) {
                extend_affected(&mut affected, &path, &dependents_map);
                continue;
            }
            to_scan.push(path);
        }

        let scans: Vec<FileScan> = to_scan
            .into_par_iter()
            .map(|path| {
                scan_file(
                    path,
                    &resolver,
                    &current_dir,
                    &module_paths,
                    &changed_packages,
                    ignore_type_imports,
                )
            })
            .collect();

        let mut next_frontier: Vec<PathBuf> = Vec::new();
        for scan in scans {
            errors.extend(scan.parser_errors);
            let absolute_path = scan.absolute_path;
            for edge in scan.edges {
                match edge {
                    ScanEdge::UnresolvedError(e) => errors.push(e),
                    ScanEdge::NpmFallbackMatched => {
                        extend_affected(&mut affected, &absolute_path, &dependents_map);
                    }
                    ScanEdge::Resolved {
                        import,
                        is_in_node_modules,
                    } => {
                        // First time we see a node_modules path, check if
                        // any segment-prefix of the package matches a
                        // changed entry.
                        if is_in_node_modules
                            && !changed_packages.is_empty()
                            && !affected.contains(&import)
                            && !dependents_map.contains_key(&import)
                        {
                            if let Some(segments) = node_modules_segments(&import, &module_paths) {
                                if matches_changed_package(&segments, &changed_packages) {
                                    affected.insert(import.clone());
                                }
                            }
                        }

                        if affected.contains(&import) {
                            extend_affected(&mut affected, &absolute_path, &dependents_map);
                        } else if dependents_map.contains_key(&import) {
                            if let Some(dependents) = dependents_map.get_mut(&import) {
                                dependents.insert(absolute_path.clone());
                            }
                        } else {
                            dependents_map.insert(
                                import.clone(),
                                HashSet::from_iter(vec![absolute_path.clone()]),
                            );

                            // Skip node_modules
                            if is_in_node_modules {
                                continue;
                            }
                            next_frontier.push(import);
                        }
                    }
                }
            }
        }

        frontier = next_frontier;
    }

    AffectedReturn {
        errors,
        files: test_files_path_map
            .iter()
            .filter(|(_f, p)| affected.contains(*p))
            .map(|(f, _)| f.to_string())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use std::vec;

    use oxc_resolver::{ResolveOptions, TsconfigDiscovery, TsconfigOptions, TsconfigReferences};

    use super::*;

    fn assert_collect_affected(
        test_files: Vec<&str>,
        changes: Vec<&str>,
        expected: Vec<&str>,
        resolver: Resolver,
    ) {
        assert_collect_affected_with(test_files, changes, expected, resolver, false);
    }

    fn assert_collect_affected_with(
        test_files: Vec<&str>,
        changes: Vec<&str>,
        expected: Vec<&str>,
        resolver: Resolver,
        ignore_type_imports: bool,
    ) {
        let ret = collect_affected(test_files, changes, resolver, ignore_type_imports);
        let expected: HashSet<String> = HashSet::from_iter(expected.iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.files.iter().map(|s| s.to_string()));
        let no_errors: Vec<String> = vec![];
        assert_eq!(expected, actual);
        assert_eq!(ret.errors, no_errors);
    }

    fn assert_affected(test_files: Vec<&str>, changes: Vec<&str>) {
        assert_collect_affected(
            test_files.clone(),
            changes,
            test_files.clone(),
            Resolver::new(ResolveOptions::default()),
        );
    }

    fn assert_unaffected(test_files: Vec<&str>, changes: Vec<&str>) {
        assert_collect_affected(
            test_files.clone(),
            changes,
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
    }

    fn ts_resolver() -> Resolver {
        Resolver::new(ResolveOptions {
            extensions: vec![".ts".into()],
            tsconfig: Some(TsconfigDiscovery::Manual(TsconfigOptions {
                config_file: env::current_dir()
                    .unwrap()
                    .join("fixtures/typescript/tsconfig.json"),
                references: TsconfigReferences::Auto,
            })),
            ..ResolveOptions::default()
        })
    }

    #[test]
    fn test_require() {
        assert_affected(
            vec!["fixtures/require/suite.spec.js"],
            vec!["fixtures/require/module.js"],
        );
    }

    #[test]
    #[ignore]
    fn test_require_context() {
        assert_affected(
            vec!["fixtures/require/context.js"],
            vec!["fixtures/require/suite.spec.js"],
        );
    }

    #[test]
    fn test_nested() {
        let test_files = [
            "fixtures/nested/module.spec.js",
            "fixtures/nested/sub-module.spec.js",
        ];
        let changes = ["fixtures/nested/module.js", "fixtures/nested/sub-module.js"];
        assert_affected(test_files.to_vec(), changes.to_vec());
        assert_collect_affected(
            test_files.to_vec(),
            vec![changes[0]],
            vec![test_files[0]],
            Resolver::new(ResolveOptions::default()),
        );
        assert_affected(test_files.to_vec(), vec![changes[1]]);
        assert_collect_affected(
            test_files.to_vec(),
            vec!["fixtures/nested/another-module.js"],
            test_files.to_vec(),
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_circular() {
        let test_files = ["fixtures/nested/circular.spec.js"];
        assert_affected(test_files.to_vec(), vec!["fixtures/nested/circular-1.js"]);
        assert_affected(test_files.to_vec(), vec!["fixtures/nested/circular-2.js"]);
        assert_affected(test_files.to_vec(), vec!["fixtures/nested/circular-3.js"]);
        assert_unaffected(
            test_files.to_vec(),
            vec!["fixtures/nested/another-module.js"],
        );
    }

    #[test]
    fn test_all_nested() {
        let test_files = [
            "fixtures/nested/all.js",
            "fixtures/nested/circular.spec.js",
            "fixtures/nested/module.js",
            "fixtures/nested/assets.js",
        ];
        assert_unaffected(test_files.to_vec(), vec!["fixtures/nested/file.jsson"]);
    }

    #[test]
    fn test_ts_alias() {
        let test_files = vec!["fixtures/typescript/suite.spec.ts"];
        let changes = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected(
            test_files.clone(),
            changes,
            test_files,
            Resolver::new(ResolveOptions {
                extensions: vec![".ts".into()],
                tsconfig: Some(TsconfigDiscovery::Manual(TsconfigOptions {
                    config_file: env::current_dir()
                        .unwrap()
                        .join("fixtures/typescript/tsconfig.json"),
                    references: TsconfigReferences::Auto,
                })),
                ..ResolveOptions::default()
            }),
        );
    }

    #[test]
    fn test_type_import() {
        let test_files = vec!["fixtures/typescript/type-import.ts"];
        let changes = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected(test_files.clone(), changes, test_files, ts_resolver());
    }

    #[test]
    fn test_type_import_ignored() {
        // With `ignore_type_imports = true` a file that only depends on `aliased.ts`
        // through `import type` must no longer be considered affected.
        let test_files = vec!["fixtures/typescript/type-import.ts"];
        let changes = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected_with(test_files, changes, vec![], ts_resolver(), true);
    }

    #[test]
    fn test_type_import_ignored_value_import_still_affected() {
        // Files with a real value import of the changed file remain affected
        // even when `ignore_type_imports = true`.
        let test_files = vec!["fixtures/typescript/suite.spec.ts"];
        let changes = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected_with(test_files.clone(), changes, test_files, ts_resolver(), true);
    }

    #[test]
    fn test_non_source_imports() {
        assert_unaffected(
            vec!["fixtures/nested/assets.js"],
            vec!["fixtures/nested/another-module.js"],
        );
    }

    #[test]
    fn test_builtins() {
        assert_collect_affected(
            vec!["fixtures/built-in-module.mjs"],
            vec!["fixtures/nested/another-module.js"],
            vec![],
            Resolver::new(ResolveOptions {
                builtin_modules: true,
                ..ResolveOptions::default()
            }),
        );
    }

    #[test]
    fn test_yarn_workspace() {
        assert_affected(
            vec!["fixtures/yarn-workspace/app/index.js"],
            vec!["fixtures/yarn-workspace/packages/workspace-pkg-b/index.js"],
        );
    }

    #[test]
    fn test_bad_import() {
        let file_name = "fixtures/bad-import.js";
        let ret = collect_affected(vec![file_name], vec![], Resolver::default(), false);
        assert_eq!(
            ret.errors,
            vec![format!("[{file_name}]\nCannot find module 'bad-import'")]
        );
    }

    #[test]
    fn test_bad_module() {
        assert_unaffected(vec!["fixtures/modules/index.mjs"], vec![]);
    }

    // ---- npm changeset entries --------------------------------------------

    #[test]
    fn test_npm_package_affected() {
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec!["npm:lodash"],
            vec!["fixtures/npm/uses-lodash.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_unrelated_package_not_affected() {
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec!["npm:not-lodash"],
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_deep_import_matches_package() {
        // `import 'lodash/fp'` — npm:lodash should still match.
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash-fp.js"],
            vec!["npm:lodash"],
            vec!["fixtures/npm/uses-lodash-fp.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_scoped_package_affected() {
        assert_collect_affected(
            vec!["fixtures/npm/uses-scope-foo.js"],
            vec!["npm:@scope/foo"],
            vec!["fixtures/npm/uses-scope-foo.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_scope_alone_matches_all_scope_members() {
        // `npm:@scope` is just a package entry; segment-prefix matching makes
        // it catch every `@scope/...` import.
        assert_collect_affected(
            vec![
                "fixtures/npm/uses-scope-foo.js",
                "fixtures/npm/uses-scope-bar.js",
            ],
            vec!["npm:@scope"],
            vec![
                "fixtures/npm/uses-scope-foo.js",
                "fixtures/npm/uses-scope-bar.js",
            ],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_scope_does_not_match_other_scope() {
        assert_collect_affected(
            vec!["fixtures/npm/uses-other-foo.js"],
            vec!["npm:@scope"],
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_scope_does_not_match_unscoped() {
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec!["npm:@scope"],
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_via_intermediate_user_file() {
        // consumer.spec.js → intermediate.js → 'lodash'
        // npm:lodash should propagate up through the intermediate file.
        assert_collect_affected(
            vec!["fixtures/npm/consumer.spec.js"],
            vec!["npm:lodash"],
            vec!["fixtures/npm/consumer.spec.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    #[should_panic(expected = "Invalid changeset entry")]
    fn test_npm_empty_entry_panics() {
        collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec!["npm:"],
            Resolver::new(ResolveOptions::default()),
            false,
        );
    }

    #[test]
    #[should_panic(expected = "Invalid changeset entry")]
    fn test_empty_file_entry_panics() {
        collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec![""],
            Resolver::new(ResolveOptions::default()),
            false,
        );
    }

    #[test]
    fn test_npm_subpath_entry_matches_subpath() {
        // npm:lodash/fp matches imports of lodash/fp.
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash-fp.js"],
            vec!["npm:lodash/fp"],
            vec!["fixtures/npm/uses-lodash-fp.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_npm_subpath_entry_does_not_match_root() {
        // npm:lodash/fp does NOT match a plain `import 'lodash'`.
        assert_collect_affected(
            vec!["fixtures/npm/uses-lodash.js"],
            vec!["npm:lodash/fp"],
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
    }

    #[test]
    fn test_file_prefix_equivalent_to_no_prefix() {
        assert_collect_affected(
            vec!["fixtures/nested/module.spec.js"],
            vec!["file:fixtures/nested/module.js"],
            vec!["fixtures/nested/module.spec.js"],
            Resolver::new(ResolveOptions::default()),
        );
    }

    // ---- Fallback when node_modules isn't installed -----------------------

    #[test]
    fn test_unresolved_pkg_matches_changeset() {
        // The package isn't installed on disk; the resolver fails. Because
        // the specifier is a bare module specifier and `npm:not-installed-pkg`
        // is in the changeset, the file is still considered affected and no
        // error is emitted.
        let ret = collect_affected(
            vec!["fixtures/unresolved-pkg/uses-not-installed.js"],
            vec!["npm:not-installed-pkg"],
            Resolver::new(ResolveOptions::default()),
            false,
        );
        assert!(ret.errors.is_empty(), "unexpected errors: {:?}", ret.errors);
        assert_eq!(
            ret.files,
            vec!["fixtures/unresolved-pkg/uses-not-installed.js".to_string()],
        );
    }

    #[test]
    fn test_unresolved_pkg_no_changeset_match_still_errors() {
        // If the unresolved specifier doesn't match any changed package, the
        // resolve error surfaces as before.
        let ret = collect_affected(
            vec!["fixtures/unresolved-pkg/uses-not-installed.js"],
            vec!["npm:something-else"],
            Resolver::new(ResolveOptions::default()),
            false,
        );
        assert_eq!(ret.errors.len(), 1);
        assert!(ret.errors[0].contains("not-installed-pkg"));
        assert!(ret.files.is_empty());
    }

    #[test]
    fn test_unresolved_pkg_deep_import_matches_root_package() {
        // `import 'not-installed-pkg/sub/path'` with `npm:not-installed-pkg`.
        let ret = collect_affected(
            vec!["fixtures/unresolved-pkg/uses-not-installed-deep.js"],
            vec!["npm:not-installed-pkg"],
            Resolver::new(ResolveOptions::default()),
            false,
        );
        assert!(ret.errors.is_empty(), "unexpected errors: {:?}", ret.errors);
        assert_eq!(
            ret.files,
            vec!["fixtures/unresolved-pkg/uses-not-installed-deep.js".to_string()],
        );
    }

    #[test]
    fn test_unresolved_scoped_pkg_matches_scope() {
        // npm:@unresolved as a changeset entry catches all `@unresolved/*`.
        let ret = collect_affected(
            vec!["fixtures/unresolved-pkg/uses-scoped-missing.js"],
            vec!["npm:@unresolved"],
            Resolver::new(ResolveOptions::default()),
            false,
        );
        assert!(ret.errors.is_empty(), "unexpected errors: {:?}", ret.errors);
        assert_eq!(
            ret.files,
            vec!["fixtures/unresolved-pkg/uses-scoped-missing.js".to_string()],
        );
    }

    #[test]
    fn test_mixed_changeset_file_and_npm() {
        assert_collect_affected(
            vec![
                "fixtures/nested/module.spec.js",
                "fixtures/npm/uses-lodash.js",
            ],
            vec!["fixtures/nested/module.js", "npm:lodash"],
            vec![
                "fixtures/nested/module.spec.js",
                "fixtures/npm/uses-lodash.js",
            ],
            Resolver::new(ResolveOptions::default()),
        );
    }
}
