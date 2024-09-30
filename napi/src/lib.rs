extern crate napi;
extern crate napi_derive;
extern crate oxc_affected;
extern crate oxc_resolver;

use std::path::PathBuf;

use napi_derive::napi;
use oxc_affected::collect_affected;
use oxc_resolver::{ResolveOptions, Resolver};

use self::options::{NapiResolveOptions, StrOrStrList};

mod options;

#[napi(object)]
pub struct AffectedResult {
    pub paths: Vec<String>,
    pub error: Option<String>,
}

#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn get_affected(
    test_files: Vec<String>,
    changed_files: Vec<String>,
    resolve_options: NapiResolveOptions,
) -> AffectedResult {
    let resolver = Resolver::new(normalize_options(resolve_options));
    let affected = collect_affected(
        test_files.iter().map(AsRef::as_ref).collect(),
        changed_files.iter().map(AsRef::as_ref).collect(),
        resolver,
    );
    AffectedResult {
        paths: affected.iter().map(|p| p.to_string()).collect(),
        error: None,
    }
}

fn normalize_options(op: NapiResolveOptions) -> ResolveOptions {
    let default = ResolveOptions::default();
    // merging options
    ResolveOptions {
        tsconfig: op.tsconfig.map(|tsconfig| tsconfig.into()),
        alias: op
            .alias
            .map(|alias| {
                alias
                    .into_iter()
                    .map(|(k, v)| {
                        let v = v
                            .into_iter()
                            .map(|item| match item {
                                Some(path) => oxc_resolver::AliasValue::from(path),
                                None => oxc_resolver::AliasValue::Ignore,
                            })
                            .collect();
                        (k, v)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.alias),
        alias_fields: op
            .alias_fields
            .map(|o| {
                o.into_iter()
                    .map(|x| StrOrStrList(x).into())
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.alias_fields),
        condition_names: op.condition_names.unwrap_or(default.condition_names),
        description_files: op.description_files.unwrap_or(default.description_files),
        enforce_extension: default.enforce_extension,
        exports_fields: op
            .exports_fields
            .map(|o| {
                o.into_iter()
                    .map(|x| StrOrStrList(x).into())
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.exports_fields),
        imports_fields: op
            .imports_fields
            .map(|o| {
                o.into_iter()
                    .map(|x| StrOrStrList(x).into())
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.imports_fields),
        extension_alias: op
            .extension_alias
            .map(|extension_alias| extension_alias.into_iter().collect::<Vec<_>>())
            .unwrap_or(default.extension_alias),
        extensions: op.extensions.unwrap_or(default.extensions),
        fallback: op
            .fallback
            .map(|fallback| {
                fallback
                    .into_iter()
                    .map(|(k, v)| {
                        let v = v
                            .into_iter()
                            .map(|item| match item {
                                Some(path) => oxc_resolver::AliasValue::from(path),
                                None => oxc_resolver::AliasValue::Ignore,
                            })
                            .collect();
                        (k, v)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.fallback),
        fully_specified: op.fully_specified.unwrap_or(default.fully_specified),
        main_fields: op
            .main_fields
            .map(|o| StrOrStrList(o).into())
            .unwrap_or(default.main_fields),
        main_files: op.main_files.unwrap_or(default.main_files),
        modules: op
            .modules
            .map(|o| StrOrStrList(o).into())
            .unwrap_or(default.modules),
        resolve_to_context: op.resolve_to_context.unwrap_or(default.resolve_to_context),
        prefer_relative: op.prefer_relative.unwrap_or(default.prefer_relative),
        prefer_absolute: op.prefer_absolute.unwrap_or(default.prefer_absolute),
        restrictions: op
            .restrictions
            .map(|restrictions| {
                restrictions
                    .into_iter()
                    .map(|restriction| restriction.into())
                    .collect::<Vec<_>>()
            })
            .unwrap_or(default.restrictions),
        roots: op
            .roots
            .map(|roots| roots.into_iter().map(PathBuf::from).collect::<Vec<_>>())
            .unwrap_or(default.roots),
        symlinks: op.symlinks.unwrap_or(default.symlinks),
        builtin_modules: op.builtin_modules.unwrap_or(default.builtin_modules),
    }
}
