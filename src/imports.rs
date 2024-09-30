use oxc_allocator::Allocator;
use oxc_ast::{visit::walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::collections::HashSet;

pub fn collect_imports(source_type: SourceType, source_text: &str) -> HashSet<String> {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, &source_text, source_type).parse();

    for error in ret.errors {
        let error = error.with_source_code(source_text.to_owned());
        println!("{error:?}");
    }

    let program = ret.program;

    let mut ast_pass = CollectImports::default();
    ast_pass.visit_program(&program);

    ast_pass.import_paths
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
        let actual_imports = collect_imports(SourceType::mjs(), source_text);
        assert_eq!(
            actual_imports,
            HashSet::from_iter(
                expected_imports
                    .into_iter()
                    .map(String::from)
                    .collect::<Vec<_>>()
            )
        );
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
}
