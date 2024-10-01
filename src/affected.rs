use std::{
    collections::{HashMap, HashSet},
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

pub fn collect_affected(
    test_files: Vec<&str>,
    changed_files: Vec<&str>,
    resolver: Resolver,
) -> AffectedReturn {
    let module_paths: HashSet<&str> =
        HashSet::from_iter(resolver.options().modules.iter().map(|m| m.as_str()));
    let mut affected: HashSet<PathBuf> = HashSet::from_iter(
        changed_files
            .into_iter()
            .map(|p| env::current_dir().unwrap().join(p).to_path_buf())
            .collect::<Vec<_>>(),
    );
    let mut errors: Vec<String> = Vec::new();

    let test_files_path_map: HashMap<&str, PathBuf> = HashMap::from_iter(
        test_files
            .iter()
            .map(|p: &&str| (*p, env::current_dir().unwrap().join(p).to_path_buf()))
            .collect::<Vec<_>>(),
    );
    let mut unvisited: Vec<(PathBuf, Vec<PathBuf>)> = test_files_path_map
        .values()
        .clone()
        .into_iter()
        .map(|f| (f.clone(), vec![f.clone()]))
        .collect::<Vec<_>>();
    let mut visited: HashSet<PathBuf> = HashSet::new();

    while !unvisited.is_empty() {
        let (absolute_path, import_graph) = unvisited[0].clone();
        unvisited.remove(0);
        visited.insert(absolute_path.clone());

        if import_graph.iter().any(|p| affected.contains(p)) {
            affected.extend(import_graph.clone().into_iter());
            continue;
        }

        if absolute_path
            .components()
            .any(|c| module_paths.contains(c.to_owned().as_os_str().to_str().unwrap()))
        {
            // Skip node_modules
            continue;
        }

        let source_type = SourceType::from_path(absolute_path.to_path_buf());
        if source_type.is_err() {
            // Skip non-source files
            continue;
        }
        let source_text: String = fs::read_to_string(&absolute_path).unwrap();
        let result = imports::collect_imports(source_type.unwrap(), source_text.as_str());
        errors.extend(result.errors);
        let mut imports: Vec<PathBuf> = Vec::new();
        for import_path in result.imports_paths.iter() {
            let resolve_result =
                resolver.resolve(&absolute_path.parent().unwrap(), import_path.as_str());
            match resolve_result {
                Ok(resolution) => imports.push(resolution.full_path()),
                Err(e) => match e {
                    ResolveError::Builtin(_) => {} // Skip builtins
                    _ => {
                        errors.push(e.to_string());
                    }
                },
            }
        }

        for import in imports {
            if affected.contains(&import) {
                affected.extend(import_graph.clone().into_iter());
            } else if !visited.contains(&import) {
                unvisited.push((
                    import.clone(),
                    [import_graph.clone(), vec![import.clone()]].concat(),
                ));
            }
        }
    }

    let ret: AffectedReturn = AffectedReturn {
        errors: errors,
        files: test_files_path_map
            .iter()
            .filter(|(_f, p)| affected.contains(p.to_owned()))
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
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
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
    fn test_ts_alias() {
        let test_files = vec!["fixtures/ts-alias/suite.spec.ts"];
        let changed_files = vec!["fixtures/ts-alias/aliased.ts"];
        assert_collect_affected(
            test_files.clone(),
            changed_files,
            test_files,
            Resolver::new(ResolveOptions {
                extensions: vec![".ts".into()],
                tsconfig: Some(TsconfigOptions {
                    config_file: env::current_dir()
                        .unwrap()
                        .join("fixtures/ts-alias/tsconfig.json"),
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
