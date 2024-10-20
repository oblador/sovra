use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    path::PathBuf,
};

use oxc_resolver::{ResolveError, Resolver};
use oxc_span::SourceType;

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

pub fn collect_affected(
    test_files: Vec<&str>,
    changed_files: Vec<&str>,
    resolver: Resolver,
) -> AffectedReturn {
    let current_dir = env::current_dir().unwrap();
    let module_paths: HashSet<&str> =
        HashSet::from_iter(resolver.options().modules.iter().map(|m| m.as_str()));
    let mut affected = HashSet::from_iter(
        changed_files
            .into_iter()
            .map(|p| current_dir.join(p).to_path_buf())
            .collect::<Vec<_>>(),
    );
    let mut errors: Vec<String> = Vec::new();

    let test_files_path_map: HashMap<&str, PathBuf> = HashMap::from_iter(
        test_files
            .iter()
            .map(|p: &&str| (*p, current_dir.join(p).to_path_buf()))
            .collect::<Vec<_>>(),
    );
    let mut unvisited = test_files_path_map
        .values()
        .cloned()
        .filter(|p| !affected.contains(p))
        .collect::<VecDeque<_>>();
    let mut dependents_map: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();

    while let Some(absolute_path) = unvisited.pop_front() {
        if affected.contains(&absolute_path) {
            extend_affected(&mut affected, &absolute_path, &dependents_map);
            continue;
        }

        let Ok(source_type) = SourceType::from_path(absolute_path.clone()) else {
            continue;
        };
        let Ok(source_text) = fs::read_to_string(&absolute_path) else {
            errors.push(format!("Cannot read file: {}", absolute_path.display()));
            continue;
        };
        let result =
            imports::collect_imports(source_type, source_text.as_str(), absolute_path.to_str());
        errors.extend(result.errors);
        if let Some(parent_path) = absolute_path.parent() {
            for import_path in result.imports_paths.iter() {
                match resolver.resolve(parent_path, import_path.as_str()) {
                    Err(e) => match e {
                        ResolveError::Builtin(_) => {} // Skip builtins
                        _ => {
                            errors.push(e.to_string());
                        }
                    },
                    Ok(resolution) => {
                        let import = current_dir.join(resolution.path());
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
                            if import.components().any(|c| {
                                module_paths.contains(c.to_owned().as_os_str().to_str().unwrap())
                            }) {
                                continue;
                            }
                            unvisited.push_back(import);
                        }
                    }
                }
            }
        }
    }

    let ret: AffectedReturn = AffectedReturn {
        errors,
        files: test_files_path_map
            .iter()
            .filter(|(_f, p)| affected.contains(*p))
            .map(|(f, _)| f.to_string())
            .collect(),
    };
    ret
}

#[cfg(test)]
mod tests {
    use std::vec;

    use oxc_resolver::{ResolveOptions, TsconfigOptions, TsconfigReferences};

    use super::*;

    fn assert_collect_affected(
        test_files: Vec<&str>,
        changed_files: Vec<&str>,
        expected: Vec<&str>,
        resolver: Resolver,
    ) {
        let ret = collect_affected(test_files, changed_files, resolver);
        let expected: HashSet<String> = HashSet::from_iter(expected.iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.files.iter().map(|s| s.to_string()));
        let no_errors: Vec<String> = vec![];
        assert_eq!(expected, actual);
        assert_eq!(ret.errors, no_errors);
    }

    fn assert_affected(test_files: Vec<&str>, changed_files: Vec<&str>) {
        assert_collect_affected(
            test_files.clone(),
            changed_files,
            test_files.clone(),
            Resolver::new(ResolveOptions::default()),
        );
    }

    fn assert_unaffected(test_files: Vec<&str>, changed_files: Vec<&str>) {
        assert_collect_affected(
            test_files.clone(),
            changed_files,
            vec![],
            Resolver::new(ResolveOptions::default()),
        );
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
        let changed_files = ["fixtures/nested/module.js", "fixtures/nested/sub-module.js"];
        assert_affected(test_files.to_vec(), changed_files.to_vec());
        assert_collect_affected(
            test_files.to_vec(),
            vec![changed_files[0]],
            vec![test_files[0]],
            Resolver::new(ResolveOptions::default()),
        );
        assert_affected(test_files.to_vec(), vec![changed_files[1]]);
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
        let changed_files = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected(
            test_files.clone(),
            changed_files,
            test_files,
            Resolver::new(ResolveOptions {
                extensions: vec![".ts".into()],
                tsconfig: Some(TsconfigOptions {
                    config_file: env::current_dir()
                        .unwrap()
                        .join("fixtures/typescript/tsconfig.json"),
                    references: TsconfigReferences::Auto,
                }),
                ..ResolveOptions::default()
            }),
        );
    }

    #[test]
    fn test_type_import() {
        let test_files = vec!["fixtures/typescript/type-import.ts"];
        let changed_files = vec!["fixtures/typescript/aliased.ts"];
        assert_collect_affected(
            test_files.clone(),
            changed_files,
            test_files,
            Resolver::new(ResolveOptions {
                extensions: vec![".ts".into()],
                tsconfig: Some(TsconfigOptions {
                    config_file: env::current_dir()
                        .unwrap()
                        .join("fixtures/typescript/tsconfig.json"),
                    references: TsconfigReferences::Auto,
                }),
                ..ResolveOptions::default()
            }),
        );
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
        let ret = collect_affected(vec!["fixtures/bad-import.js"], vec![], Resolver::default());
        assert_eq!(ret.errors, vec!["Cannot find module 'bad-import'"]);
    }

    #[test]
    fn test_bad_module() {
        assert_unaffected(vec!["fixtures/modules/index.mjs"], vec![]);
    }
}
