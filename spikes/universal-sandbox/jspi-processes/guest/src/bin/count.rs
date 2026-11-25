// count: reads stdin to EOF, prints line count, byte count and FNV-1a32 of the data.
use std::io::{self, Read};

fn main() {
    let stdin = io::stdin();
    let mut inp = stdin.lock();
    let mut buf = vec![0u8; 65536];
    let (mut lines, mut bytes, mut h) = (0u64, 0u64, 0x811c9dc5u32);
    loop {
        let n = inp.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        bytes += n as u64;
        for &b in &buf[..n] {
            if b == b'\n' {
                lines += 1;
            }
            h = (h ^ b as u32).wrapping_mul(0x01000193);
        }
    }
    println!("lines={} bytes={} fnv={:08x}", lines, bytes, h);
}
