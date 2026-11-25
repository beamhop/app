// hog MB: allocates and touches MB mebibytes, then blocks reading stdin forever
// (until EOF). Used for the kill / memory-reclaim test.
use std::io::Read;

fn main() {
    let mb: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(16);
    let mut v = vec![0u8; mb << 20];
    let mut i = 0;
    while i < v.len() {
        v[i] = (i >> 12) as u8 | 1;
        i += 4096;
    }
    std::hint::black_box(&mut v);
    let mut b = [0u8; 1];
    let _ = std::io::stdin().read(&mut b);
    println!("hog done {}", v[4096]);
}
