// Keeps the console window away in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    manythreads_desktop_lib::run()
}
