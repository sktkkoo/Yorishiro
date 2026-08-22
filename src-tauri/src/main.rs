// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;

fn main() {
    // The app bundle is not added to PATH yet. Keep this dispatch in the main
    // binary so a future installer can expose `yorishiro` without shipping a
    // second executable.
    match cli::dispatch(std::env::args_os().skip(1)) {
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
