use oxc::diagnostics::{Error, NamedSource, OxcDiagnostic};
use oxc_allocator::Allocator;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::{collections::HashSet, env, path::PathBuf, sync::Arc};

pub struct ImportsReturn {
    pub errors: Vec<String>,
    pub imports_paths: Vec<String>,
}

/// A function call that should be collected as if it were a `require()` —
/// e.g. `jest.requireActual('foo')` or `vi.importActual('foo')`. Built from a
/// dotted string via [`RequireAlias::parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequireAlias {
    pub object: Option<String>,
    pub method: String,
}

impl RequireAlias {
    pub fn parse(s: &str) -> Self {
        assert!(!s.is_empty(), "Require alias must not be empty");
        let parts: Vec<&str> = s.split('.').collect();
        match parts.as_slice() {
            [method] => RequireAlias {
                object: None,
                method: (*method).to_string(),
            },
            [obj, method] => {
                assert!(
                    !obj.is_empty() && !method.is_empty(),
                    "Require alias '{s}' has empty segments",
                );
                RequireAlias {
                    object: Some((*obj).to_string()),
                    method: (*method).to_string(),
                }
            }
            _ => panic!("Require alias '{s}' must be 'name' or 'object.method'"),
        }
    }
}

pub fn collect_imports(
    source_type: SourceType,
    source_text: &str,
    source_filename: Option<&PathBuf>,
    ignore_type_imports: bool,
    require_aliases: &[RequireAlias],
) -> ImportsReturn {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source_text, source_type).parse();

    let program = parsed.program;

    let mut ast_pass = CollectImports {
        errors: Vec::new(),
        import_paths: HashSet::new(),
        ignore_type_imports,
        require_aliases,
    };
    ast_pass.visit_program(&program);

    let errors = if parsed.errors.is_empty() && ast_pass.errors.is_empty() {
        vec![]
    } else {
        let file_name = if source_filename.is_none() {
            "unknown file"
        } else {
            source_filename
                .unwrap()
                .strip_prefix(env::current_dir().unwrap())
                .unwrap()
                .to_str()
                .unwrap_or_default()
        };
        let source = Arc::new(NamedSource::new(file_name, source_text.to_string()));
        [parsed.errors, ast_pass.errors]
            .concat()
            .into_iter()
            .map(|diagnostic| Error::from(diagnostic).with_source_code(Arc::clone(&source)))
            .map(|error| format!("{error:?}"))
            .collect()
    };

    let ret = ImportsReturn {
        errors,
        imports_paths: ast_pass.import_paths.into_iter().collect(),
    };
    ret
}

fn is_type_only_import(it: &oxc_ast::ast::ImportDeclaration<'_>) -> bool {
    if it.import_kind.is_type() {
        return true;
    }
    let Some(specifiers) = &it.specifiers else {
        return false;
    };
    if specifiers.is_empty() {
        return false;
    }
    specifiers.iter().all(|spec| match spec {
        oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(s) => s.import_kind.is_type(),
        _ => false,
    })
}

fn is_type_only_named_export(it: &oxc_ast::ast::ExportNamedDeclaration<'_>) -> bool {
    if it.export_kind.is_type() {
        return true;
    }
    if it.specifiers.is_empty() {
        return false;
    }
    it.specifiers.iter().all(|spec| spec.export_kind.is_type())
}

struct CollectImports<'b> {
    errors: Vec<OxcDiagnostic>,
    import_paths: HashSet<String>,
    ignore_type_imports: bool,
    require_aliases: &'b [RequireAlias],
}

enum RequireCallMatch<'a> {
    /// Not a require-like call — visitor should leave it alone.
    None,
    /// Require-like call with a valid string-literal argument.
    Path(&'a oxc_ast::ast::StringLiteral<'a>),
    /// Require-like call but the argument shape is wrong.
    InvalidArgs,
}

/// Identifies calls that should be collected as imports: the built-in
/// `require(...)` plus any caller-configured aliases like
/// `jest.requireActual(...)` or `vi.importActual(...)`.
fn match_require_call<'a>(
    call: &'a oxc_ast::ast::CallExpression<'a>,
    aliases: &[RequireAlias],
) -> RequireCallMatch<'a> {
    let matched = match &call.callee {
        oxc_ast::ast::Expression::Identifier(id) => {
            id.name == "require"
                || aliases
                    .iter()
                    .any(|a| a.object.is_none() && a.method == id.name.as_str())
        }
        expr => match expr.as_member_expression() {
            Some(member) => {
                let oxc_ast::ast::Expression::Identifier(obj_id) = member.object() else {
                    return RequireCallMatch::None;
                };
                let Some(prop_name) = member.static_property_name() else {
                    return RequireCallMatch::None;
                };
                aliases.iter().any(|a| {
                    a.object.as_deref() == Some(obj_id.name.as_str()) && a.method == prop_name
                })
            }
            None => false,
        },
    };
    if !matched {
        return RequireCallMatch::None;
    }
    if call.arguments.len() != 1 {
        return RequireCallMatch::InvalidArgs;
    }
    match call.arguments.first() {
        Some(oxc_ast::ast::Argument::StringLiteral(lit)) => RequireCallMatch::Path(lit),
        _ => RequireCallMatch::InvalidArgs,
    }
}

impl<'a, 'b> Visit<'a> for CollectImports<'b> {
    fn visit_import_declaration(&mut self, it: &oxc_ast::ast::ImportDeclaration<'a>) {
        if self.ignore_type_imports && is_type_only_import(it) {
            return;
        }
        self.import_paths.insert(it.source.value.to_string());
        walk::walk_import_declaration(self, it);
    }

    fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'a>) {
        match &it.source {
            oxc_ast::ast::Expression::StringLiteral(literal) => {
                self.import_paths.insert(literal.value.to_string());
            }
            oxc_ast::ast::Expression::TemplateLiteral(literal) => {
                if literal.expressions.len() == 0 {
                    if let Some(first) = literal.quasis.first() {
                        self.import_paths.insert(first.value.raw.to_string());
                    }
                } else {
                    self.errors.push(
                        OxcDiagnostic::error("Import call must not have dynamic template literals")
                            .with_label(it.span),
                    );
                }
            }
            _ => {
                self.errors.push(
                    OxcDiagnostic::error("Import call must not have dynamic template literals")
                        .with_label(it.span),
                );
            }
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_export_named_declaration(&mut self, it: &oxc_ast::ast::ExportNamedDeclaration<'a>) {
        if self.ignore_type_imports && is_type_only_named_export(it) {
            return;
        }
        if let Some(source) = &it.source {
            self.import_paths.insert(source.value.to_string());
        }
        walk::walk_export_named_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &oxc_ast::ast::ExportAllDeclaration<'a>) {
        if self.ignore_type_imports && it.export_kind.is_type() {
            return;
        }
        self.import_paths.insert(it.source.value.to_string());
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_ts_import_type(&mut self, it: &oxc_ast::ast::TSImportType<'a>) {
        if self.ignore_type_imports {
            return;
        }
        self.import_paths.insert(it.source.value.to_string());
        walk::walk_ts_import_type(self, it);
    }

    fn visit_ts_import_equals_declaration(
        &mut self,
        it: &oxc_ast::ast::TSImportEqualsDeclaration<'a>,
    ) {
        if self.ignore_type_imports && it.import_kind.is_type() {
            return;
        }
        if let oxc_ast::ast::TSModuleReference::ExternalModuleReference(ext) = &it.module_reference
        {
            self.import_paths.insert(ext.expression.value.to_string());
        }
        walk::walk_ts_import_equals_declaration(self, it);
    }

    fn visit_call_expression(&mut self, it: &oxc_ast::ast::CallExpression<'a>) {
        match match_require_call(it, &self.require_aliases) {
            RequireCallMatch::None => {}
            RequireCallMatch::Path(literal) => {
                self.import_paths.insert(literal.value.to_string());
            }
            RequireCallMatch::InvalidArgs => {
                self.errors.push(
                    OxcDiagnostic::error("Require call must have a single string literal argument")
                        .with_label(it.span),
                );
            }
        }
        walk::walk_call_expression(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_imports(source_text: &str, expected_imports: Vec<&str>) {
        let ret = collect_imports(SourceType::mjs(), source_text, None, false, &[]);
        // Convert to HashSet to ignore order
        let expected: HashSet<String> =
            HashSet::from_iter(expected_imports.into_iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.imports_paths.into_iter());
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
    }

    fn assert_imports_with_aliases(
        source_text: &str,
        aliases: Vec<&str>,
        expected_imports: Vec<&str>,
    ) {
        let parsed: Vec<RequireAlias> = aliases.iter().map(|s| RequireAlias::parse(s)).collect();
        let ret = collect_imports(SourceType::mjs(), source_text, None, false, &parsed);
        let expected: HashSet<String> =
            HashSet::from_iter(expected_imports.into_iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.imports_paths.into_iter());
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
    }

    fn assert_ts_imports(
        source_text: &str,
        expected_imports: Vec<&str>,
        ignore_type_imports: bool,
    ) {
        let ret = collect_imports(
            SourceType::ts(),
            source_text,
            None,
            ignore_type_imports,
            &[],
        );
        let expected: HashSet<String> =
            HashSet::from_iter(expected_imports.into_iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.imports_paths.into_iter());
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
    }

    fn asset_error(source_text: &str) {
        let ret = collect_imports(SourceType::mjs(), source_text, None, false, &[]);
        assert!(!ret.errors.is_empty());
        assert!(ret.imports_paths.is_empty());
    }

    #[test]
    fn test_import_default() {
        assert_imports("import snel from 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_import_side_effect() {
        assert_imports("import 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_import_named() {
        assert_imports("import { snel } from 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_import_namespace() {
        assert_imports("import * as snel from 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_import_duplicates() {
        assert_imports(
            "import 'snel'; import 'hest'; import 'hest';",
            vec!["snel", "hest"],
        );
    }

    #[test]
    fn test_import_dynamic() {
        assert_imports("import 'snel'; import('hest');", vec!["snel", "hest"]);
    }

    #[test]
    fn test_import_dynamic_template_literal() {
        assert_imports("import(`hest`);", vec!["hest"]);
    }

    #[test]
    fn test_require_literal() {
        assert_imports("require('hest');", vec!["hest"]);
    }

    #[test]
    fn test_export_named() {
        assert_imports("export { snel } from 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_export_namespace() {
        assert_imports("export * as snel from 'hest';", vec!["hest"]);
    }

    #[test]
    fn test_invalid_syntax() {
        asset_error("import snel from 'hest'; const;");
    }

    #[test]
    fn test_empty_require() {
        let ret = collect_imports(
            SourceType::mjs(),
            "require('snel'); require();",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_variable_require() {
        let ret = collect_imports(
            SourceType::mjs(),
            "require('snel'); const path = 'hest'; require(path);",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_variable_import() {
        let ret = collect_imports(
            SourceType::mjs(),
            "import 'snel'; const path = 'hest'; import(path);",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_variable_template_literal_import() {
        let ret = collect_imports(
            SourceType::mjs(),
            "import 'snel'; const path = 'hest'; import(`${path}`);",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_variable_template_literal_require() {
        let ret = collect_imports(
            SourceType::mjs(),
            "const path = 'hest'; require(`${path}`);",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
    }

    #[test]
    fn test_dynamic_import() {
        let ret = collect_imports(
            SourceType::mjs(),
            "import 'snel'; import('he' + 'st');",
            None,
            false,
            &[],
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_ignore_type_import_default_keeps_type_imports() {
        assert_ts_imports("import type { Snel } from 'hest';", vec!["hest"], false);
    }

    #[test]
    fn test_ignore_type_import_drops_type_only_import() {
        assert_ts_imports("import type { Snel } from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_drops_default_type_import() {
        assert_ts_imports("import type Snel from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_keeps_value_imports() {
        assert_ts_imports(
            "import type { Snel } from 'hest'; import { rein } from 'snel';",
            vec!["snel"],
            true,
        );
    }

    #[test]
    fn test_ignore_type_import_keeps_mixed_specifier_import() {
        // Value-bearing specifier (`rein`) means the module still runs at runtime.
        assert_ts_imports(
            "import { type Snel, rein } from 'hest';",
            vec!["hest"],
            true,
        );
    }

    #[test]
    fn test_ignore_type_import_drops_specifier_type_modifier() {
        // `import { type X } from 'foo'` — declaration kind is value, but every
        // specifier is `type`-only, so the source contributes only types.
        assert_ts_imports("import { type Snel } from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_drops_all_specifier_type_modifiers() {
        assert_ts_imports("import { type Snel, type Rein } from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_keeps_side_effect_import() {
        // `import 'foo'` has runtime side effects regardless of types.
        assert_ts_imports("import 'hest';", vec!["hest"], true);
    }

    #[test]
    fn test_ignore_type_import_drops_type_export_named() {
        assert_ts_imports("export type { Snel } from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_drops_specifier_type_export() {
        // `export { type X } from 'foo'` — barrel that re-exports only types.
        assert_ts_imports("export { type Snel } from 'hest';", vec![], true);
    }

    #[test]
    fn test_ignore_type_import_keeps_mixed_specifier_export() {
        assert_ts_imports(
            "export { type Snel, rein } from 'hest';",
            vec!["hest"],
            true,
        );
    }

    #[test]
    fn test_ignore_type_import_drops_type_export_all() {
        assert_ts_imports("export type * from 'hest';", vec![], true);
    }

    #[test]
    fn test_typeof_import_collected_by_default() {
        assert_ts_imports("type Snel = typeof import('hest');", vec!["hest"], false);
    }

    #[test]
    fn test_ignore_type_import_drops_typeof_import() {
        assert_ts_imports("type Snel = typeof import('hest');", vec![], true);
    }

    #[test]
    fn test_ts_import_type_collected_by_default() {
        assert_ts_imports("type Snel = import('hest').Rein;", vec!["hest"], false);
    }

    #[test]
    fn test_ignore_type_import_drops_ts_import_type() {
        assert_ts_imports("type Snel = import('hest').Rein;", vec![], true);
    }

    #[test]
    fn test_import_equals_require() {
        assert_ts_imports("import snel = require('hest');", vec!["hest"], false);
    }

    #[test]
    fn test_ignore_type_import_keeps_value_import_equals() {
        assert_ts_imports("import snel = require('hest');", vec!["hest"], true);
    }

    #[test]
    fn test_ignore_type_import_drops_type_import_equals() {
        assert_ts_imports("import type snel = require('hest');", vec![], true);
    }

    #[test]
    fn test_import_equals_identifier_reference_not_collected() {
        // `import x = Foo.Bar` is a namespace alias, not a module import.
        assert_ts_imports(
            "namespace Foo { export const bar = 1; } import snel = Foo.bar;",
            vec![],
            false,
        );
    }

    // ---- RequireAlias::parse ---------------------------------------------

    #[test]
    fn test_alias_parse_bare() {
        assert_eq!(
            RequireAlias::parse("requireActual"),
            RequireAlias {
                object: None,
                method: "requireActual".to_string(),
            }
        );
    }

    #[test]
    fn test_alias_parse_member() {
        assert_eq!(
            RequireAlias::parse("jest.requireActual"),
            RequireAlias {
                object: Some("jest".to_string()),
                method: "requireActual".to_string(),
            }
        );
    }

    #[test]
    #[should_panic(expected = "must not be empty")]
    fn test_alias_parse_empty_panics() {
        RequireAlias::parse("");
    }

    #[test]
    #[should_panic(expected = "empty segments")]
    fn test_alias_parse_leading_dot_panics() {
        RequireAlias::parse(".foo");
    }

    #[test]
    #[should_panic(expected = "empty segments")]
    fn test_alias_parse_trailing_dot_panics() {
        RequireAlias::parse("foo.");
    }

    #[test]
    #[should_panic(expected = "must be 'name' or 'object.method'")]
    fn test_alias_parse_too_many_segments_panics() {
        RequireAlias::parse("foo.bar.baz");
    }

    // ---- visitor: require-alias matching ----------------------------------

    #[test]
    fn test_alias_member_call_collected() {
        assert_imports_with_aliases(
            "jest.requireActual('hest');",
            vec!["jest.requireActual"],
            vec!["hest"],
        );
    }

    #[test]
    fn test_alias_vi_import_actual() {
        assert_imports_with_aliases(
            "vi.importActual('hest');",
            vec!["vi.importActual"],
            vec!["hest"],
        );
    }

    #[test]
    fn test_alias_bare_identifier_call_collected() {
        assert_imports_with_aliases(
            "requireActual('hest');",
            vec!["requireActual"],
            vec!["hest"],
        );
    }

    #[test]
    fn test_alias_not_collected_when_unconfigured() {
        // No aliases supplied → these are arbitrary calls and ignored.
        assert_imports_with_aliases("jest.requireActual('hest');", vec![], vec![]);
    }

    #[test]
    fn test_alias_member_does_not_match_different_object() {
        assert_imports_with_aliases(
            "other.requireActual('hest');",
            vec!["jest.requireActual"],
            vec![],
        );
    }

    #[test]
    fn test_alias_member_does_not_match_bare_call() {
        // `jest.requireActual` configured shouldn't make plain `requireActual()` count.
        assert_imports_with_aliases("requireActual('hest');", vec!["jest.requireActual"], vec![]);
    }

    #[test]
    fn test_alias_bare_does_not_match_member_call() {
        assert_imports_with_aliases("jest.requireActual('hest');", vec!["requireActual"], vec![]);
    }

    #[test]
    fn test_alias_does_not_match_nested_member_path() {
        // foo.jest.requireActual('hest') — the outer object isn't `jest`.
        assert_imports_with_aliases(
            "foo.jest.requireActual('hest');",
            vec!["jest.requireActual"],
            vec![],
        );
    }

    #[test]
    fn test_alias_multiple_aliases_one_source() {
        assert_imports_with_aliases(
            "jest.requireActual('a'); vi.importActual('b'); requireActual('c');",
            vec!["jest.requireActual", "vi.importActual", "requireActual"],
            vec!["a", "b", "c"],
        );
    }

    #[test]
    fn test_alias_no_arguments_errors() {
        let parsed = vec![RequireAlias::parse("jest.requireActual")];
        let ret = collect_imports(
            SourceType::mjs(),
            "jest.requireActual();",
            None,
            false,
            &parsed,
        );
        assert!(!ret.errors.is_empty());
        assert!(ret.imports_paths.is_empty());
    }

    #[test]
    fn test_alias_variable_argument_errors() {
        let parsed = vec![RequireAlias::parse("jest.requireActual")];
        let ret = collect_imports(
            SourceType::mjs(),
            "const x = 'hest'; jest.requireActual(x);",
            None,
            false,
            &parsed,
        );
        assert!(!ret.errors.is_empty());
        assert!(ret.imports_paths.is_empty());
    }

    #[test]
    fn test_alias_template_literal_argument_errors() {
        // Template literals are not accepted (mirrors require() handling).
        let parsed = vec![RequireAlias::parse("jest.requireActual")];
        let ret = collect_imports(
            SourceType::mjs(),
            "jest.requireActual(`hest`);",
            None,
            false,
            &parsed,
        );
        assert!(!ret.errors.is_empty());
        assert!(ret.imports_paths.is_empty());
    }
}
