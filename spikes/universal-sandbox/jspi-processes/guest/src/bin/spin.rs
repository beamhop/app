// spin MODE N: syscall micro-benchmark. Calls the raw import N times and prints
// "MODE N ELAPSED_NS" (elapsed measured by the guest with clock_time_get(MONOTONIC)).
// Modes: clock | write (1 byte to fd 3) | nop | nop_susp | nop_async | calc | burn
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn clock_time_get(id: u32, precision: u64, time: *mut u64) -> i32;
    fn fd_write(fd: u32, iovs: *const Iov, n: u32, nwritten: *mut u32) -> i32;
}
#[link(wasm_import_module = "spike")]
extern "C" {
    fn nop(x: u32) -> u32; // plain JS import
    fn nop_susp(x: u32) -> u32; // WebAssembly.Suspending import that returns a plain value
    fn nop_async(x: u32) -> u32; // WebAssembly.Suspending import that returns a resolved Promise
}
#[repr(C)]
struct Iov {
    p: *const u8,
    l: u32,
}

fn now() -> u64 {
    let mut t = 0u64;
    unsafe { clock_time_get(1, 0, &mut t) };
    t
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(|s| s.as_str()).unwrap_or("clock");
    let n: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let mut acc = 0u64;
    let t0 = now();
    match mode {
        "clock" => {
            let mut t = 0u64;
            for _ in 0..n {
                unsafe { clock_time_get(1, 0, &mut t) };
                acc = acc.wrapping_add(t);
            }
        }
        "write" => {
            let b = [b'x'];
            let iov = Iov { p: b.as_ptr(), l: 1 };
            let mut nw = 0u32;
            for _ in 0..n {
                unsafe { fd_write(3, &iov, 1, &mut nw) };
                acc += nw as u64;
            }
        }
        "nop" => {
            for i in 0..n {
                acc += unsafe { nop(i as u32) } as u64;
            }
        }
        "nop_susp" => {
            for i in 0..n {
                acc += unsafe { nop_susp(i as u32) } as u64;
            }
        }
        "nop_async" => {
            for i in 0..n {
                acc += unsafe { nop_async(i as u32) } as u64;
            }
        }
        "calc" => {
            for i in 0..n {
                acc = std::hint::black_box(acc.wrapping_mul(6364136223846793005).wrapping_add(i));
            }
        }
        "burn" => loop {
            acc = std::hint::black_box(acc.wrapping_add(1));
        },
        _ => {
            eprintln!("unknown mode {mode}");
            std::process::exit(2);
        }
    }
    let dt = now() - t0;
    println!("{} {} {} {}", mode, n, dt, acc);
}
