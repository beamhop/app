// upper: reads stdin line by line, uppercases, writes stdout.
use std::io::{self, BufRead, BufWriter, Write};

fn main() {
    let stdin = io::stdin();
    let mut inp = stdin.lock();
    let stdout = io::stdout();
    let mut out: Box<dyn Write> = if std::env::var("SPIKE_BUF").is_ok() {
        Box::new(BufWriter::with_capacity(65536, stdout.lock()))
    } else {
        Box::new(stdout.lock())
    };
    let mut line = Vec::with_capacity(256);
    loop {
        line.clear();
        let n = inp.read_until(b'\n', &mut line).unwrap();
        if n == 0 {
            break;
        }
        line.make_ascii_uppercase();
        out.write_all(&line).unwrap();
    }
    out.flush().unwrap();
}
