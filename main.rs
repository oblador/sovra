#![allow(clippy::print_stdout)]

use oxc_resolver::{ResolveOptions, Resolver};

mod affected;
mod imports;

fn main() -> std::io::Result<()> {
    let affected_tests = affected::collect_affected(
        // vec!["fixtures/require/suite.spec.js"],
        // vec!["fixtures/require/module.js"],
        vec![
            "fixtures/nested/module.spec.js",
            "fixtures/nested/sub-module.spec.js",
        ],
        vec!["fixtures/nested/another-module.js"],
        Resolver::new(ResolveOptions::default()),
    );

    println!("{affected_tests:?}");

    Ok(())
}
