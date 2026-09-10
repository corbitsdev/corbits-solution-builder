//! Runs a dictation session outside the window and prints its events, so the
//! native path can be watched from a terminal: permissions, levels, words,
//! and the end. Usage: cargo run --example dictate [seconds]
use solutions_builder_desktop_lib::dictation;
use std::time::{Duration, Instant};

fn main() {
    let seconds: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let began = Instant::now();
    let running = match dictation::start(Box::new(move |event| {
        println!("{:>6}ms {:?}", began.elapsed().as_millis(), event);
    })) {
        Ok(running) => running,
        Err(reason) => {
            println!("could not start: {reason}");
            std::process::exit(1);
        }
    };
    println!("started; listening for up to {seconds}s");
    std::thread::sleep(Duration::from_secs(seconds));
    running.stop();
    std::thread::sleep(Duration::from_millis(2500));
}
