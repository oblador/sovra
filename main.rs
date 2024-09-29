#![allow(clippy::print_stdout)]

use oxc_resolver::{ResolveOptions, Resolver};

mod affected;
mod imports;

fn main() -> std::io::Result<()> {
    let affected_tests = affected::collect_affected(
        vec!["fixtures/simple/suite.spec.js"],
        vec!["fixtures/simple/module.js"],
        Resolver::new(ResolveOptions::default()),
    );

    println!("{affected_tests:?}");

    Ok(())
}
