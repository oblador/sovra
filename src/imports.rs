use oxc::diagnostics::{Error, NamedSource, OxcDiagnostic};
use oxc_allocator::Allocator;
use oxc_ast::{visit::walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::{collections::HashSet, env, path::PathBuf, sync::Arc};

pub struct ImportsReturn {
    pub errors: Vec<String>,
    pub imports_paths: Vec<String>,
}

pub fn collect_imports(
    source_type: SourceType,
    source_text: &str,
    source_filename: Option<&PathBuf>,
) -> ImportsReturn {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source_text, source_type).parse();

    let program = parsed.program;

    let mut ast_pass = CollectImports::default();
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

#[derive(Debug, Default)]
struct CollectImports {
    errors: Vec<OxcDiagnostic>,
    import_paths: HashSet<String>,
}

impl<'a> Visit<'a> for CollectImports {
    fn visit_import_declaration(&mut self, it: &oxc_ast::ast::ImportDeclaration<'a>) {
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
        if let Some(source) = &it.source {
            self.import_paths.insert(source.value.to_string());
        }
        walk::walk_export_named_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &oxc_ast::ast::ExportAllDeclaration<'a>) {
        self.import_paths.insert(it.source.value.to_string());
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_call_expression(&mut self, it: &oxc_ast::ast::CallExpression<'a>) {
        if it.is_require_call() {
            match it.common_js_require() {
                Some(literal) => {
                    self.import_paths.insert(literal.value.to_string());
                }
                None => {
                    self.errors.push(
                        OxcDiagnostic::error("Require call must have a string literal argument")
                            .with_label(it.span),
                    );
                }
            }
        } else if it.callee_name().is_some_and(|n| n == "require") {
            self.errors.push(
                OxcDiagnostic::error("Require call must have a string literal argument")
                    .with_label(it.span),
            );
        }
        walk::walk_call_expression(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_imports(source_text: &str, expected_imports: Vec<&str>) {
        let ret = collect_imports(SourceType::mjs(), source_text, None);
        // Convert to HashSet to ignore order
        let expected: HashSet<String> =
            HashSet::from_iter(expected_imports.into_iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.imports_paths.into_iter());
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
    }

    fn asset_error(source_text: &str) {
        let ret = collect_imports(SourceType::mjs(), source_text, None);
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
        let ret = collect_imports(SourceType::mjs(), "require('snel'); require();", None);
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }

    #[test]
    fn test_variable_require() {
        let ret = collect_imports(
            SourceType::mjs(),
            "require('snel'); const path = 'hest'; require(path);",
            None,
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
        );
        assert!(!ret.errors.is_empty());
    }

    #[test]
    fn test_dynamic_import() {
        let ret = collect_imports(
            SourceType::mjs(),
            "import 'snel'; import('he' + 'st');",
            None,
        );
        assert!(!ret.errors.is_empty());
        assert_eq!(ret.imports_paths, vec!["snel"]);
    }
}
