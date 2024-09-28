#![allow(clippy::print_stdout)]
use std::{env, path::Path};

use oxc_span::SourceType;

mod collect;

fn main() -> std::io::Result<()> {
    let name = env::args().nth(1).unwrap_or_else(|| "index.js".to_string());
    let path: &Path = Path::new(&name);
    let source_text: String = std::fs::read_to_string(path)?;
    let source_type: SourceType = SourceType::from_path(path).unwrap();

    let imports = collect::collect_imports(source_type, source_text);

    println!("{imports:?}");

    Ok(())
}
