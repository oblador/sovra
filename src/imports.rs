use oxc_allocator::Allocator;
use oxc_ast::{visit::walk, Visit};
use oxc_diagnostics::Error;
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::collections::HashSet;

pub struct ImportsReturn {
    pub errors: Vec<Error>,
    pub specifiers: Vec<String>,
}

pub fn collect_imports(source_type: SourceType, source_text: &str) -> ImportsReturn {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source_text, source_type).parse();

    let program = parsed.program;

    let mut ast_pass = CollectImports::default();
    ast_pass.visit_program(&program);

    let ret = ImportsReturn {
        errors: parsed
            .errors
            .into_iter()
            .map(|e| e.with_source_code(source_text.to_owned()))
            .collect(),
        specifiers: ast_pass.import_paths.into_iter().collect(),
    };
    ret
}

#[derive(Debug, Default)]
struct CollectImports {
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
            _ => {}
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_export_named_declaration(&mut self, it: &oxc_ast::ast::ExportNamedDeclaration<'a>) {
        if it.source.is_some() {
            self.import_paths
                .insert(it.source.as_ref().unwrap().value.to_string());
        }
        walk::walk_export_named_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &oxc_ast::ast::ExportAllDeclaration<'a>) {
        self.import_paths.insert(it.source.value.to_string());
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_call_expression(&mut self, it: &oxc_ast::ast::CallExpression<'a>) {
        if it.is_require_call() {
            match it.arguments.first().unwrap() {
                oxc_ast::ast::Argument::StringLiteral(literal) => {
                    self.import_paths.insert(literal.value.to_string());
                }
                _ => {}
            }
        }
        walk::walk_call_expression(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_imports(source_text: &str, expected_imports: Vec<&str>) {
        let ret = collect_imports(SourceType::mjs(), source_text);
        // Convert to HashSet to ignore order
        let expected: HashSet<String> =
            HashSet::from_iter(expected_imports.into_iter().map(|s| s.to_string()));
        let actual: HashSet<String> = HashSet::from_iter(ret.specifiers.into_iter());
        assert_eq!(expected, actual);
        assert!(ret.errors.is_empty());
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
        let ret = collect_imports(SourceType::mjs(), "import snel from 'hest'; const;");
        assert!(!ret.errors.is_empty());
        assert!(ret.specifiers.is_empty());
    }
}
