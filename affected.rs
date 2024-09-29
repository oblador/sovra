use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use oxc_resolver::Resolver;
use oxc_span::SourceType;

use crate::imports;

pub fn collect_affected<'a>(
    test_files: Vec<&'a str>,
    changed_files: Vec<&str>,
    resolver: Resolver,
) -> HashSet<&'a str> {
    let mut affected_files = HashSet::new();
    let changed_files: HashSet<PathBuf> = HashSet::from_iter(
        changed_files
            .into_iter()
            .map(|p| env::current_dir().unwrap().join(p).to_path_buf())
            .collect::<Vec<_>>(),
    );

    for file in test_files.iter() {
        let path = Path::new(&file);
        let absolute_path = fs::canonicalize(path).unwrap();

        let source_text: String = std::fs::read_to_string(absolute_path.clone()).unwrap();
        let source_type: SourceType = SourceType::from_path(path).unwrap();
        let imports = imports::collect_imports(source_type, source_text.as_str())
            .into_iter()
            .map(|specifier| {
                resolver
                    .resolve(&absolute_path.parent().unwrap(), specifier.as_str())
                    .unwrap()
                    .full_path()
            })
            .collect::<Vec<_>>();
        for changed_file in changed_files.iter() {
            if imports.contains(changed_file) {
                affected_files.insert(file.to_owned());
                break;
            }
        }
    }

    affected_files
}

#[cfg(test)]
mod tests {
    use oxc_resolver::{ResolveOptions, TsconfigOptions, TsconfigReferences};

    use super::*;

    fn assert_affected(test_file: &str, changed_files: Vec<&str>, resolve_options: ResolveOptions) {
        let resolver = Resolver::new(resolve_options);

        assert_eq!(
            collect_affected(vec![test_file], changed_files, resolver),
            HashSet::from([test_file])
        );
    }

    #[test]
    fn test_simple() {
        assert_affected(
            "fixtures/simple/suite.spec.js",
            vec!["fixtures/simple/module.js"],
            ResolveOptions::default(),
        );
    }

    #[test]
    fn test_ts_alias() {
        assert_affected(
            "fixtures/ts-alias/suite.spec.ts",
            vec!["fixtures/ts-alias/aliased.ts"],
            ResolveOptions {
                extensions: vec![".ts".into()],
                tsconfig: Some(TsconfigOptions {
                    config_file: PathBuf::from("fixtures/ts-alias/tsconfig.json"),
                    references: TsconfigReferences::Auto,
                }),
                ..ResolveOptions::default()
            },
        );
    }
}
