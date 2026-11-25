// crash MODE: reads one chunk from stdin (so it has been suspended at least once
// when stdin is an empty pipe), then misbehaves.
// Modes: trap (unreachable) | panic (Rust panic -> abort) | overflow (unbounded recursion) | oob
use std::io::Read;

#[inline(never)]
fn rec(n: u64) -> u64 {
    if std::hint::black_box(n) == 0 {
        return 0;
    }
    std::hint::black_box(rec(n + 1)) + 1
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "trap".into());
    let mut b = [0u8; 64];
    let n = std::io::stdin().read(&mut b).unwrap();
    eprintln!("crash: read {} bytes, now {}", n, mode);
    match mode.as_str() {
        "trap" => core::arch::wasm32::unreachable(),
        "panic" => panic!("deliberate panic"),
        "overflow" => {
            println!("{}", rec(1));
        }
        "oob" => unsafe {
            let p = 0xffff_fff0usize as *mut u64;
            std::ptr::write_volatile(p, 1);
        },
        _ => {}
    }
}
