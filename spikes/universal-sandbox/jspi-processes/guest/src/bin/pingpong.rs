// pingpong init N | pingpong echo
// init: N times { write 1 byte to fd 1; read 1 byte from fd 0 }.
// echo: until EOF { read 1 byte from fd 0; write it to fd 1 }.
// With fd 1 of each wired to fd 0 of the other, every round trip forces exactly two
// blocking reads (two suspend/resume switches).
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_write(fd: u32, iovs: *const Iov, n: u32, nwritten: *mut u32) -> i32;
    fn fd_read(fd: u32, iovs: *const Iov, n: u32, nread: *mut u32) -> i32;
}
#[repr(C)]
struct Iov {
    p: *mut u8,
    l: u32,
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut b = [7u8];
    let iov = Iov { p: b.as_mut_ptr(), l: 1 };
    let mut n = 0u32;
    if a.get(1).map(|s| s.as_str()) == Some("init") {
        let rounds: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);
        for _ in 0..rounds {
            unsafe {
                if fd_write(1, &iov, 1, &mut n) != 0 { std::process::exit(3); }
                if fd_read(0, &iov, 1, &mut n) != 0 || n != 1 { std::process::exit(4); }
            }
        }
    } else {
        loop {
            unsafe {
                if fd_read(0, &iov, 1, &mut n) != 0 { std::process::exit(5); }
                if n == 0 { break; }
                if fd_write(1, &iov, 1, &mut n) != 0 { std::process::exit(6); }
            }
        }
    }
}
