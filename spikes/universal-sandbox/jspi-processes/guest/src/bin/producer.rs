// producer N [sleep_every] [sleep_ms]: prints N fixed-width lines.
// Env SPIKE_BUF=1 switches stdout from Rust's default LineWriter (one fd_write
// per line) to a 64 KiB BufWriter.
use std::io::{self, BufWriter, Write};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n: u64 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let sleep_every: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let sleep_ms: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2);
    let stdout = io::stdout();
    let mut out: Box<dyn Write> = if std::env::var("SPIKE_BUF").is_ok() {
        Box::new(BufWriter::with_capacity(65536, stdout.lock()))
    } else {
        Box::new(stdout.lock())
    };
    for i in 0..n {
        writeln!(out, "line {:07} the quick brown fox jumps over the lazy dog", i).unwrap();
        if sleep_every > 0 && (i + 1) % sleep_every == 0 {
            out.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
        }
    }
    out.flush().unwrap();
}
