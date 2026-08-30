// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;

fn main() {
    // Keep GUI and CLI dispatch in one executable. Preserve argv[0] long enough
    // to distinguish a direct app-bundle launch from a Homebrew/user CLI link.
    let mut args = std::env::args_os();
    let executable = args.next().unwrap_or_default();
    match cli::dispatch(cli::invocation_origin(&executable), args) {
        cli::Dispatch::Gui => yorishiro_lib::run(),
        cli::Dispatch::Cli(result) => match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("yorishiro: {error}");
                std::process::exit(1);
            }
        },
    }
}
