use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::PathBuf,
};

use oxc_resolver::Resolver;
use oxc_span::SourceType;

use crate::imports;

pub fn collect_affected<'a>(
    test_files: Vec<&'a str>,
    changed_files: Vec<&str>,
    resolver: Resolver,
) -> HashSet<&'a str> {
    let mut affected: HashSet<PathBuf> = HashSet::from_iter(
        changed_files
            .into_iter()
            .map(|p| env::current_dir().unwrap().join(p).to_path_buf())
            .collect::<Vec<_>>(),
    );

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

        let source_text: String = fs::read_to_string(absolute_path.clone()).unwrap();
        let source_type: SourceType = SourceType::from_path(absolute_path.to_path_buf()).unwrap();
        let imports = imports::collect_imports(source_type, source_text.as_str())
            .specifiers
            .into_iter()
            .map(|specifier| {
                resolver
                    .resolve(&absolute_path.parent().unwrap(), specifier.as_str())
                    .unwrap()
                    .full_path()
            })
            .collect::<Vec<_>>();

        if imports.iter().any(|p| affected.contains(p)) {
            affected.extend(import_graph.clone().into_iter());
            unvisited = unvisited
                .into_iter()
                .filter(|(f, _)| !affected.contains(f))
                .collect::<Vec<_>>();
        }

        for import in imports {
            if !visited.contains(&import) {
                unvisited.push((
                    import.clone(),
                    [import_graph.clone(), vec![import.clone()]].concat(),
                ));
            }
        }
    }

    test_files_path_map
        .iter()
        .filter(|(_f, p)| affected.contains(p.to_owned()))
        .map(|(f, _)| *f)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::vec;

    use oxc_resolver::{ResolveOptions, TsconfigOptions, TsconfigReferences};

    use super::*;

    #[test]
    fn test_require() {
        let test_file = "fixtures/require/suite.spec.js";
        let changed_files = vec!["fixtures/require/module.js"];
        assert_eq!(
            collect_affected(
                vec![test_file],
                changed_files,
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from([test_file])
        );
    }

    #[test]
    #[ignore]
    fn test_require_context() {
        let test_file = "fixtures/require/context.js";
        let changed_files = vec!["fixtures/require/suite.spec.js"];
        assert_eq!(
            collect_affected(
                vec![test_file],
                changed_files,
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from([test_file])
        );
    }

    #[test]
    fn test_nested() {
        let test_files = [
            "fixtures/nested/module.spec.js",
            "fixtures/nested/sub-module.spec.js",
        ];
        let changed_files = ["fixtures/nested/module.js", "fixtures/nested/sub-module.js"];
        // All test files should be affected
        assert_eq!(
            collect_affected(
                test_files.to_vec(),
                changed_files.to_vec(),
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from(test_files)
        );
        // Only module.spec.js should be affected
        assert_eq!(
            collect_affected(
                test_files.to_vec(),
                vec![changed_files[0]],
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from([test_files[0]])
        );
        // Again all test files should be affected
        assert_eq!(
            collect_affected(
                test_files.to_vec(),
                vec![changed_files[1]],
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from(test_files)
        );
        // Again all test files should be affected
        assert_eq!(
            collect_affected(
                test_files.to_vec(),
                vec!["fixtures/nested/another-module.js"],
                Resolver::new(ResolveOptions::default())
            ),
            HashSet::from(test_files)
        );
    }

    #[test]
    fn test_ts_alias() {
        let test_file = "fixtures/ts-alias/suite.spec.ts";
        let changed_files = vec!["fixtures/ts-alias/aliased.ts"];
        assert_eq!(
            collect_affected(
                vec![test_file],
                changed_files,
                Resolver::new(ResolveOptions {
                    extensions: vec![".ts".into()],
                    tsconfig: Some(TsconfigOptions {
                        config_file: env::current_dir()
                            .unwrap()
                            .join("fixtures/ts-alias/tsconfig.json"),
                        references: TsconfigReferences::Auto,
                    }),
                    ..ResolveOptions::default()
                })
            ),
            HashSet::from([test_file])
        );
    }
}
